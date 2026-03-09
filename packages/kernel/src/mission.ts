/**
 * Mission primitive lifecycle operations.
 */

import * as auth from './auth.js';
import * as ledger from './ledger.js';
import * as store from './store.js';
import {
  MISSION_STATUS_TRANSITIONS,
  type Milestone,
  type MilestoneValidationPlan,
  type Mission,
  type MissionPlan,
  type MissionStatus,
  type PrimitiveInstance,
} from './types.js';

export interface CreateMissionOptions {
  mid?: string;
  description?: string;
  priority?: 'urgent' | 'high' | 'medium' | 'low';
  owner?: string;
  project?: string;
  space?: string;
  constraints?: string[];
  tags?: string[];
}

export interface MissionFeaturePlanInput {
  title?: string;
  goal?: string;
  threadPath?: string;
  priority?: 'urgent' | 'high' | 'medium' | 'low';
  deps?: string[];
  tags?: string[];
}

export interface MissionMilestonePlanInput {
  id?: string;
  title: string;
  deps?: string[];
  features: Array<string | MissionFeaturePlanInput>;
  validation?: {
    strategy?: 'automated' | 'manual' | 'hybrid';
    criteria?: string[];
  };
}

export interface PlanMissionInput {
  goal?: string;
  constraints?: string[];
  estimated_runs?: number;
  estimated_cost_usd?: number | null;
  milestones: MissionMilestonePlanInput[];
  replaceMilestones?: boolean;
}

export interface MissionInterventionInput {
  reason: string;
  setPriority?: 'urgent' | 'high' | 'medium' | 'low';
  setStatus?: MissionStatus;
  skipFeature?: {
    milestoneId: string;
    threadPath: string;
  };
  appendMilestones?: MissionMilestonePlanInput[];
}

export interface MissionProgressMilestoneSummary {
  id: string;
  title: string;
  status: string;
  featuresTotal: number;
  featuresDone: number;
}

export interface MissionProgressReport {
  missionPath: string;
  mid: string;
  status: MissionStatus;
  totalMilestones: number;
  passedMilestones: number;
  totalFeatures: number;
  doneFeatures: number;
  percentComplete: number;
  totalRuns: number;
  totalCostUsd: number;
  runsByAdapter: Record<string, number>;
  milestones: MissionProgressMilestoneSummary[];
}

export function createMission(
  workspacePath: string,
  title: string,
  goal: string,
  actor: string,
  options: CreateMissionOptions = {},
): PrimitiveInstance {
  assertMissionMutationAuthorized(workspacePath, actor, 'mission.create', 'missions', [
    'mission:create',
    'mission:manage',
    'policy:manage',
  ]);
  const mid = options.mid ? normalizeSlug(options.mid) : mintMissionId(title);
  const pathOverride = `missions/${mid}.md`;
  const created = store.create(
    workspacePath,
    'mission',
    {
      mid,
      title,
      description: options.description,
      status: 'planning',
      priority: options.priority ?? 'medium',
      owner: options.owner ?? actor,
      project: normalizeOptionalRef(options.project),
      space: normalizeOptionalRef(options.space),
      plan: {
        goal,
        constraints: options.constraints ?? [],
      } satisfies MissionPlan,
      milestones: [],
      total_runs: 0,
      total_cost_usd: 0,
      runs_by_adapter: {},
      tags: options.tags ?? [],
    },
    renderMissionBody({
      goal,
      constraints: options.constraints ?? [],
    }),
    actor,
    {
      pathOverride,
      skipAuthorization: true,
      action: 'mission.create.store',
      requiredCapabilities: ['mission:create', 'mission:manage', 'policy:manage'],
    },
  );
  ledger.append(workspacePath, actor, 'update', created.path, 'mission', {
    mission_event: 'mission-created',
    mid,
  });
  return created;
}

