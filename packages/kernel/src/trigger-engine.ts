/**
 * Trigger polling engine, cascade evaluator, and dashboard/status helpers.
 */

import path from 'node:path';
import fs from './storage-fs.js';
import { spawnSync } from 'node:child_process';
import * as dispatch from './dispatch.js';
import * as ledger from './ledger.js';
import * as store from './store.js';
import { matchesCronSchedule, nextCronMatch, parseCronExpression, type CronSchedule } from './cron.js';
import type { DispatchRun, PrimitiveInstance } from './types.js';

const TRIGGER_STATE_FILE = '.workgraph/trigger-state.json';
const TRIGGER_STATE_VERSION = 1;
const DEFAULT_ENGINE_INTERVAL_SECONDS = 60;
const DEFAULT_SHELL_TIMEOUT_MS = 30_000;

type TriggerRuntimeStatus = 'ready' | 'cooldown' | 'inactive' | 'error';

interface TriggerRuntimeState {
  fireCount: number;
  lastEvaluatedAt?: string;
  lastFiredAt?: string;
  cooldownUntil?: string;
  lastError?: string;
  state?: TriggerRuntimeStatus;
  lastResult?: Record<string, unknown>;
  lastEventCursorTs?: string;
  lastEventCursorHash?: string;
  lastEventCursorOffset?: number;
  lastFileScanTs?: string;
  lastCronBucket?: string;
  synthesisCursorTs?: string;
}

interface TriggerStateData {
  version: number;
  updatedAt: string;
  engine: {
    cycleCount: number;
    lastCycleAt?: string;
    intervalSeconds: number;
    lastError?: string;
  };
  triggers: Record<string, TriggerRuntimeState>;
}

type TriggerCondition =
  | {
      type: 'cron';
      expression: string;
      schedule: CronSchedule;
    }
  | {
      type: 'event';
      eventType: string;
    }
  | {
      type: 'file-watch';
      glob: string;
    }
  | {
      type: 'thread-complete';
      threadPath?: string;
    };

type TriggerAction =
  | {
      type: 'create-thread';
      title?: string;
      goal?: string;
      body?: string;
      priority?: string;
      deps?: string[];
      parent?: string;
      space?: string;
      context_refs?: string[];
      tags?: string[];
      actor?: string;
    }
  | {
      type: 'dispatch-run';
      objective?: string;
      adapter?: string;
      context?: Record<string, unknown>;
      actor?: string;
    }
  | {
      type: 'update-primitive';
      path: string;
      fields?: Record<string, unknown>;
      body?: string;
      actor?: string;
    }
  | {
      type: 'shell';
      command: string;
      timeoutMs?: number;
      actor?: string;
    };

interface SynthesisConfig {
  tagPattern: string;
  threshold: number;
  actor?: string;
}

interface NormalizedTrigger {
  instance: PrimitiveInstance;
  path: string;
  title: string;
  status: string;
  cooldownSeconds: number;
  condition: TriggerCondition | null;
  action: TriggerAction | null;
  cascadeOn: string[];
  synthesis: SynthesisConfig | null;
}

interface TriggerConditionDecision {
  matched: boolean;
  reason: string;
  eventKey?: string;
  context?: Record<string, unknown>;
}

export interface TriggerEngineCycleTriggerResult {
  triggerPath: string;
  fired: boolean;
  reason: string;
  actionType?: string;
  runtimeState: TriggerRuntimeStatus;
  error?: string;
}

export interface TriggerEngineCycleResult {
  cycleAt: string;
  evaluated: number;
  fired: number;
  errors: number;
  triggers: TriggerEngineCycleTriggerResult[];
  statePath: string;
}

export interface TriggerEngineCycleOptions {
  actor?: string;
  now?: Date;
  intervalSeconds?: number;
}

export interface StartTriggerEngineOptions {
  actor?: string;
  intervalSeconds?: number;
  maxCycles?: number;
  logger?: (line: string) => void;
  executeRuns?: boolean;
  execution?: Omit<dispatch.DispatchExecuteInput, 'actor'>;
  retryFailedRuns?: boolean;
}

export interface TriggerDashboardItem {
  path: string;
  title: string;
  status: string;
  condition: string;
  action: string;
  cooldownSeconds: number;
  fireCount: number;
  lastFiredAt?: string;
  nextFireAt?: string;
  currentState: TriggerRuntimeStatus;
  lastError?: string;
}

export interface TriggerDashboard {
  generatedAt: string;
  statePath: string;
  engine: TriggerStateData['engine'];
  triggers: TriggerDashboardItem[];
}

export interface CascadeEvaluationResult {
  completedThreadPath: string;
  evaluated: number;
  fired: number;
  errors: number;
  results: TriggerEngineCycleTriggerResult[];
}

export interface AddSynthesisTriggerOptions {
  tagPattern: string;
  threshold: number;
  actor: string;
  cooldownSeconds?: number;
}

export interface AddSynthesisTriggerResult {
  trigger: PrimitiveInstance;
}

export interface TriggerRunExecutionResult {
  runId: string;
  triggerPath?: string;
  status: DispatchRun['status'];
  retriedFromRunId?: string;
  error?: string;
}

export interface TriggerRunEvidenceLoopResult {
  cycle: TriggerEngineCycleResult;
  executedRuns: TriggerRunExecutionResult[];
  succeeded: number;
  failed: number;
  cancelled: number;
  skipped: number;
}

export interface TriggerRunEvidenceLoopOptions extends TriggerEngineCycleOptions {
  execution?: Omit<dispatch.DispatchExecuteInput, 'actor'>;
  retryFailedRuns?: boolean;
}

export function triggerStatePath(workspacePath: string): string {
  return path.join(workspacePath, TRIGGER_STATE_FILE);
}

