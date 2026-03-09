/**
 * Mission orchestrator — sequential milestone dispatch and validation.
 */

import * as dispatch from './dispatch.js';
import * as ledger from './ledger.js';
import * as mission from './mission.js';
import * as store from './store.js';
import type {
  Milestone,
  MilestoneValidationPlan,
  Mission,
  MissionStatus,
  PrimitiveInstance,
} from './types.js';

export interface MissionOrchestratorCycleResult {
  missionPath: string;
  missionStatus: MissionStatus;
  actions: string[];
  dispatchedRuns: string[];
  validationRunId?: string;
  changed: boolean;
}

export function runMissionOrchestratorCycle(
  workspacePath: string,
  missionRef: string,
  actor: string = 'mission-orchestrator',
): MissionOrchestratorCycleResult {
  const missionInstance = mission.missionStatus(workspacePath, missionRef);
  const state = asMission(missionInstance);
  const milestones = state.milestones.map(cloneMilestone);
  const now = new Date().toISOString();
  const actions: string[] = [];
  const dispatchedRuns: string[] = [];
  let changed = false;
  let validationRunId: string | undefined;

  if (state.status !== 'active' && state.status !== 'validating') {
    return {
      missionPath: missionInstance.path,
      missionStatus: state.status,
      actions: ['skipped:mission-not-active'],
      dispatchedRuns,
      changed: false,
    };
  }

  if (state.status === 'active') {
    let activeMilestone = milestones.find((milestone) => milestone.status === 'active');
    if (!activeMilestone) {
      const next = pickNextReadyMilestone(milestones);
      if (next) {
        next.status = 'active';
        next.started_at = next.started_at ?? now;
        activeMilestone = next;
        actions.push(`milestone-activated:${next.id}`);
        appendMissionEvent(workspacePath, actor, missionInstance.path, 'mission-milestone-activated', {
          milestone_id: next.id,
        });
        changed = true;
      }
    }

    if (activeMilestone) {
      for (const featurePath of activeMilestone.features) {
        const featureThread = store.read(workspacePath, featurePath);
        if (!featureThread || featureThread.type !== 'thread') continue;
        const featureStatus = String(featureThread.fields.status ?? '');
        if (featureStatus !== 'open') continue;
        const adapter = pickAdapterForFeature(featureThread);
        if (!shouldDispatchFeatureRun(workspacePath, featureThread)) continue;
        const run = dispatch.createRun(workspacePath, {
          actor,
          adapter,
          objective: `Mission ${state.mid} / ${activeMilestone.title}: ${String(featureThread.fields.title ?? featureThread.path)}`,
          context: {
            missionId: state.mid,
            missionPath: missionInstance.path,
            milestoneId: activeMilestone.id,
            featureThread: featureThread.path,
          },
        });
        dispatchedRuns.push(run.id);
        actions.push(`feature-dispatched:${featureThread.path}`);
        incrementMissionRunStats(state, run.adapter);
        changed = true;
        appendMissionEvent(workspacePath, actor, missionInstance.path, 'mission-feature-dispatched', {
          milestone_id: activeMilestone.id,
          feature_thread: featureThread.path,
          run_id: run.id,
          adapter: run.adapter,
        });
        store.update(
          workspacePath,
          featureThread.path,
          {
            mission_dispatch_last_run_id: run.id,
            mission_dispatch_last_adapter: run.adapter,
            mission_dispatch_last_at: now,
          },
          undefined,
          actor,
          {
            skipAuthorization: true,
            action: 'mission.orchestrator.feature.store',
            requiredCapabilities: ['thread:update', 'thread:manage', 'dispatch:run', 'mission:manage'],
          },
        );
      }

      if (areMilestoneFeaturesDone(workspacePath, activeMilestone)) {
        activeMilestone.status = 'validating';
        activeMilestone.validation = ensureMilestoneValidation(activeMilestone.validation);
        state.status = 'validating';
        actions.push(`milestone-validating:${activeMilestone.id}`);
        appendMissionEvent(workspacePath, actor, missionInstance.path, 'mission-milestone-validating', {
          milestone_id: activeMilestone.id,
        });
        const run = ensureValidationDispatch(
          workspacePath,
          missionInstance,
          state,
          activeMilestone,
          actor,
        );
        validationRunId = run.id;
        changed = true;
      }
    } else if (milestones.every((milestone) => milestone.status === 'passed')) {
      state.status = 'completed';
      state.completed_at = state.completed_at ?? now;
      actions.push('mission-completed');
      appendMissionEvent(workspacePath, actor, missionInstance.path, 'mission-completed', {});
      changed = true;
    }
  }

  if (state.status === 'validating') {
    const validatingMilestone = milestones.find((milestone) => milestone.status === 'validating');
    if (!validatingMilestone) {
      state.status = 'active';
      changed = true;
      actions.push('no-validating-milestone-reset-to-active');
    } else {
      validatingMilestone.validation = ensureMilestoneValidation(validatingMilestone.validation);
      if (!validatingMilestone.validation.run_id) {
        const run = ensureValidationDispatch(workspacePath, missionInstance, state, validatingMilestone, actor);
        validationRunId = run.id;
        changed = true;
      } else {
        const validationRun = dispatch.status(workspacePath, validatingMilestone.validation.run_id);
        validatingMilestone.validation.run_status = validationRun.status;
        validationRunId = validationRun.id;
        changed = true;
        if (validationRun.status === 'succeeded') {
          validatingMilestone.status = 'passed';
          validatingMilestone.completed_at = now;
          validatingMilestone.validation.validated_at = now;
          state.status = 'active';
          actions.push(`milestone-passed:${validatingMilestone.id}`);
          appendMissionEvent(workspacePath, actor, missionInstance.path, 'mission-milestone-complete', {
            milestone_id: validatingMilestone.id,
            run_id: validationRun.id,
          });
          const nextMilestone = pickNextReadyMilestone(milestones);
          if (nextMilestone) {
            nextMilestone.status = 'active';
            nextMilestone.started_at = nextMilestone.started_at ?? now;
            actions.push(`milestone-activated:${nextMilestone.id}`);
          } else if (milestones.every((milestone) => milestone.status === 'passed')) {
            state.status = 'completed';
            state.completed_at = state.completed_at ?? now;
            actions.push('mission-completed');
            appendMissionEvent(workspacePath, actor, missionInstance.path, 'mission-completed', {});
          }
        } else if (validationRun.status === 'failed' || validationRun.status === 'cancelled') {
          validatingMilestone.status = 'failed';
          validatingMilestone.failed_at = now;
          state.status = 'failed';
          actions.push(`milestone-failed:${validatingMilestone.id}`);
          const fixThread = createValidationFixThread(workspacePath, missionInstance, validatingMilestone, actor);
          actions.push(`fix-thread-created:${fixThread.path}`);
          appendMissionEvent(workspacePath, actor, missionInstance.path, 'mission-validation-failed', {
            milestone_id: validatingMilestone.id,
            run_id: validationRun.id,
            fix_thread: fixThread.path,
          });
        }
      }
    }
  }

  if (changed) {
    store.update(
      workspacePath,
      missionInstance.path,
      {
        status: state.status,
        milestones: sanitizeForYaml(milestones),
        total_runs: state.total_runs,
        total_cost_usd: state.total_cost_usd,
        runs_by_adapter: sanitizeForYaml(state.runs_by_adapter),
        ...(state.completed_at ? { completed_at: state.completed_at } : {}),
      },
      undefined,
      actor,
      {
        skipAuthorization: true,
        action: 'mission.orchestrator.store',
        requiredCapabilities: ['mission:update', 'mission:manage', 'dispatch:run'],
      },
    );
  }

  return {
    missionPath: missionInstance.path,
    missionStatus: state.status,
    actions,
    dispatchedRuns,
    validationRunId,
    changed,
  };
}