export function planMission(
  workspacePath: string,
  missionRef: string,
  input: PlanMissionInput,
  actor: string,
): PrimitiveInstance {
  assertMissionMutationAuthorized(workspacePath, actor, 'mission.plan', missionRef, [
    'mission:update',
    'mission:manage',
    'thread:create',
    'thread:manage',
  ]);
  const mission = requireMission(workspacePath, missionRef);
  const missionState = asMission(mission);
  if (missionState.status !== 'planning' && missionState.status !== 'approved') {
    throw new Error(`Cannot plan mission in "${missionState.status}" state.`);
  }
  if (!Array.isArray(input.milestones) || input.milestones.length === 0) {
    throw new Error('Mission plan requires at least one milestone.');
  }

  const existingMilestones = indexMilestones(missionState.milestones);
  const nextMilestones = input.milestones.map((milestoneInput, index) =>
    materializeMilestonePlan(
      workspacePath,
      mission,
      milestoneInput,
      index,
      actor,
      existingMilestones.get(normalizeMilestoneId(milestoneInput.id, index)),
    ),
  );
  const mergedMilestones = input.replaceMilestones === false
    ? mergeMilestones(missionState.milestones, nextMilestones)
    : nextMilestones;

  const nextPlan: MissionPlan = {
    goal: input.goal ?? missionState.plan?.goal ?? String(mission.fields.title ?? mission.path),
    constraints: input.constraints ?? missionState.plan?.constraints ?? [],
    estimated_runs: input.estimated_runs ?? missionState.plan?.estimated_runs,
    estimated_cost_usd: input.estimated_cost_usd ?? missionState.plan?.estimated_cost_usd ?? null,
  };
  const safePlan = sanitizeForYaml(nextPlan);
  const safeMilestones = sanitizeForYaml(mergedMilestones);
  const updated = store.update(
    workspacePath,
    mission.path,
    {
      plan: safePlan,
      milestones: safeMilestones,
    },
    renderMissionBody(safePlan, safeMilestones),
    actor,
    {
      skipAuthorization: true,
      action: 'mission.plan.store',
      requiredCapabilities: ['mission:update', 'mission:manage', 'thread:create', 'thread:manage'],
    },
  );
  ledger.append(workspacePath, actor, 'update', mission.path, 'mission', {
    mission_event: 'mission-planned',
    milestone_count: mergedMilestones.length,
    feature_count: mergedMilestones.reduce((sum, milestone) => sum + milestone.features.length, 0),
  });
  return updated;
}

export function approveMission(workspacePath: string, missionRef: string, actor: string): PrimitiveInstance {
  assertMissionMutationAuthorized(workspacePath, actor, 'mission.approve', missionRef, [
    'mission:update',
    'mission:manage',
    'policy:manage',
  ]);
  const mission = requireMission(workspacePath, missionRef);
  const missionState = asMission(mission);
  assertMissionStatusTransition(missionState.status, 'approved');
  if (missionState.milestones.length === 0) {
    throw new Error('Cannot approve mission without planned milestones.');
  }
  const updated = store.update(
    workspacePath,
    mission.path,
    {
      status: 'approved',
      approved_at: new Date().toISOString(),
    },
    undefined,
    actor,
    {
      skipAuthorization: true,
      action: 'mission.approve.store',
      requiredCapabilities: ['mission:update', 'mission:manage', 'policy:manage'],
    },
  );
  ledger.append(workspacePath, actor, 'update', mission.path, 'mission', {
    mission_event: 'mission-approved',
  });
  return updated;
}

export function startMission(workspacePath: string, missionRef: string, actor: string): PrimitiveInstance {
  assertMissionMutationAuthorized(workspacePath, actor, 'mission.start', missionRef, [
    'mission:update',
    'mission:manage',
    'dispatch:run',
  ]);
  const mission = requireMission(workspacePath, missionRef);
  const missionState = asMission(mission);
  assertMissionStatusTransition(missionState.status, 'active');
  if (missionState.milestones.length === 0) {
    throw new Error('Cannot start mission without milestones.');
  }
  const now = new Date().toISOString();
  const nextMilestones = missionState.milestones.map((milestone) => ({ ...milestone }));
  const activeOrValidating = nextMilestones.some((milestone) =>
    milestone.status === 'active' || milestone.status === 'validating',
  );
  if (!activeOrValidating) {
    const firstReady = pickNextReadyMilestone(nextMilestones);
    if (firstReady) {
      firstReady.status = 'active';
      firstReady.started_at = firstReady.started_at ?? now;
    }
  }
  const updated = store.update(
    workspacePath,
    mission.path,
    {
      status: 'active',
      started_at: missionState.started_at ?? now,
      milestones: sanitizeForYaml(nextMilestones),
    },
    renderMissionBody(missionState.plan, nextMilestones),
    actor,
    {
      skipAuthorization: true,
      action: 'mission.start.store',
      requiredCapabilities: ['mission:update', 'mission:manage', 'dispatch:run'],
    },
  );
  ledger.append(workspacePath, actor, 'update', mission.path, 'mission', {
    mission_event: 'mission-started',
  });
  return updated;
}