export function loadTriggerState(workspacePath: string): TriggerStateData {
  const filePath = triggerStatePath(workspacePath);
  if (!fs.existsSync(filePath)) {
    const seeded = seedTriggerState();
    saveTriggerState(workspacePath, seeded);
    return seeded;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TriggerStateData>;
    return {
      version: parsed.version ?? TRIGGER_STATE_VERSION,
      updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
      engine: {
        cycleCount: parsed.engine?.cycleCount ?? 0,
        lastCycleAt: parsed.engine?.lastCycleAt,
        intervalSeconds: parsed.engine?.intervalSeconds ?? DEFAULT_ENGINE_INTERVAL_SECONDS,
        lastError: parsed.engine?.lastError,
      },
      triggers: parsed.triggers ?? {},
    };
  } catch {
    const seeded = seedTriggerState();
    saveTriggerState(workspacePath, seeded);
    return seeded;
  }
}

export function saveTriggerState(workspacePath: string, state: TriggerStateData): void {
  const filePath = triggerStatePath(workspacePath);
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

export function runTriggerEngineCycle(
  workspacePath: string,
  options: TriggerEngineCycleOptions = {},
): TriggerEngineCycleResult {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const actor = options.actor ?? 'system';
  const intervalSeconds = normalizeInt(options.intervalSeconds, DEFAULT_ENGINE_INTERVAL_SECONDS, 1);
  const state = loadTriggerState(workspacePath);
  const triggers = listNormalizedTriggers(workspacePath);
  const requiresLedgerRead = triggers.some((trigger) =>
    trigger.status === 'active' && (
      trigger.condition?.type === 'event'
      || trigger.condition?.type === 'thread-complete'
    )
  );
  const ledgerEntries = requiresLedgerRead
    ? ledger.readAll(workspacePath)
    : [];

  let fired = 0;
  let errors = 0;
  const results: TriggerEngineCycleTriggerResult[] = [];

  for (const trigger of triggers) {
    const runtime = getOrCreateRuntimeState(state, trigger.path);
    runtime.lastEvaluatedAt = nowIso;
    runtime.state = 'ready';
    runtime.lastError = undefined;

    if (trigger.status !== 'active') {
      runtime.state = 'inactive';
      results.push({
        triggerPath: trigger.path,
        fired: false,
        reason: `Trigger status is "${trigger.status}" (only "active" is evaluated).`,
        runtimeState: runtime.state,
      });
      continue;
    }

    if (!trigger.condition) {
      runtime.state = 'error';
      runtime.lastError = 'Trigger condition is missing or invalid.';
      errors += 1;
      results.push({
        triggerPath: trigger.path,
        fired: false,
        reason: 'Invalid trigger condition.',
        runtimeState: runtime.state,
        error: runtime.lastError,
      });
      continue;
    }
    if (!trigger.action) {
      runtime.state = 'error';
      runtime.lastError = 'Trigger action is missing or invalid.';
      errors += 1;
      results.push({
        triggerPath: trigger.path,
        fired: false,
        reason: 'Invalid trigger action.',
        runtimeState: runtime.state,
        error: runtime.lastError,
      });
      continue;
    }

    const cooldownBlock = evaluateCooldown(runtime, now);
    if (cooldownBlock.blocked) {
      runtime.state = 'cooldown';
      results.push({
        triggerPath: trigger.path,
        fired: false,
        reason: cooldownBlock.reason,
        runtimeState: runtime.state,
      });
      continue;
    }

    const decision = evaluateTriggerCondition({
      workspacePath,
      trigger,
      runtime,
      now,
      ledgerEntries,
    });
    if (!decision.matched) {
      results.push({
        triggerPath: trigger.path,
        fired: false,
        reason: decision.reason,
        runtimeState: runtime.state ?? 'ready',
      });
      continue;
    }

    try {
      const actionResult = executeTriggerAction(
        workspacePath,
        trigger,
        trigger.action,
        decision.context ?? {},
        actor,
        decision.eventKey,
      );
      fired += 1;
      runtime.lastFiredAt = nowIso;
      runtime.fireCount += 1;
      runtime.lastResult = actionResult;
      if (trigger.cooldownSeconds > 0) {
        runtime.cooldownUntil = new Date(now.getTime() + trigger.cooldownSeconds * 1000).toISOString();
        runtime.state = 'cooldown';
      } else {
        runtime.cooldownUntil = undefined;
        runtime.state = 'ready';
      }
      runtime.lastError = undefined;
      results.push({
        triggerPath: trigger.path,
        fired: true,
        reason: decision.reason,
        actionType: trigger.action.type,
        runtimeState: runtime.state,
      });
    } catch (error) {
      runtime.state = 'error';
      runtime.lastError = errorMessage(error);
      errors += 1;
      results.push({
        triggerPath: trigger.path,
        fired: false,
        reason: decision.reason,
        actionType: trigger.action.type,
        runtimeState: runtime.state,
        error: runtime.lastError,
      });
    }
  }

  state.updatedAt = nowIso;
  state.engine.cycleCount += 1;
  state.engine.lastCycleAt = nowIso;
  state.engine.intervalSeconds = intervalSeconds;
  saveTriggerState(workspacePath, state);

  return {
    cycleAt: nowIso,
    evaluated: triggers.length,
    fired,
    errors,
    triggers: results,
    statePath: TRIGGER_STATE_FILE,
  };
}

export async function runTriggerRunEvidenceLoop(
  workspacePath: string,
  options: TriggerRunEvidenceLoopOptions = {},
): Promise<TriggerRunEvidenceLoopResult> {
  const cycle = runTriggerEngineCycle(workspacePath, options);
  const actor = options.actor ?? 'system';
  const triggerState = loadTriggerState(workspacePath);
  const targetRuns = new Map<string, string>();
  for (const triggerResult of cycle.triggers) {
    if (!triggerResult.fired || triggerResult.actionType !== 'dispatch-run') continue;
    const runtime = triggerState.triggers[triggerResult.triggerPath];
    const runId = typeof runtime?.lastResult?.run_id === 'string'
      ? String(runtime.lastResult.run_id)
      : undefined;
    if (!runId) continue;
    targetRuns.set(runId, triggerResult.triggerPath);
  }

  const executedRuns: TriggerRunExecutionResult[] = [];
  for (const [runId, triggerPath] of targetRuns) {
    try {
      const run = dispatch.status(workspacePath, runId);
      if ((run.status === 'failed' || run.status === 'cancelled') && options.retryFailedRuns) {
        const retried = await dispatch.retryRun(workspacePath, run.id, {
          actor,
          execute: true,
          ...(options.execution ?? {}),
        });
        executedRuns.push({
          runId: retried.id,
          triggerPath,
          status: retried.status,
          retriedFromRunId: run.id,
        });
        continue;
      }
      if (run.status === 'queued' || run.status === 'running') {
        const executed = await dispatch.executeRun(workspacePath, run.id, {
          actor,
          ...(options.execution ?? {}),
        });
        executedRuns.push({
          runId: executed.id,
          triggerPath,
          status: executed.status,
        });
        continue;
      }
      executedRuns.push({
        runId: run.id,
        triggerPath,
        status: run.status,
      });
    } catch (error) {
      executedRuns.push({
        runId,
        triggerPath,
        status: 'failed',
        error: errorMessage(error),
      });
    }
  }

  return {
    cycle,
    executedRuns,
    succeeded: executedRuns.filter((entry) => entry.status === 'succeeded').length,
    failed: executedRuns.filter((entry) => entry.status === 'failed').length,
    cancelled: executedRuns.filter((entry) => entry.status === 'cancelled').length,
    skipped: executedRuns.filter((entry) =>
      entry.status !== 'succeeded'
      && entry.status !== 'failed'
      && entry.status !== 'cancelled')
      .length,
  };
}

export async function startTriggerEngine(
  workspacePath: string,
  options: StartTriggerEngineOptions = {},
): Promise<void> {
  const intervalSeconds = normalizeInt(options.intervalSeconds, DEFAULT_ENGINE_INTERVAL_SECONDS, 1);
  const actor = options.actor ?? 'system';
  const logger = options.logger ?? ((line: string) => console.log(line));

  logger(`Trigger engine started (interval=${intervalSeconds}s, workspace=${workspacePath}).`);

  let completedCycles = 0;
  while (options.maxCycles === undefined || completedCycles < options.maxCycles) {
    const cycleResult = options.executeRuns
      ? (await runTriggerRunEvidenceLoop(workspacePath, {
          actor,
          intervalSeconds,
          execution: options.execution,
          retryFailedRuns: options.retryFailedRuns,
        })).cycle
      : runTriggerEngineCycle(workspacePath, {
          actor,
          intervalSeconds,
        });
    logger(
      `[${cycleResult.cycleAt}] cycle=${completedCycles + 1} evaluated=${cycleResult.evaluated} fired=${cycleResult.fired} errors=${cycleResult.errors}`,
    );
    completedCycles += 1;
    if (options.maxCycles !== undefined && completedCycles >= options.maxCycles) {
      break;
    }
    await sleep(intervalSeconds * 1000);
  }
}

export function evaluateThreadCompleteCascadeTriggers(
  workspacePath: string,
  completedThreadPath: string,
  actor: string = 'system',
  now: Date = new Date(),
): CascadeEvaluationResult {
  const state = loadTriggerState(workspacePath);
  const nowIso = now.toISOString();
  const thread = store.read(workspacePath, completedThreadPath);
  const context = {
    completed_thread_path: completedThreadPath,
    completed_thread_title: String(thread?.fields.title ?? completedThreadPath),
    completed_thread_status: String(thread?.fields.status ?? 'done'),
  };

  const candidates = listNormalizedTriggers(workspacePath)
    .filter((trigger) => trigger.status === 'active')
    .filter((trigger) => trigger.condition?.type === 'thread-complete')
    .filter((trigger) => trigger.cascadeOn.length === 0 || trigger.cascadeOn.includes('thread-complete'));

  let fired = 0;
  let errors = 0;
  const results: TriggerEngineCycleTriggerResult[] = [];

  for (const trigger of candidates) {
    const runtime = getOrCreateRuntimeState(state, trigger.path);
    runtime.lastEvaluatedAt = nowIso;
    runtime.state = 'ready';
    runtime.lastError = undefined;

    if (!trigger.action || !trigger.condition || trigger.condition.type !== 'thread-complete') {
      runtime.state = 'error';
      runtime.lastError = 'Trigger missing valid thread-complete condition/action.';
      errors += 1;
      results.push({
        triggerPath: trigger.path,
        fired: false,
        reason: 'Invalid thread-complete trigger definition.',
        runtimeState: runtime.state,
        error: runtime.lastError,
      });
      continue;
    }

    if (trigger.condition.threadPath) {
      const expected = normalizeReferencePath(trigger.condition.threadPath);
      const actual = normalizeReferencePath(completedThreadPath);
      if (expected !== actual) {
        results.push({
          triggerPath: trigger.path,
          fired: false,
          reason: `Completed thread ${actual} does not match cascade target ${expected}.`,
          runtimeState: runtime.state,
        });
        continue;
      }
    }

    const cooldownBlock = evaluateCooldown(runtime, now);
    if (cooldownBlock.blocked) {
      runtime.state = 'cooldown';
      results.push({
        triggerPath: trigger.path,
        fired: false,
        reason: cooldownBlock.reason,
        runtimeState: runtime.state,
      });
      continue;
    }

    try {
      const actionResult = executeTriggerAction(
        workspacePath,
        trigger,
        trigger.action,
        context,
        actor,
        `thread-complete:${completedThreadPath}:${nowIso}`,
      );
      fired += 1;
      runtime.lastFiredAt = nowIso;
      runtime.fireCount += 1;
      runtime.lastResult = actionResult;
      if (trigger.cooldownSeconds > 0) {
        runtime.cooldownUntil = new Date(now.getTime() + trigger.cooldownSeconds * 1000).toISOString();
        runtime.state = 'cooldown';
      } else {
        runtime.cooldownUntil = undefined;
        runtime.state = 'ready';
      }
      results.push({
        triggerPath: trigger.path,
        fired: true,
        reason: `Cascade fired for completed thread ${completedThreadPath}.`,
        actionType: trigger.action.type,
        runtimeState: runtime.state,
      });
    } catch (error) {
      runtime.state = 'error';
      runtime.lastError = errorMessage(error);
      errors += 1;
      results.push({
        triggerPath: trigger.path,
        fired: false,
        reason: `Cascade action failed for ${completedThreadPath}.`,
        actionType: trigger.action.type,
        runtimeState: runtime.state,
        error: runtime.lastError,
      });
    }
  }

  state.updatedAt = nowIso;
  saveTriggerState(workspacePath, state);

  return {
    completedThreadPath,
    evaluated: candidates.length,
    fired,
    errors,
    results,
  };
}

export function triggerDashboard(workspacePath: string, now: Date = new Date()): TriggerDashboard {
  const state = loadTriggerState(workspacePath);
  const triggers = listNormalizedTriggers(workspacePath);
  const nowIso = now.toISOString();

  const items: TriggerDashboardItem[] = triggers.map((trigger) => {
    const runtime = state.triggers[trigger.path] ?? { fireCount: 0 };
    const currentState = deriveRuntimeState(trigger, runtime, now);
    const nextFireAt = computeNextFireAt(trigger, runtime, now);
    return {
      path: trigger.path,
      title: trigger.title,
      status: trigger.status,
      condition: describeCondition(trigger),
      action: describeAction(trigger),
      cooldownSeconds: trigger.cooldownSeconds,
      fireCount: runtime.fireCount ?? 0,
      lastFiredAt: runtime.lastFiredAt,
      nextFireAt,
      currentState,
      lastError: runtime.lastError,
    };
  });

  return {
    generatedAt: nowIso,
    statePath: TRIGGER_STATE_FILE,
    engine: state.engine,
    triggers: items,
  };
}

export function addSynthesisTrigger(
  workspacePath: string,
  options: AddSynthesisTriggerOptions,
): AddSynthesisTriggerResult {
  const threshold = normalizeInt(options.threshold, 1, 1);
  const cooldownSeconds = normalizeInt(options.cooldownSeconds, 0, 0);
  const tagPattern = String(options.tagPattern).trim();
  if (!tagPattern) {
    throw new Error('Synthesis trigger tag pattern is required.');
  }

  const trigger = store.create(
    workspacePath,
    'trigger',
    {
      title: `Auto synthesis (${tagPattern} @ ${threshold})`,
      event: 'fact.created',
      status: 'active',
      condition: {
        type: 'file-watch',
        glob: 'facts/**/*.md',
      },
      action: {
        type: 'create-thread',
        title: `Synthesis needed: ${tagPattern}`,
        goal: `Synthesize newly created facts matching "${tagPattern}" (threshold=${threshold}).`,
        tags: ['synthesis', `tag:${tagPattern}`],
        actor: options.actor,
      },
      cooldown: cooldownSeconds,
      cascade_on: [],
      synthesis: {
        tag_pattern: tagPattern,
        threshold,
        actor: options.actor,
      },
      tags: ['synthesis', 'auto'],
    },
    [
      '## Synthesis Trigger',
      '',
      `Automatically creates a synthesis thread when ${threshold} new facts`,
      `matching tag pattern \`${tagPattern}\` appear since the last fire.`,
      '',
    ].join('\n'),
    'system',
  );

  return { trigger };
}

function executeTriggerAction(
  workspacePath: string,
  trigger: NormalizedTrigger,
  action: TriggerAction,
  context: Record<string, unknown>,
  defaultActor: string,
  eventKey: string | undefined,
): Record<string, unknown> {
  const actor = action.actor ?? (trigger.synthesis?.actor ?? defaultActor);
  switch (action.type) {
    case 'create-thread': {
      const thread = createThreadFromTrigger(workspacePath, trigger, action, context, actor);
      appendTriggerFireLedger(workspacePath, actor, trigger, action.type, eventKey, {
        thread_path: thread.path,
      });
      return {
        action: action.type,
        thread_path: thread.path,
      };
    }
    case 'dispatch-run': {
      const objectiveTemplate = action.objective
        ?? `Trigger ${trigger.title} fired (${trigger.path})`;
      const objective = String(materializeTemplateValue(objectiveTemplate, context));
      const run = dispatch.createRun(workspacePath, {
        actor,
        adapter: action.adapter,
        objective,
        context: {
          trigger_path: trigger.path,
          event_key: eventKey,
          ...(materializeTemplateValue(action.context ?? {}, context) as Record<string, unknown>),
        },
        idempotencyKey: eventKey ? buildDispatchIdempotencyKey(trigger.path, eventKey, objective) : undefined,
      });
      appendTriggerFireLedger(workspacePath, actor, trigger, action.type, eventKey, {
        run_id: run.id,
      });
      return {
        action: action.type,
        run_id: run.id,
        run_status: run.status,
      };
    }
    case 'update-primitive': {
      const targetPath = String(materializeTemplateValue(action.path, context));
      const fields = materializeTemplateValue(action.fields ?? {}, context) as Record<string, unknown>;
      const body = action.body === undefined
        ? undefined
        : String(materializeTemplateValue(action.body, context));
      const updated = store.update(workspacePath, targetPath, fields, body, actor);
      appendTriggerFireLedger(workspacePath, actor, trigger, action.type, eventKey, {
        target_path: targetPath,
      });
      return {
        action: action.type,
        target_path: updated.path,
      };
    }
    case 'shell': {
      const command = String(materializeTemplateValue(action.command, context));
      const timeoutMs = normalizeInt(action.timeoutMs, DEFAULT_SHELL_TIMEOUT_MS, 1);
      const shellResult = spawnSync(command, {
        shell: true,
        cwd: workspacePath,
        encoding: 'utf-8',
        timeout: timeoutMs,
      });
      if (shellResult.error) {
        throw new Error(`Shell trigger command failed: ${shellResult.error.message}`);
      }
      if ((shellResult.status ?? 1) !== 0) {
        throw new Error(
          `Shell trigger command exited with ${shellResult.status}: ${command}\n${shellResult.stderr || shellResult.stdout || ''}`,
        );
      }
      appendTriggerFireLedger(workspacePath, actor, trigger, action.type, eventKey, {
        command,
        exit_code: shellResult.status ?? 0,
      });
      return {
        action: action.type,
        command,
        exit_code: shellResult.status ?? 0,
        stdout: shellResult.stdout?.trim() ?? '',
      };
    }
    default: {
      const exhaustive: never = action;
      throw new Error(`Unsupported trigger action: ${(exhaustive as { type?: string }).type ?? 'unknown'}`);
    }
  }
}

function createThreadFromTrigger(
  workspacePath: string,
  trigger: NormalizedTrigger,
  action: Extract<TriggerAction, { type: 'create-thread' }>,
  context: Record<string, unknown>,
  actor: string,
): PrimitiveInstance {
  const title = String(
    materializeTemplateValue(action.title ?? `Triggered follow-up: ${trigger.title}`, context),
  );
  const goal = String(
    materializeTemplateValue(action.goal ?? `Follow-up work generated by trigger ${trigger.path}.`, context),
  );
  const body = String(
    materializeTemplateValue(
      action.body
        ?? [
          '## Trigger Context',
          '',
          'Generated by trigger execution.',
          '',
          '```json',
          JSON.stringify(context, null, 2),
          '```',
          '',
        ].join('\n'),
      context,
    ),
  );

  const fields = {
    title,
    goal,
    priority: action.priority ?? 'medium',
    deps: action.deps ?? [],
    parent: action.parent,
    space: action.space,
    context_refs: action.context_refs ?? [],
    tags: action.tags ?? [],
  };
  return store.create(workspacePath, 'thread', fields, body, actor);
}

function appendTriggerFireLedger(
  workspacePath: string,
  actor: string,
  trigger: NormalizedTrigger,
  actionType: string,
  eventKey: string | undefined,
  details: Record<string, unknown>,
): void {
  ledger.append(workspacePath, actor, 'update', trigger.path, 'trigger', {
    fired: true,
    action: actionType,
    ...(eventKey ? { event_key: eventKey } : {}),
    ...details,
  });
}

function buildDispatchIdempotencyKey(triggerPath: string, eventKey: string, objective: string): string {
  return `${triggerPath}:${eventKey}:${objective}`.slice(0, 255);
}

function evaluateTriggerCondition(input: {
  workspacePath: string;
  trigger: NormalizedTrigger;
  runtime: TriggerRuntimeState;
  now: Date;
  ledgerEntries: ReturnType<typeof ledger.readAll>;
}): TriggerConditionDecision {
  if (input.trigger.synthesis) {
    return evaluateSynthesisCondition(input);
  }

  const condition = input.trigger.condition;
  if (!condition) {
    return { matched: false, reason: 'Missing condition.' };
  }

  switch (condition.type) {
    case 'cron': {
      const bucket = cronBucket(input.now);
      const matches = matchesCronSchedule(condition.schedule, input.now);
      if (!matches) {
        return {
          matched: false,
          reason: `Cron ${condition.expression} did not match current time.`,
        };
      }
      if (input.runtime.lastCronBucket === bucket) {
        return {
          matched: false,
          reason: `Cron ${condition.expression} already fired for minute bucket ${bucket}.`,
        };
      }
      input.runtime.lastCronBucket = bucket;
      return {
        matched: true,
        reason: `Cron ${condition.expression} matched bucket ${bucket}.`,
        eventKey: `cron:${bucket}`,
      };
    }
    case 'event':
      return evaluateEventCondition(input, condition.eventType);
    case 'thread-complete':
      return evaluateEventCondition(input, 'thread-complete');
    case 'file-watch':
      return evaluateFileWatchCondition(input, condition.glob);
    default: {
      const exhaustive: never = condition;
      return {
        matched: false,
        reason: `Unsupported condition type: ${(exhaustive as { type?: string }).type ?? 'unknown'}`,
      };
    }
  }
}

function evaluateSynthesisCondition(input: {
  workspacePath: string;
  trigger: NormalizedTrigger;
  runtime: TriggerRuntimeState;
  now: Date;
}): TriggerConditionDecision {
  const synthesis = input.trigger.synthesis;
  if (!synthesis) {
    return {
      matched: false,
      reason: 'Missing synthesis configuration.',
    };
  }

  const nowIso = input.now.toISOString();
  if (!input.runtime.synthesisCursorTs) {
    input.runtime.synthesisCursorTs = nowIso;
    return {
      matched: false,
      reason: 'Initialized synthesis cursor; waiting for new matching facts.',
    };
  }

  const cursorTs = input.runtime.synthesisCursorTs;
  const cursorDate = new Date(cursorTs);
  const facts = store.list(input.workspacePath, 'fact');
  const matchingFacts = facts.filter((fact) => {
    if (!factHasTagPattern(fact, synthesis.tagPattern)) return false;
    const createdAt = readPrimitiveTimestamp(input.workspacePath, fact, 'created');
    return createdAt.getTime() > cursorDate.getTime();
  });

  if (matchingFacts.length < synthesis.threshold) {
    return {
      matched: false,
      reason: `Synthesis threshold not met (${matchingFacts.length}/${synthesis.threshold}).`,
    };
  }

  input.runtime.synthesisCursorTs = nowIso;
  return {
    matched: true,
    reason: `Synthesis threshold met (${matchingFacts.length}/${synthesis.threshold}).`,
    eventKey: `synthesis:${nowIso}`,
    context: {
      synthesis_tag_pattern: synthesis.tagPattern,
      synthesis_threshold: synthesis.threshold,
      synthesis_match_count: matchingFacts.length,
      synthesis_fact_paths: matchingFacts.map((fact) => fact.path),
    },
  };
}

function evaluateEventCondition(input: {
  trigger: NormalizedTrigger;
  runtime: TriggerRuntimeState;
  now: Date;
  ledgerEntries: ReturnType<typeof ledger.readAll>;
}, eventTypeRaw: string): TriggerConditionDecision {
  const eventType = eventTypeRaw.toLowerCase();
  const totalEntries = input.ledgerEntries.length;
  const latestEntry = input.ledgerEntries[totalEntries - 1];

  if (input.runtime.lastEventCursorOffset === undefined) {
    input.runtime.lastEventCursorOffset = deriveEventCursorOffset(input.ledgerEntries, input.runtime);
    input.runtime.lastEventCursorTs = latestEntry?.ts ?? input.now.toISOString();
    input.runtime.lastEventCursorHash = latestEntry?.hash;
    return {
      matched: false,
      reason: `Initialized event cursor for ${eventType} at offset ${input.runtime.lastEventCursorOffset}.`,
    };
  }

  const cursorOffset = clampEventCursorOffset(input.runtime.lastEventCursorOffset, totalEntries);
  const newEntries = input.ledgerEntries.slice(cursorOffset);
  if (newEntries.length === 0) {
    return {
      matched: false,
      reason: `No new events for ${eventType} since ledger offset ${cursorOffset}.`,
    };
  }

  const matching = newEntries.filter((entry) => ledgerEntryMatchesEventType(entry, eventType));
  const latestProcessed = newEntries[newEntries.length - 1]!;
  input.runtime.lastEventCursorOffset = totalEntries;
  input.runtime.lastEventCursorTs = latestProcessed.ts;
  input.runtime.lastEventCursorHash = latestProcessed.hash;

  if (matching.length === 0) {
    return {
      matched: false,
      reason: `No matching ${eventType} events in ${newEntries.length} new ledger entries.`,
    };
  }

  const latest = matching[matching.length - 1]!;
  return {
    matched: true,
    reason: `Matched ${matching.length} ${eventType} event(s).`,
    eventKey: `${eventType}:${latest.ts}:${latest.target}`,
    context: {
      matched_event_count: matching.length,
      matched_event_latest_target: latest.target,
      matched_event_latest_op: latest.op,
      matched_event_latest_type: latest.type,
    },
  };
}

function deriveEventCursorOffset(
  entries: ReturnType<typeof ledger.readAll>,
  runtime: TriggerRuntimeState,
): number {
  if (entries.length === 0) return 0;
  if (runtime.lastEventCursorOffset !== undefined) {
    return clampEventCursorOffset(runtime.lastEventCursorOffset, entries.length);
  }

  const cursorTs = typeof runtime.lastEventCursorTs === 'string'
    ? runtime.lastEventCursorTs.trim()
    : '';
  if (!cursorTs) return entries.length;

  const cursorHash = typeof runtime.lastEventCursorHash === 'string'
    ? runtime.lastEventCursorHash.trim()
    : '';
  if (cursorHash) {
    const hashIdx = findLastEntryIndex(entries, (entry) =>
      entry.ts === cursorTs && String(entry.hash ?? '') === cursorHash
    );
    if (hashIdx !== -1) return hashIdx + 1;
  }

  const sameTsIdx = findLastEntryIndex(entries, (entry) => entry.ts === cursorTs);
  if (sameTsIdx !== -1) return sameTsIdx + 1;

  const firstNewerIdx = entries.findIndex((entry) => entry.ts > cursorTs);
  if (firstNewerIdx !== -1) return firstNewerIdx;
  return entries.length;
}

function clampEventCursorOffset(offset: number, totalEntries: number): number {
  if (!Number.isFinite(offset)) return totalEntries;
  return Math.min(totalEntries, Math.max(0, Math.trunc(offset)));
}

function findLastEntryIndex(
  entries: ReturnType<typeof ledger.readAll>,
  predicate: (entry: ReturnType<typeof ledger.readAll>[number]) => boolean,
): number {
  for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
    if (predicate(entries[idx]!)) return idx;
  }
  return -1;
}