export function runMissionOrchestratorForActiveMissions(
  workspacePath: string,
  actor: string = 'mission-orchestrator',
): MissionOrchestratorCycleResult[] {
  return mission
    .listMissions(workspacePath)
    .filter((entry) => {
      const status = String(entry.fields.status ?? '');
      return status === 'active' || status === 'validating';
    })
    .map((entry) => runMissionOrchestratorCycle(workspacePath, entry.path, actor));
}

function shouldDispatchFeatureRun(workspacePath: string, featureThread: PrimitiveInstance): boolean {
  const previousRunId = asOptionalString(featureThread.fields.mission_dispatch_last_run_id);
  if (!previousRunId) return true;
  try {
    const previousRun = dispatch.status(workspacePath, previousRunId);
    return previousRun.status === 'failed' || previousRun.status === 'cancelled';
  } catch {
    return true;
  }
}

function ensureValidationDispatch(
  workspacePath: string,
  missionInstance: PrimitiveInstance,
  missionState: Mission,
  milestone: Milestone,
  actor: string,
) {
  milestone.validation = ensureMilestoneValidation(milestone.validation);
  const run = dispatch.createRun(workspacePath, {
    actor,
    adapter: 'cursor-cloud',
    objective: `Validate milestone "${milestone.title}": ${milestone.validation.criteria.join('; ') || 'No explicit criteria provided.'}`,
    context: {
      missionId: missionState.mid,
      missionPath: missionInstance.path,
      milestoneId: milestone.id,
      isValidation: true,
    },
  });
  milestone.validation.run_id = run.id;
  milestone.validation.run_status = run.status;
  incrementMissionRunStats(missionState, run.adapter);
  appendMissionEvent(workspacePath, actor, missionInstance.path, 'mission-validation-dispatched', {
    milestone_id: milestone.id,
    run_id: run.id,
  });
  return run;
}