export function missionStatus(workspacePath: string, missionRef: string): PrimitiveInstance {
  return requireMission(workspacePath, missionRef);
}

export function missionProgress(workspacePath: string, missionRef: string): MissionProgressReport {
  const mission = requireMission(workspacePath, missionRef);
  const missionState = asMission(mission);
  const milestoneSummaries: MissionProgressMilestoneSummary[] = [];
  let totalFeatures = 0;
  let doneFeatures = 0;
  for (const milestone of missionState.milestones) {
    const featureStats = summarizeMilestoneFeatures(workspacePath, milestone);
    totalFeatures += featureStats.total;
    doneFeatures += featureStats.done;
    milestoneSummaries.push({
      id: milestone.id,
      title: milestone.title,
      status: milestone.status,
      featuresTotal: featureStats.total,
      featuresDone: featureStats.done,
    });
  }
  const passedMilestones = missionState.milestones.filter((milestone) => milestone.status === 'passed').length;
  const percentComplete = totalFeatures > 0
    ? Math.round((doneFeatures / totalFeatures) * 100)
    : missionState.status === 'completed'
      ? 100
      : 0;
  return {
    missionPath: mission.path,
    mid: missionState.mid,
    status: missionState.status,
    totalMilestones: missionState.milestones.length,
    passedMilestones,
    totalFeatures,
    doneFeatures,
    percentComplete,
    totalRuns: missionState.total_runs,
    totalCostUsd: missionState.total_cost_usd,
    runsByAdapter: missionState.runs_by_adapter ?? {},
    milestones: milestoneSummaries,
  };
}

export function interveneMission(
  workspacePath: string,
  missionRef: string,
  input: MissionInterventionInput,
  actor: string,
): PrimitiveInstance {
  assertMissionMutationAuthorized(workspacePath, actor, 'mission.intervene', missionRef, [
    'mission:update',
    'mission:manage',
    'thread:update',
    'thread:manage',
  ]);
  const mission = requireMission(workspacePath, missionRef);
  const missionState = asMission(mission);
  const reason = String(input.reason ?? '').trim();
  if (!reason) {
    throw new Error('Mission intervention requires a non-empty reason.');
  }
  const milestones: Milestone[] = missionState.milestones.map(cloneMilestone);
  const skipFeature = input.skipFeature;
  if (skipFeature) {
    const normalizedFeature = normalizeThreadPath(skipFeature.threadPath);
    const milestone = milestones.find((entry) => entry.id === skipFeature.milestoneId);
    if (!milestone) {
      throw new Error(`Milestone not found: ${skipFeature.milestoneId}`);
    }
    milestone.features = milestone.features.filter((threadPath) => normalizeThreadPath(threadPath) !== normalizedFeature);
  }
  if (Array.isArray(input.appendMilestones) && input.appendMilestones.length > 0) {
    const existingById = indexMilestones(milestones);
    for (let index = 0; index < input.appendMilestones.length; index += 1) {
      const appendInput = input.appendMilestones[index]!;
      const id = normalizeMilestoneId(appendInput.id, milestones.length + index);
      if (existingById.has(id)) {
        throw new Error(`Cannot append milestone "${id}" because it already exists.`);
      }
      milestones.push(materializeMilestonePlan(
        workspacePath,
        mission,
        appendInput,
        milestones.length + index,
        actor,
      ));
    }
  }

  const nextStatus = input.setStatus ?? missionState.status;
  if (nextStatus !== missionState.status) {
    assertMissionStatusTransition(missionState.status, nextStatus);
  }
  const updated = store.update(
    workspacePath,
    mission.path,
    {
      ...(input.setPriority ? { priority: input.setPriority } : {}),
      ...(nextStatus !== missionState.status ? { status: nextStatus } : {}),
      milestones: sanitizeForYaml(milestones),
      ...(nextStatus === 'completed' ? { completed_at: new Date().toISOString() } : {}),
    },
    renderMissionBody(missionState.plan, milestones),
    actor,
    {
      skipAuthorization: true,
      action: 'mission.intervene.store',
      requiredCapabilities: ['mission:update', 'mission:manage', 'thread:update', 'thread:manage'],
    },
  );
  ledger.append(workspacePath, actor, 'update', mission.path, 'mission', {
    mission_event: 'mission-intervened',
    reason,
    ...(input.setPriority ? { priority: input.setPriority } : {}),
    ...(input.setStatus ? { status: input.setStatus } : {}),
    ...(input.skipFeature ? { skipped_feature: normalizeThreadPath(input.skipFeature.threadPath) } : {}),
    ...(input.appendMilestones ? { appended_milestones: input.appendMilestones.length } : {}),
  });
  return updated;
}