function evaluateFileWatchCondition(input: {
  workspacePath: string;
  runtime: TriggerRuntimeState;
  now: Date;
}, glob: string): TriggerConditionDecision {
  const nowIso = input.now.toISOString();
  if (!input.runtime.lastFileScanTs) {
    input.runtime.lastFileScanTs = nowIso;
    return {
      matched: false,
      reason: `Initialized file-watch cursor for ${glob}.`,
    };
  }

  const changedFiles = listFilesMatchingGlobChangedAfter(
    input.workspacePath,
    glob,
    new Date(input.runtime.lastFileScanTs),
  );
  input.runtime.lastFileScanTs = nowIso;

  if (changedFiles.length === 0) {
    return {
      matched: false,
      reason: `No file changes matching ${glob}.`,
    };
  }

  return {
    matched: true,
    reason: `${changedFiles.length} file(s) changed matching ${glob}.`,
    eventKey: `file-watch:${glob}:${nowIso}`,
    context: {
      changed_file_count: changedFiles.length,
      changed_files: changedFiles,
    },
  };
}

function ledgerEntryMatchesEventType(
  entry: ReturnType<typeof ledger.readAll>[number],
  eventType: string,
): boolean {
  const typeOp = `${String(entry.type ?? '').toLowerCase()}.${entry.op.toLowerCase()}`;
  const opOnly = entry.op.toLowerCase();
  const canonicalType = String(entry.type ?? '').toLowerCase();

  if (eventType === 'thread-complete') {
    return canonicalType === 'thread' && entry.op === 'done';
  }
  if (eventType === opOnly) return true;
  if (eventType === typeOp) return true;
  const dataEvent = typeof entry.data?.event_type === 'string'
    ? String(entry.data.event_type).toLowerCase()
    : null;
  return dataEvent === eventType;
}