function createValidationFixThread(
  workspacePath: string,
  missionInstance: PrimitiveInstance,
  milestone: Milestone,
  actor: string,
): PrimitiveInstance {
  const missionId = String(missionInstance.fields.mid ?? 'mission');
  const fixSlug = `${normalizeSlug(milestone.id)}-validation-fix`;
  const pathOverride = `threads/mission-${missionId}/fix-${fixSlug}.md`;
  const existing = store.read(workspacePath, pathOverride);
  if (existing) return existing;
  return store.create(
    workspacePath,
    'thread',
    {
      tid: `fix-${normalizeSlug(milestone.id)}`,
      title: `Fix validation failures: ${milestone.title}`,
      goal: `Resolve validation failures for milestone "${milestone.title}" in mission ${missionInstance.path}.`,
      status: 'open',
      priority: 'high',
      deps: [],
      parent: missionInstance.path,
      context_refs: [missionInstance.path],
      tags: ['fix', 'validation-failure', 'mission-feature'],
    },
    `## Goal\n\nResolve failing validation outcomes for milestone "${milestone.title}".\n`,
    actor,
    {
      pathOverride,
      skipAuthorization: true,
      action: 'mission.orchestrator.fix-thread.store',
      requiredCapabilities: ['thread:create', 'thread:manage', 'mission:manage'],
    },
  );
}

function pickAdapterForFeature(featureThread: PrimitiveInstance): string {
  const tags = asStringArray(featureThread.fields.tags).map((tag) => tag.toLowerCase());
  if (tags.includes('claude-code') || tags.includes('claude')) return 'claude-code';
  if (tags.includes('manual')) return 'manual';
  if (tags.includes('cursor') || tags.includes('cursor-cloud')) return 'cursor-cloud';
  return 'cursor-cloud';
}

function areMilestoneFeaturesDone(workspacePath: string, milestone: Milestone): boolean {
  if (milestone.features.length === 0) return false;
  return milestone.features.every((threadPath) => {
    const thread = store.read(workspacePath, threadPath);
    return !!thread && String(thread.fields.status ?? '') === 'done';
  });
}

function pickNextReadyMilestone(milestones: Milestone[]): Milestone | undefined {
  return milestones.find((milestone) => {
    if (milestone.status !== 'open') return false;
    const deps = milestone.deps ?? [];
    return deps.every((depId) => milestones.some((candidate) => candidate.id === depId && candidate.status === 'passed'));
  });
}

function incrementMissionRunStats(state: Mission, adapter: string): void {
  state.total_runs = (state.total_runs ?? 0) + 1;
  state.runs_by_adapter = state.runs_by_adapter ?? {};
  state.runs_by_adapter[adapter] = (state.runs_by_adapter[adapter] ?? 0) + 1;
}

function ensureMilestoneValidation(validation: MilestoneValidationPlan | undefined): MilestoneValidationPlan {
  return {
    strategy: validation?.strategy ?? 'automated',
    criteria: validation?.criteria ?? [],
    ...(validation?.run_id ? { run_id: validation.run_id } : {}),
    ...(validation?.run_status ? { run_status: validation.run_status } : {}),
    ...(validation?.validated_at ? { validated_at: validation.validated_at } : {}),
  };
}

function appendMissionEvent(
  workspacePath: string,
  actor: string,
  missionPath: string,
  eventType: string,
  details: Record<string, unknown>,
): void {
  ledger.append(workspacePath, actor, 'update', missionPath, 'mission', {
    mission_event: eventType,
    ...details,
  });
}