export function listMissions(workspacePath: string): PrimitiveInstance[] {
  return store.list(workspacePath, 'mission').sort((left, right) =>
    String(right.fields.updated ?? '').localeCompare(String(left.fields.updated ?? '')),
  );
}

export function mintMissionId(title: string): string {
  const slug = normalizeSlug(title);
  return slug || 'mission';
}

function materializeMilestonePlan(
  workspacePath: string,
  mission: PrimitiveInstance,
  milestoneInput: MissionMilestonePlanInput,
  index: number,
  actor: string,
  existing?: Milestone,
): Milestone {
  const milestoneId = normalizeMilestoneId(milestoneInput.id, index);
  const milestoneTitle = String(milestoneInput.title ?? '').trim();
  if (!milestoneTitle) {
    throw new Error(`Milestone ${milestoneId} requires a title.`);
  }
  if (!Array.isArray(milestoneInput.features) || milestoneInput.features.length === 0) {
    throw new Error(`Milestone ${milestoneId} requires at least one feature.`);
  }
  const featureRefs = milestoneInput.features.map((feature, featureIndex) =>
    materializeFeatureThread(workspacePath, mission, feature, milestoneId, featureIndex, actor),
  );
  const validation = normalizeValidationPlan(milestoneInput.validation, existing?.validation);
  return {
    id: milestoneId,
    title: milestoneTitle,
    status: existing?.status ?? 'open',
    deps: dedupeStrings(milestoneInput.deps ?? existing?.deps ?? []),
    features: dedupeStrings(featureRefs),
    ...(validation ? { validation } : {}),
    ...(existing?.started_at ? { started_at: existing.started_at } : {}),
    ...(existing?.completed_at ? { completed_at: existing.completed_at } : {}),
    ...(existing?.failed_at ? { failed_at: existing.failed_at } : {}),
  };
}

function cloneMilestone(milestone: Milestone): Milestone {
  return {
    ...milestone,
    deps: [...(milestone.deps ?? [])],
    features: [...milestone.features],
    ...(milestone.validation ? { validation: { ...milestone.validation } } : {}),
  };
}

function materializeFeatureThread(
  workspacePath: string,
  mission: PrimitiveInstance,
  input: string | MissionFeaturePlanInput,
  milestoneId: string,
  featureIndex: number,
  actor: string,
): string {
  const missionMid = String(mission.fields.mid ?? '').trim();
  const missionPath = mission.path;
  const missionSpace = normalizeOptionalRef(mission.fields.space);
  if (typeof input === 'string') {
    return ensureMissionFeatureThread(
      workspacePath,
      mission,
      {
        title: input,
        goal: `Complete feature "${input}" for milestone ${milestoneId}.`,
      },
      `threads/mission-${missionMid}/${normalizeSlug(input) || `feature-${featureIndex + 1}`}.md`,
      actor,
      missionSpace,
      missionPath,
    );
  }
  const explicitPath = normalizeThreadPath(input.threadPath);
  if (explicitPath) {
    const existing = store.read(workspacePath, explicitPath);
    if (existing) return existing.path;
    if (!input.title) {
      throw new Error(`Feature thread "${explicitPath}" does not exist and no title was provided to create it.`);
    }
  }
  const title = String(input.title ?? '').trim();
  if (!title) {
    throw new Error(`Feature at milestone ${milestoneId} index ${featureIndex + 1} requires a title.`);
  }
  const featurePath = explicitPath || `threads/mission-${missionMid}/${normalizeSlug(title) || `feature-${featureIndex + 1}`}.md`;
  return ensureMissionFeatureThread(
    workspacePath,
    mission,
    input,
    featurePath,
    actor,
    missionSpace,
    missionPath,
  );
}