function listNormalizedTriggers(workspacePath: string): NormalizedTrigger[] {
  return store.list(workspacePath, 'trigger')
    .map((instance) => normalizeTrigger(workspacePath, instance))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function normalizeTrigger(workspacePath: string, instance: PrimitiveInstance): NormalizedTrigger {
  const status = String(instance.fields.status ?? 'draft').toLowerCase();
  const title = String(instance.fields.title ?? instance.path);
  const cooldownSeconds = normalizeInt(
    asNumber(instance.fields.cooldown) ?? asNumber(instance.fields.cooldown_seconds) ?? 0,
    0,
    0,
  );

  const condition = safeParseCondition(instance.fields.condition ?? instance.fields.event);
  const action = parseTriggerAction(instance.fields.action);
  const synthesis = parseSynthesisConfig(instance.fields.synthesis, instance.fields);
  const cascadeOn = asStringList(instance.fields.cascade_on);

  // Normalize legacy thread-complete filters in frontmatter.
  if (condition?.type === 'thread-complete' && !condition.threadPath) {
    const conditionThread = asString(instance.fields.thread_path);
    if (conditionThread) {
      condition.threadPath = normalizeReferencePath(conditionThread);
    }
  }

  return {
    instance,
    path: instance.path,
    title,
    status,
    cooldownSeconds,
    condition,
    action,
    cascadeOn,
    synthesis,
  };
}

function safeParseCondition(raw: unknown): TriggerCondition | null {
  try {
    return parseTriggerCondition(raw);
  } catch {
    return null;
  }
}

function parseTriggerCondition(raw: unknown): TriggerCondition | null {
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return null;
    if (looksLikeCron(text)) {
      return {
        type: 'cron',
        expression: text,
        schedule: parseCronExpression(text),
      };
    }
    if (text.toLowerCase() === 'thread-complete') {
      return { type: 'thread-complete' };
    }
    return {
      type: 'event',
      eventType: text,
    };
  }

  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const type = String(obj.type ?? '').toLowerCase();

  if (type === 'cron' || obj.cron !== undefined || obj.expression !== undefined) {
    const expression = String(obj.expression ?? obj.cron ?? '').trim();
    if (!expression) return null;
    return {
      type: 'cron',
      expression,
      schedule: parseCronExpression(expression),
    };
  }
  if (type === 'event' || obj.event !== undefined || obj.event_type !== undefined) {
    const eventType = String(obj.event ?? obj.event_type ?? '').trim();
    if (!eventType) return null;
    return {
      type: 'event',
      eventType,
    };
  }
  if (type === 'file-watch' || obj.glob !== undefined || obj.pattern !== undefined) {
    const glob = String(obj.glob ?? obj.pattern ?? '').trim();
    if (!glob) return null;
    return {
      type: 'file-watch',
      glob: normalizeGlob(glob),
    };
  }
  if (type === 'thread-complete') {
    const threadPath = asString(obj.thread_path ?? obj.thread);
    return {
      type: 'thread-complete',
      threadPath: threadPath ? normalizeReferencePath(threadPath) : undefined,
    };
  }

  return null;
}

