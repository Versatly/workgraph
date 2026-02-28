import fs from 'node:fs';
import path from 'node:path';
import * as dispatch from './dispatch.js';
import * as ledger from './ledger.js';
import * as store from './store.js';
import * as trigger from './trigger.js';
import type { DispatchRun, LedgerEntry, PrimitiveInstance } from './types.js';

const TRIGGER_ENGINE_STATE_FILE = '.workgraph/trigger-engine.json';
const TRIGGER_ENGINE_VERSION = 1;
const MAX_RECENT_EVENT_IDS = 5000;

export interface TriggerEngineState {
  version: number;
  lastProcessedIndex: number;
  recentEventIds: string[];
  updatedAt: string;
}

export interface TriggerExecutionAction {
  triggerPath: string;
  eventName: string;
  eventId: string;
  sourceTarget: string;
  sourceActor: string;
  runId: string;
  runStatus: DispatchRun['status'];
}

export interface DriftIssue {
  type: 'ledger-hash-chain' | 'stale-claim';
  severity: 'warn' | 'error';
  message: string;
  target?: string;
  actor?: string;
  ageMinutes?: number;
}

export interface DriftReport {
  ok: boolean;
  issues: DriftIssue[];
}

export interface TriggerEngineCycleOptions {
  actor: string;
  executeRuns?: boolean;
  agents?: string[];
  maxSteps?: number;
  stepDelayMs?: number;
  space?: string;
  staleClaimMinutes?: number;
  strictLedger?: boolean;
  entryLimit?: number;
}

export interface TriggerEngineCycleResult {
  processedEntries: number;
  matchedEvents: number;
  actions: TriggerExecutionAction[];
  state: TriggerEngineState;
  drift: DriftReport;
  triggerCount: number;
}

export interface TriggerEngineLoopOptions extends TriggerEngineCycleOptions {
  watch?: boolean;
  pollMs?: number;
  maxCycles?: number;
}

export interface TriggerEngineLoopResult {
  cycles: TriggerEngineCycleResult[];
  finalState: TriggerEngineState;
}

export function triggerEngineStatePath(workspacePath: string): string {
  return path.join(workspacePath, TRIGGER_ENGINE_STATE_FILE);
}