function ensureMissionFeatureThread(
  workspacePath: string,
  mission: PrimitiveInstance,
  input: MissionFeaturePlanInput,
  featurePath: string,
  actor: string,
  missionSpace: string | undefined,
  missionPath: string,
): string {
  const existing = store.read(workspacePath, featurePath);
  if (existing) return existing.path;
  const title = String(input.title ?? '').trim();
  if (!title) {
    throw new Error(`Cannot create mission feature thread without title (${featurePath}).`);
  }
  const goal = String(input.goal ?? `Complete feature "${title}" for mission ${mission.fields.title}.`).trim();
  const now = new Date().toISOString();
  const feature = store.create(
    workspacePath,
    'thread',
    {
      tid: normalizeSlug(title) || 'feature',
      title,
      goal,
      status: 'open',
      priority: input.priority ?? 'medium',
      deps: dedupeStrings(input.deps ?? []),
      parent: mission.path,
      space: missionSpace,
      context_refs: dedupeStrings([missionPath, ...(missionSpace ? [missionSpace] : [])]),
      participants: [{
        actor: actor.toLowerCase(),
        role: 'owner',
        joined_at: now,
        invited_by: actor.toLowerCase(),
      }],
      tags: dedupeStrings([...(input.tags ?? []), 'mission-feature']),
    },
    `## Goal\n\n${goal}\n`,
    actor,
    {
      pathOverride: featurePath,
      skipAuthorization: true,
      action: 'mission.plan.feature.store',
      requiredCapabilities: ['thread:create', 'thread:manage', 'mission:update', 'mission:manage'],
    },
  );
  ledger.append(workspacePath, actor, 'update', mission.path, 'mission', {
    mission_event: 'mission-feature-created',
    feature_thread: feature.path,
  });
  return feature.path;
}

function summarizeMilestoneFeatures(workspacePath: string, milestone: Milestone): { total: number; done: number } {
  let done = 0;
  for (const threadPath of milestone.features) {
    const thread = store.read(workspacePath, threadPath);
    if (thread && String(thread.fields.status ?? '') === 'done') {
      done += 1;
    }
  }
  return {
    total: milestone.features.length,
    done,
  };
}

function mergeMilestones(existing: Milestone[], next: Milestone[]): Milestone[] {
  const byId = indexMilestones(existing);
  for (const milestone of next) {
    byId.set(milestone.id, milestone);
  }
  return [...byId.values()];
}

function indexMilestones(milestones: Milestone[]): Map<string, Milestone> {
  const map = new Map<string, Milestone>();
  for (const milestone of milestones) {
    map.set(milestone.id, milestone);
  }
  return map;
}

function normalizeValidationPlan(
  input: MissionMilestonePlanInput['validation'],
  existing?: MilestoneValidationPlan,
): MilestoneValidationPlan {
  const strategy = input?.strategy ?? existing?.strategy ?? 'automated';
  return {
    strategy,
    criteria: dedupeStrings(input?.criteria ?? existing?.criteria ?? []),
    ...(existing?.run_id ? { run_id: existing.run_id } : {}),
    ...(existing?.run_status ? { run_status: existing.run_status } : {}),
    ...(existing?.validated_at ? { validated_at: existing.validated_at } : {}),
  };
}

function requireMission(workspacePath: string, missionRef: string): PrimitiveInstance {
  const missionPath = resolveMissionPath(workspacePath, missionRef);
  const mission = store.read(workspacePath, missionPath);
  if (!mission) {
    throw new Error(`Mission not found: ${missionRef}`);
  }
  if (mission.type !== 'mission') {
    throw new Error(`Target is not a mission primitive: ${missionRef}`);
  }
  return mission;
}

function resolveMissionPath(workspacePath: string, missionRef: string): string {
  const normalizedRef = normalizeOptionalRef(missionRef);
  if (!normalizedRef) {
    throw new Error('Mission reference is required.');
  }
  if (normalizedRef.startsWith('missions/')) {
    return normalizedRef;
  }
  const missionPath = `missions/${normalizeSlug(normalizedRef)}.md`;
  if (store.read(workspacePath, missionPath)) {
    return missionPath;
  }
  const foundByMid = store.list(workspacePath, 'mission').find((mission) =>
    String(mission.fields.mid ?? '') === normalizedRef || String(mission.fields.mid ?? '') === normalizeSlug(normalizedRef),
  );
  if (foundByMid) {
    return foundByMid.path;
  }
  return missionPath;
}