function parseTriggerAction(raw: unknown): TriggerAction | null {
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return null;
    const lowered = text.toLowerCase();
    if (lowered === 'create-thread') {
      return { type: 'create-thread' };
    }
    if (lowered === 'dispatch-run') {
      return { type: 'dispatch-run' };
    }
    if (lowered === 'update-primitive') {
      return null;
    }
    if (lowered.startsWith('shell:')) {
      return {
        type: 'shell',
        command: text.slice('shell:'.length).trim(),
      };
    }
    // Legacy behavior: treat free-form action strings as dispatch objective.
    return {
      type: 'dispatch-run',
      objective: text,
    };
  }

  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const type = String(obj.type ?? '').toLowerCase();
  switch (type) {
    case 'create-thread':
      return {
        type: 'create-thread',
        title: asString(obj.title),
        goal: asString(obj.goal),
        body: asString(obj.body),
        priority: asString(obj.priority),
        deps: asStringList(obj.deps),
        parent: asString(obj.parent),
        space: asString(obj.space),
        context_refs: asStringList(obj.context_refs),
        tags: asStringList(obj.tags),
        actor: asString(obj.actor),
      };
    case 'dispatch-run':
      return {
        type: 'dispatch-run',
        objective: asString(obj.objective),
        adapter: asString(obj.adapter),
        context: isRecord(obj.context) ? obj.context : undefined,
        actor: asString(obj.actor),
      };
    case 'update-primitive': {
      const targetPath = asString(obj.path ?? obj.target_path ?? obj.target);
      if (!targetPath) return null;
      return {
        type: 'update-primitive',
        path: normalizeReferencePath(targetPath),
        fields: isRecord(obj.fields) ? obj.fields : undefined,
        body: asString(obj.body),
        actor: asString(obj.actor),
      };
    }
    case 'shell': {
      const command = asString(obj.command ?? obj.shell ?? obj.script);
      if (!command) return null;
      return {
        type: 'shell',
        command,
        timeoutMs: asNumber(obj.timeout_ms) ?? asNumber(obj.timeoutMs) ?? undefined,
        actor: asString(obj.actor),
      };
    }
    default:
      return null;
  }
}