export function loadTriggerEngineState(workspacePath: string): TriggerEngineState {
  const statePath = triggerEngineStatePath(workspacePath);
  if (!fs.existsSync(statePath)) {
    const seeded = seedState();
    saveTriggerEngineState(workspacePath, seeded);
    return seeded;
  }
  try {
    const raw = fs.readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TriggerEngineState>;
    return {
      version: TRIGGER_ENGINE_VERSION,
      lastProcessedIndex: Number.isInteger(parsed.lastProcessedIndex) ? Number(parsed.lastProcessedIndex) : -1,
      recentEventIds: Array.isArray(parsed.recentEventIds)
        ? parsed.recentEventIds.map((entry) => String(entry))
        : [],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return seedState();
  }
}

export function saveTriggerEngineState(workspacePath: string, state: TriggerEngineState): void {
  const statePath = triggerEngineStatePath(workspacePath);
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

export async function runTriggerEngineCycle(
  workspacePath: string,
  options: TriggerEngineCycleOptions,
): Promise<TriggerEngineCycleResult> {
  const state = loadTriggerEngineState(workspacePath);
  const entries = ledger.readAll(workspacePath);
  const startIndex = Math.min(Math.max(state.lastProcessedIndex + 1, 0), entries.length);
  const tail = entries.slice(startIndex);
  const selectedEntries = (options.entryLimit && options.entryLimit > 0)
    ? tail.slice(0, options.entryLimit)
    : tail;
  const triggers = loadActiveTriggers(workspacePath);
  const actions: TriggerExecutionAction[] = [];
  let matchedEvents = 0;

  for (let offset = 0; offset < selectedEntries.length; offset++) {
    const entry = selectedEntries[offset];
    const absoluteIndex = startIndex + offset;
    const eventName = deriveEventName(entry);
    if (!eventName) {
      state.lastProcessedIndex = absoluteIndex;
      continue;
    }

    for (const triggerInstance of triggers) {
      if (!triggerMatchesEntry(triggerInstance, eventName, entry)) {
        continue;
      }
      const eventId = `${triggerInstance.path}:${entry.hash ?? `${entry.ts}:${absoluteIndex}`}:${eventName}`;
      if (state.recentEventIds.includes(eventId)) {
        continue;
      }

      matchedEvents += 1;
      const objective = `Trigger ${String(triggerInstance.fields.title ?? triggerInstance.path)} auto-fired from event ${eventName}`;
      const fired = trigger.fireTrigger(workspacePath, triggerInstance.path, {
        actor: options.actor,
        eventKey: eventId,
        objective,
        context: {
          source_event: eventName,
          source_target: entry.target,
          source_actor: entry.actor,
          source_ts: entry.ts,
          source_hash: entry.hash,
        },
      });

      let runStatus = fired.run.status;
      if (options.executeRuns !== false) {
        const executed = await dispatch.executeRun(workspacePath, fired.run.id, {
          actor: options.actor,
          agents: options.agents,
          maxSteps: options.maxSteps,
          stepDelayMs: options.stepDelayMs,
          space: options.space,
          createCheckpoint: true,
        });
        runStatus = executed.status;
      }

      actions.push({
        triggerPath: triggerInstance.path,
        eventName,
        eventId,
        sourceTarget: entry.target,
        sourceActor: entry.actor,
        runId: fired.run.id,
        runStatus,
      });
      state.recentEventIds.push(eventId);
      if (state.recentEventIds.length > MAX_RECENT_EVENT_IDS) {
        state.recentEventIds = state.recentEventIds.slice(-MAX_RECENT_EVENT_IDS);
      }
    }

    state.lastProcessedIndex = absoluteIndex;
  }

  state.updatedAt = new Date().toISOString();
  saveTriggerEngineState(workspacePath, state);

  const drift = evaluateDrift(workspacePath, {
    staleClaimMinutes: options.staleClaimMinutes,
    strictLedger: options.strictLedger,
  });

  return {
    processedEntries: selectedEntries.length,
    matchedEvents,
    actions,
    state,
    drift,
    triggerCount: triggers.length,
  };
}

export async function runTriggerEngineLoop(
  workspacePath: string,
  options: TriggerEngineLoopOptions,
): Promise<TriggerEngineLoopResult> {
  const watch = options.watch === true;
  const pollMs = clampInt(options.pollMs, 2000, 100, 60_000);
  const maxCycles = clampInt(options.maxCycles, watch ? Number.MAX_SAFE_INTEGER : 1, 1, Number.MAX_SAFE_INTEGER);
  const cycles: TriggerEngineCycleResult[] = [];

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    const result = await runTriggerEngineCycle(workspacePath, options);
    cycles.push(result);
    if (!watch) break;
    if (cycle + 1 >= maxCycles) break;
    await sleep(pollMs);
  }

  return {
    cycles,
    finalState: loadTriggerEngineState(workspacePath),
  };
}

export function evaluateDrift(
  workspacePath: string,
  options: {
    staleClaimMinutes?: number;
    strictLedger?: boolean;
  } = {},
): DriftReport {
  const issues: DriftIssue[] = [];
  const staleClaimMinutes = clampInt(options.staleClaimMinutes, 30, 1, 24 * 60);
  const strictLedger = options.strictLedger !== false;
  const verify = ledger.verifyHashChain(workspacePath, { strict: strictLedger });
  if (!verify.ok) {
    for (const issue of verify.issues) {
      issues.push({
        type: 'ledger-hash-chain',
        severity: 'error',
        message: issue,
      });
    }
    for (const warning of verify.warnings) {
      issues.push({
        type: 'ledger-hash-chain',
        severity: 'warn',
        message: warning,
      });
    }
  }

  const claims = ledger.allClaims(workspacePath);
  const now = Date.now();
  for (const [target, owner] of claims.entries()) {
    const history = ledger.historyOf(workspacePath, target);
    const latest = history[history.length - 1];
    if (!latest) continue;
    const ageMinutes = (now - Date.parse(latest.ts)) / 60_000;
    if (ageMinutes > staleClaimMinutes) {
      issues.push({
        type: 'stale-claim',
        severity: 'warn',
        message: `Claim on ${target} by ${owner} is stale (${ageMinutes.toFixed(1)} minutes).`,
        target,
        actor: owner,
        ageMinutes,
      });
    }
  }

  return {
    ok: issues.filter((issue) => issue.severity === 'error').length === 0,
    issues,
  };
}

function loadActiveTriggers(workspacePath: string): PrimitiveInstance[] {
  return store
    .list(workspacePath, 'trigger')
    .filter((entry) => {
      const status = String(entry.fields.status ?? 'draft');
      return status === 'approved' || status === 'active';
    });
}

function deriveEventName(entry: LedgerEntry): string | null {
  if (entry.type === 'trigger' && entry.data?.fired === true) {
    return null;
  }
  const type = entry.type ?? 'unknown';
  switch (entry.op) {
    case 'create':
      return `${type}.created`;
    case 'update':
      return `${type}.updated`;
    case 'delete':
      return `${type}.deleted`;
    case 'claim':
      return `${type}.claimed`;
    case 'release':
      return `${type}.released`;
    case 'block':
      return `${type}.blocked`;
    case 'unblock':
      return `${type}.unblocked`;
    case 'done':
      return `${type}.done`;
    case 'cancel':
      return `${type}.cancelled`;
    case 'define':
      return `${type}.defined`;
    case 'decompose':
      return `${type}.decomposed`;
    default:
      return `${type}.${entry.op}`;
  }
}

function triggerMatchesEntry(triggerInstance: PrimitiveInstance, eventName: string, entry: LedgerEntry): boolean {
  const configured = String(triggerInstance.fields.event ?? '').trim();
  if (!configured) return false;
  if (!matchesEventPattern(configured, eventName)) return false;

  const actorFilter = readString(triggerInstance.fields.actor_filter);
  if (actorFilter && actorFilter !== entry.actor) {
    return false;
  }

  const targetIncludes = readString(triggerInstance.fields.target_includes);
  if (targetIncludes && !entry.target.includes(targetIncludes)) {
    return false;
  }

  return true;
}

function matchesEventPattern(pattern: string, eventName: string): boolean {
  if (pattern === '*' || pattern === '*.*') return true;
  if (pattern === eventName) return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2);
    return eventName.startsWith(`${prefix}.`);
  }
  return false;
}

function seedState(): TriggerEngineState {
  return {
    version: TRIGGER_ENGINE_VERSION,
    lastProcessedIndex: -1,
    recentEventIds: [],
    updatedAt: new Date().toISOString(),
  };
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, raw));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