function asMission(mission: PrimitiveInstance): Mission {
  const milestones = normalizeMilestones(mission.fields.milestones);
  return {
    mid: String(mission.fields.mid ?? mission.path.split('/').pop()?.replace(/\.md$/, '') ?? 'mission'),
    title: String(mission.fields.title ?? mission.path),
    description: normalizeOptionalString(mission.fields.description),
    status: normalizeMissionStatus(mission.fields.status),
    priority: normalizePriority(mission.fields.priority),
    owner: normalizeOptionalString(mission.fields.owner),
    project: normalizeOptionalRef(mission.fields.project),
    space: normalizeOptionalRef(mission.fields.space),
    plan: normalizeMissionPlan(mission.fields.plan),
    milestones,
    started_at: normalizeOptionalString(mission.fields.started_at),
    completed_at: normalizeOptionalString(mission.fields.completed_at),
    total_runs: asFiniteNumber(mission.fields.total_runs, 0),
    total_cost_usd: asFiniteNumber(mission.fields.total_cost_usd, 0),
    runs_by_adapter: asStringNumberRecord(mission.fields.runs_by_adapter),
    tags: asStringArray(mission.fields.tags),
    created: normalizeOptionalString(mission.fields.created) ?? new Date(0).toISOString(),
    updated: normalizeOptionalString(mission.fields.updated) ?? new Date(0).toISOString(),
  };
}

function normalizeMissionPlan(value: unknown): MissionPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { goal: '' };
  }
  const record = value as Record<string, unknown>;
  return {
    goal: String(record.goal ?? ''),
    constraints: asStringArray(record.constraints),
    estimated_runs: asFiniteNumber(record.estimated_runs, undefined),
    estimated_cost_usd: asNullableFiniteNumber(record.estimated_cost_usd, null),
  };
}

function normalizeMilestones(value: unknown): Milestone[] {
  if (!Array.isArray(value)) return [];
  const milestones: Milestone[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const rawMilestone = value[index];
    if (!rawMilestone || typeof rawMilestone !== 'object' || Array.isArray(rawMilestone)) continue;
    const record = rawMilestone as Record<string, unknown>;
    const id = normalizeMilestoneId(asOptionalString(record.id), index);
    const title = asOptionalString(record.title) ?? id;
    const features = dedupeStrings(asStringArray(record.features).map((entry) => normalizeThreadPath(entry)));
    const status = normalizeMilestoneStatus(record.status);
    const validation = normalizeExistingValidation(record.validation);
    milestones.push({
      id,
      title,
      status,
      deps: dedupeStrings(asStringArray(record.deps)),
      features,
      ...(validation ? { validation } : {}),
      ...(asOptionalString(record.started_at) ? { started_at: asOptionalString(record.started_at) } : {}),
      ...(asOptionalString(record.completed_at) ? { completed_at: asOptionalString(record.completed_at) } : {}),
      ...(asOptionalString(record.failed_at) ? { failed_at: asOptionalString(record.failed_at) } : {}),
    });
  }
  return milestones;
}

function normalizeExistingValidation(value: unknown): MilestoneValidationPlan | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    strategy: normalizeValidationStrategy(record.strategy),
    criteria: asStringArray(record.criteria),
    ...(asOptionalString(record.run_id) ? { run_id: asOptionalString(record.run_id) } : {}),
    ...(asOptionalString(record.run_status) ? { run_status: asOptionalString(record.run_status) as MilestoneValidationPlan['run_status'] } : {}),
    ...(asOptionalString(record.validated_at) ? { validated_at: asOptionalString(record.validated_at) } : {}),
  };
}

function normalizeMilestoneStatus(value: unknown): Milestone['status'] {
  const normalized = String(value ?? 'open').trim().toLowerCase();
  if (
    normalized === 'open' ||
    normalized === 'active' ||
    normalized === 'validating' ||
    normalized === 'passed' ||
    normalized === 'failed'
  ) {
    return normalized;
  }
  return 'open';
}

function normalizeMissionStatus(value: unknown): MissionStatus {
  const normalized = String(value ?? 'planning').trim().toLowerCase();
  if (
    normalized === 'planning' ||
    normalized === 'approved' ||
    normalized === 'active' ||
    normalized === 'validating' ||
    normalized === 'completed' ||
    normalized === 'failed'
  ) {
    return normalized;
  }
  return 'planning';
}