function parseSynthesisConfig(raw: unknown, fields: Record<string, unknown>): SynthesisConfig | null {
  let source: Record<string, unknown> | null = null;
  if (isRecord(raw)) {
    source = raw;
  } else {
    const legacyPattern = asString(fields.synthesis_tag_pattern);
    const legacyThreshold = asNumber(fields.synthesis_threshold);
    if (legacyPattern && legacyThreshold) {
      source = {
        tag_pattern: legacyPattern,
        threshold: legacyThreshold,
        actor: asString(fields.synthesis_actor),
      };
    }
  }
  if (!source) return null;
  const tagPattern = asString(source.tag_pattern ?? source.tagPattern);
  const threshold = asNumber(source.threshold);
  if (!tagPattern || !threshold || threshold <= 0) return null;
  return {
    tagPattern,
    threshold: normalizeInt(threshold, 1, 1),
    actor: asString(source.actor),
  };
}

function getOrCreateRuntimeState(state: TriggerStateData, triggerPath: string): TriggerRuntimeState {
  if (!state.triggers[triggerPath]) {
    state.triggers[triggerPath] = { fireCount: 0 };
  }
  return state.triggers[triggerPath]!;
}

function evaluateCooldown(
  runtime: TriggerRuntimeState,
  now: Date,
): { blocked: false } | { blocked: true; reason: string } {
  if (!runtime.cooldownUntil) {
    return { blocked: false };
  }
  const until = Date.parse(runtime.cooldownUntil);
  if (Number.isNaN(until) || now.getTime() >= until) {
    runtime.cooldownUntil = undefined;
    return { blocked: false };
  }
  const remainingMs = until - now.getTime();
  return {
    blocked: true,
    reason: `Cooldown active (${Math.ceil(remainingMs / 1000)}s remaining).`,
  };
}