function asMission(instance: PrimitiveInstance): Mission {
  const milestones = normalizeMilestones(instance.fields.milestones);
  return {
    mid: String(instance.fields.mid ?? instance.path),
    title: String(instance.fields.title ?? instance.path),
    description: asOptionalString(instance.fields.description),
    status: normalizeMissionStatus(instance.fields.status),
    priority: normalizePriority(instance.fields.priority),
    owner: asOptionalString(instance.fields.owner),
    project: asOptionalString(instance.fields.project),
    space: asOptionalString(instance.fields.space),
    plan: {
      goal: asOptionalString((instance.fields.plan as Record<string, unknown> | undefined)?.goal) ?? '',
      constraints: asStringArray((instance.fields.plan as Record<string, unknown> | undefined)?.constraints),
      estimated_runs: asNumber((instance.fields.plan as Record<string, unknown> | undefined)?.estimated_runs),
      estimated_cost_usd: asNullableNumber((instance.fields.plan as Record<string, unknown> | undefined)?.estimated_cost_usd),
    },
    milestones,
    started_at: asOptionalString(instance.fields.started_at),
    completed_at: asOptionalString(instance.fields.completed_at),
    total_runs: asNumber(instance.fields.total_runs) ?? 0,
    total_cost_usd: asNumber(instance.fields.total_cost_usd) ?? 0,
    runs_by_adapter: asStringNumberRecord(instance.fields.runs_by_adapter),
    tags: asStringArray(instance.fields.tags),
    created: asOptionalString(instance.fields.created) ?? new Date(0).toISOString(),
    updated: asOptionalString(instance.fields.updated) ?? new Date(0).toISOString(),
  };
}

function normalizeMilestones(value: unknown): Milestone[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) => normalizeMilestone(entry, index))
    .filter((entry): entry is Milestone => !!entry);
}

function normalizeMilestone(value: unknown, index: number): Milestone | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = asOptionalString(record.id) ?? `ms-${index + 1}`;
  const title = asOptionalString(record.title) ?? id;
  return {
    id,
    title,
    status: normalizeMilestoneStatus(record.status),
    deps: dedupeStrings(asStringArray(record.deps)),
    features: dedupeStrings(asStringArray(record.features)),
    validation: normalizeValidation(record.validation),
    ...(asOptionalString(record.started_at) ? { started_at: asOptionalString(record.started_at) } : {}),
    ...(asOptionalString(record.completed_at) ? { completed_at: asOptionalString(record.completed_at) } : {}),
    ...(asOptionalString(record.failed_at) ? { failed_at: asOptionalString(record.failed_at) } : {}),
  };
}

function normalizeValidation(value: unknown): MilestoneValidationPlan | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    strategy: normalizeValidationStrategy(record.strategy),
    criteria: asStringArray(record.criteria),
    ...(asOptionalString(record.run_id) ? { run_id: asOptionalString(record.run_id) } : {}),
    ...(asOptionalString(record.run_status)
      ? { run_status: asOptionalString(record.run_status) as MilestoneValidationPlan['run_status'] }
      : {}),
    ...(asOptionalString(record.validated_at) ? { validated_at: asOptionalString(record.validated_at) } : {}),
  };
}

function sanitizeForYaml<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeForYaml(entry))
      .filter((entry) => entry !== undefined) as unknown as T;
  }
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, innerValue] of Object.entries(value as Record<string, unknown>)) {
    if (innerValue === undefined) continue;
    const sanitized = sanitizeForYaml(innerValue);
    if (sanitized === undefined) continue;
    output[key] = sanitized;
  }
  return output as T;
}

function cloneMilestone(milestone: Milestone): Milestone {
  return {
    ...milestone,
    deps: [...(milestone.deps ?? [])],
    features: [...milestone.features],
    validation: milestone.validation ? { ...milestone.validation } : undefined,
  };
}

function normalizeMissionStatus(value: unknown): MissionStatus {
  const normalized = String(value ?? 'planning').trim().toLowerCase();
  if (
    normalized === 'planning'
    || normalized === 'approved'
    || normalized === 'active'
    || normalized === 'validating'
    || normalized === 'completed'
    || normalized === 'failed'
  ) {
    return normalized;
  }
  return 'planning';
}

function normalizeMilestoneStatus(value: unknown): Milestone['status'] {
  const normalized = String(value ?? 'open').trim().toLowerCase();
  if (
    normalized === 'open'
    || normalized === 'active'
    || normalized === 'validating'
    || normalized === 'passed'
    || normalized === 'failed'
  ) {
    return normalized;
  }
  return 'open';
}

function normalizePriority(value: unknown): Mission['priority'] {
  const normalized = String(value ?? 'medium').trim().toLowerCase();
  if (normalized === 'urgent' || normalized === 'high' || normalized === 'medium' || normalized === 'low') {
    return normalized;
  }
  return 'medium';
}

function normalizeValidationStrategy(value: unknown): MilestoneValidationPlan['strategy'] {
  const normalized = String(value ?? 'automated').trim().toLowerCase();
  if (normalized === 'automated' || normalized === 'manual' || normalized === 'hybrid') {
    return normalized;
  }
  return 'automated';
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asOptionalString(entry))
    .filter((entry): entry is string => !!entry);
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asNullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return asNumber(value);
}

function asStringNumberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: Record<string, number> = {};
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    output[key] = asNumber(rawValue) ?? 0;
  }
  return output;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeSlug(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