function normalizeValidationStrategy(value: unknown): MilestoneValidationPlan['strategy'] {
  const normalized = String(value ?? 'automated').trim().toLowerCase();
  if (normalized === 'manual' || normalized === 'hybrid' || normalized === 'automated') {
    return normalized;
  }
  return 'automated';
}

function normalizePriority(value: unknown): Mission['priority'] {
  const normalized = String(value ?? 'medium').trim().toLowerCase();
  if (normalized === 'urgent' || normalized === 'high' || normalized === 'medium' || normalized === 'low') {
    return normalized;
  }
  return 'medium';
}

function normalizeMilestoneId(id: string | undefined, index: number): string {
  const normalized = normalizeSlug(id ?? '');
  if (normalized) return normalized;
  return `ms-${index + 1}`;
}

function normalizeThreadPath(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const unwrapped = raw.startsWith('[[') && raw.endsWith(']]') ? raw.slice(2, -2) : raw;
  const withPrefix = unwrapped.includes('/') ? unwrapped : `threads/${unwrapped}`;
  return withPrefix.endsWith('.md') ? withPrefix : `${withPrefix}.md`;
}

function normalizeOptionalRef(value: unknown): string | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  const unwrapped = raw.startsWith('[[') && raw.endsWith(']]') ? raw.slice(2, -2) : raw;
  return unwrapped.endsWith('.md') ? unwrapped : `${unwrapped}.md`;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return normalizeOptionalString(value);
}

function asFiniteNumber(value: unknown, fallback: number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback ?? 0;
}

function asNullableFiniteNumber(value: unknown, fallback: number | null): number | null {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean);
}

function asStringNumberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const output: Record<string, number> = {};
  for (const [key, rawValue] of Object.entries(record)) {
    const numeric = asFiniteNumber(rawValue, 0);
    output[key] = numeric;
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

function assertMissionStatusTransition(from: MissionStatus, to: MissionStatus): void {
  if (from === to) return;
  const allowed = MISSION_STATUS_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid mission transition: "${from}" -> "${to}". Allowed: ${allowed.join(', ') || 'none'}`);
  }
}

function pickNextReadyMilestone(milestones: Milestone[]): Milestone | undefined {
  return milestones.find((milestone) => {
    if (milestone.status !== 'open') return false;
    const deps = milestone.deps ?? [];
    return deps.every((depId) => milestones.some((candidate) => candidate.id === depId && candidate.status === 'passed'));
  });
}

function renderMissionBody(plan?: MissionPlan, milestones: Milestone[] = []): string {
  const lines: string[] = [];
  const goal = plan?.goal?.trim();
  lines.push('## Goal');
  lines.push('');
  lines.push(goal && goal.length > 0 ? goal : 'TBD');
  lines.push('');
  if (plan?.constraints && plan.constraints.length > 0) {
    lines.push('## Constraints');
    lines.push('');
    for (const constraint of plan.constraints) {
      lines.push(`- ${constraint}`);
    }
    lines.push('');
  }
  if (milestones.length > 0) {
    lines.push('## Milestones');
    lines.push('');
    for (const milestone of milestones) {
      lines.push(`### ${milestone.id}: ${milestone.title}`);
      lines.push('');
      lines.push(`status: ${milestone.status}`);
      if (milestone.deps && milestone.deps.length > 0) {
        lines.push(`deps: ${milestone.deps.join(', ')}`);
      }
      if (milestone.validation && milestone.validation.criteria.length > 0) {
        lines.push(`validation: ${milestone.validation.strategy}`);
        lines.push(...milestone.validation.criteria.map((criterion) => `- ${criterion}`));
      }
      if (milestone.features.length > 0) {
        lines.push('features:');
        lines.push(...milestone.features.map((featurePath) => `- [[${featurePath}]]`));
      }
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
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

function assertMissionMutationAuthorized(
  workspacePath: string,
  actor: string,
  action: string,
  target: string,
  requiredCapabilities: string[],
): void {
  auth.assertAuthorizedMutation(workspacePath, {
    actor,
    action,
    target,
    requiredCapabilities,
    metadata: {
      module: 'mission',
    },
  });
}