function computeNextFireAt(
  trigger: NormalizedTrigger,
  runtime: TriggerRuntimeState,
  now: Date,
): string | undefined {
  let candidate: Date | null = null;
  if (trigger.condition?.type === 'cron') {
    candidate = nextCronMatch(trigger.condition.schedule, now);
  }

  if (runtime.cooldownUntil) {
    const cooldownDate = new Date(runtime.cooldownUntil);
    if (!candidate || cooldownDate.getTime() > candidate.getTime()) {
      candidate = cooldownDate;
    }
  }
  return candidate?.toISOString();
}

function deriveRuntimeState(
  trigger: NormalizedTrigger,
  runtime: TriggerRuntimeState,
  now: Date,
): TriggerRuntimeStatus {
  if (trigger.status !== 'active') return 'inactive';
  if (runtime.lastError) return 'error';
  if (runtime.cooldownUntil) {
    const until = Date.parse(runtime.cooldownUntil);
    if (Number.isFinite(until) && now.getTime() < until) {
      return 'cooldown';
    }
  }
  return runtime.state ?? 'ready';
}

function describeCondition(trigger: NormalizedTrigger): string {
  if (trigger.synthesis) {
    return `synthesis(tag=${trigger.synthesis.tagPattern}, threshold=${trigger.synthesis.threshold})`;
  }
  if (!trigger.condition) return 'invalid';
  switch (trigger.condition.type) {
    case 'cron':
      return `cron(${trigger.condition.expression})`;
    case 'event':
      return `event(${trigger.condition.eventType})`;
    case 'file-watch':
      return `file-watch(${trigger.condition.glob})`;
    case 'thread-complete':
      return `thread-complete(${trigger.condition.threadPath ?? '*'})`;
    default:
      return 'invalid';
  }
}

function describeAction(trigger: NormalizedTrigger): string {
  const action = trigger.action;
  if (!action) return 'invalid';
  switch (action.type) {
    case 'create-thread':
      return `create-thread(${action.title ?? 'untitled'})`;
    case 'dispatch-run':
      return `dispatch-run(${action.objective ?? 'default objective'})`;
    case 'update-primitive':
      return `update-primitive(${action.path})`;
    case 'shell':
      return `shell(${action.command})`;
    default:
      return 'invalid';
  }
}

function cronBucket(now: Date): string {
  const copy = new Date(now.getTime());
  copy.setSeconds(0, 0);
  return copy.toISOString();
}

function factHasTagPattern(fact: PrimitiveInstance, pattern: string): boolean {
  const tags = asStringList(fact.fields.tags).map((entry) => entry.toLowerCase());
  if (tags.length === 0) return false;
  const normalizedPattern = pattern.toLowerCase();
  return tags.some((tag) => wildcardMatch(tag, normalizedPattern));
}

function wildcardMatch(value: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(value);
}

function readPrimitiveTimestamp(workspacePath: string, instance: PrimitiveInstance, field: string): Date {
  const value = asString(instance.fields[field]);
  if (value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed);
    }
  }
  const absPath = path.join(workspacePath, instance.path);
  const stat = fs.statSync(absPath);
  return new Date(stat.mtimeMs);
}

function listFilesMatchingGlobChangedAfter(
  workspacePath: string,
  globPattern: string,
  after: Date,
): string[] {
  const normalizedGlob = normalizeGlob(globPattern);
  const matcher = globToRegExp(normalizedGlob);
  const baseDirectory = findGlobBaseDirectory(normalizedGlob);
  const absoluteBase = path.join(workspacePath, baseDirectory);
  if (!fs.existsSync(absoluteBase)) return [];

  const files = listFilesRecursive(absoluteBase);
  const changed: string[] = [];
  for (const absPath of files) {
    const relPath = path.relative(workspacePath, absPath).replace(/\\/g, '/');
    if (!matcher.test(relPath)) continue;
    const stat = fs.statSync(absPath);
    if (stat.mtimeMs > after.getTime()) {
      changed.push(relPath);
    }
  }
  return changed.sort((a, b) => a.localeCompare(b));
}

function listFilesRecursive(root: string): string[] {
  const output: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absPath);
      } else if (entry.isFile()) {
        output.push(absPath);
      }
    }
  }
  return output;
}

function globToRegExp(globPattern: string): RegExp {
  let regex = '^';
  const pattern = normalizeGlob(globPattern);
  for (let idx = 0; idx < pattern.length; idx += 1) {
    const remaining = pattern.slice(idx);
    if (remaining.startsWith('**/')) {
      regex += '(?:.*/)?';
      idx += 2;
      continue;
    }
    const ch = pattern[idx]!;
    if (ch === '*') {
      if (pattern[idx + 1] === '*') {
        regex += '.*';
        idx += 1;
      } else {
        regex += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      regex += '[^/]';
      continue;
    }
    regex += escapeRegex(ch);
  }
  regex += '$';
  return new RegExp(regex);
}

function findGlobBaseDirectory(globPattern: string): string {
  const normalized = normalizeGlob(globPattern);
  const wildcardIndex = normalized.search(/[*?]/);
  const prefix = wildcardIndex === -1 ? normalized : normalized.slice(0, wildcardIndex);
  const slashIndex = prefix.lastIndexOf('/');
  if (slashIndex === -1) return '.';
  const base = prefix.slice(0, slashIndex);
  return base || '.';
}

function normalizeGlob(value: string): string {
  const normalized = String(value ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  return normalized.length > 0 ? normalized : '**/*';
}

function normalizeReferencePath(value: string): string {
  const trimmed = String(value ?? '').trim();
  const unwrapped = trimmed.startsWith('[[') && trimmed.endsWith(']]')
    ? trimmed.slice(2, -2)
    : trimmed;
  return unwrapped.endsWith('.md') ? unwrapped : `${unwrapped}.md`;
}

function materializeTemplateValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    return interpolateTemplate(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => materializeTemplateValue(entry, context));
  }
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      output[key] = materializeTemplateValue(inner, context);
    }
    return output;
  }
  return value;
}

function interpolateTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_full, key: string) => {
    const value = context[key];
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  });
}

function seedTriggerState(): TriggerStateData {
  return {
    version: TRIGGER_STATE_VERSION,
    updatedAt: new Date(0).toISOString(),
    engine: {
      cycleCount: 0,
      intervalSeconds: DEFAULT_ENGINE_INTERVAL_SECONDS,
    },
    triggers: {},
  };
}

function looksLikeCron(text: string): boolean {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  try {
    parseCronExpression(text);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeInt(value: unknown, fallback: number, minimum: number): number {
  const numeric = asNumber(value);
  if (numeric === undefined) return fallback;
  return Math.max(minimum, Math.trunc(numeric));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}
