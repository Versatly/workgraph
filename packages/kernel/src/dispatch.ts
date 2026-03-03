/**
 * Runtime dispatch contract with adapter-backed execution.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as auth from './auth.js';
import * as ledger from './ledger.js';
import * as store from './store.js';
import * as thread from './thread.js';
import * as gate from './gate.js';
import { resolveDispatchAdapter } from './runtime-adapter-registry.js';
import type { DispatchAdapterLogEntry } from './runtime-adapter-contracts.js';
import type { DispatchRun, PrimitiveInstance, RunStatus } from './types.js';

const RUNS_FILE = '.workgraph/dispatch-runs.json';
const DEFAULT_LEASE_MINUTES = 30;

export interface DispatchCreateInput {
  actor: string;
  adapter?: string;
  objective: string;
  context?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface DispatchExecuteInput {
  actor: string;
  agents?: string[];
  maxSteps?: number;
  stepDelayMs?: number;
  space?: string;
  createCheckpoint?: boolean;
}

export interface DispatchHeartbeatInput {
  actor: string;
  leaseMinutes?: number;
}

export interface DispatchReconcileResult {
  reconciledAt: string;
  inspectedRuns: number;
  requeuedRuns: DispatchRun[];
}

export interface DispatchHandoffInput {
  actor: string;
  to: string;
  reason: string;
  adapter?: string;
}

export interface DispatchHandoffResult {
  sourceRun: DispatchRun;
  handoffRun: DispatchRun;
}

export interface DispatchClaimResult {
  thread: PrimitiveInstance;
  gateCheck: gate.ThreadGateCheckResult;
}

export function createRun(workspacePath: string, input: DispatchCreateInput): DispatchRun {
  assertDispatchMutationAuthorized(workspacePath, input.actor, 'dispatch.run.create', '.workgraph/dispatch-runs', [
    'dispatch:run',
  ]);
  const state = loadRuns(workspacePath);
  if (input.idempotencyKey) {
    const existing = state.runs.find((run) => run.idempotencyKey === input.idempotencyKey);
    if (existing) return existing;
  }

  const now = new Date().toISOString();
  const run: DispatchRun = {
    id: `run_${randomUUID()}`,
    createdAt: now,
    updatedAt: now,
    actor: input.actor,
    adapter: input.adapter ?? 'cursor-cloud',
    objective: input.objective,
    status: 'queued',
    leaseDurationMinutes: DEFAULT_LEASE_MINUTES,
    heartbeats: [],
    idempotencyKey: input.idempotencyKey,
    context: input.context,
    followups: [],
    logs: [
      { ts: now, level: 'info', message: `Run created for objective: ${input.objective}` },
    ],
  };

  state.runs.push(run);
  saveRuns(workspacePath, state);
  ledger.append(workspacePath, input.actor, 'create', `.workgraph/runs/${run.id}`, 'run', {
    adapter: run.adapter,
    objective: run.objective,
    status: run.status,
  });

  ensureRunPrimitive(workspacePath, run, input.actor);
  return run;
}

export function claimThread(workspacePath: string, threadRef: string, actor: string): DispatchClaimResult {
  assertDispatchMutationAuthorized(workspacePath, actor, 'dispatch.thread.claim', threadRef, [
    'thread:claim',
    'thread:manage',
  ]);
  const threadPath = resolveThreadRef(threadRef);
  const gateCheck = gate.checkThreadGates(workspacePath, threadPath);
  if (!gateCheck.allowed) {
    throw new Error(gate.summarizeGateFailures(gateCheck));
  }
  const claimedThread = thread.claim(workspacePath, threadPath, actor);
  return {
    thread: claimedThread,
    gateCheck,
  };
}

export function status(workspacePath: string, runId: string): DispatchRun {
  const run = getRun(workspacePath, runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  return run;
}

export function followup(workspacePath: string, runId: string, actor: string, input: string): DispatchRun {
  assertDispatchMutationAuthorized(workspacePath, actor, 'dispatch.run.followup', runId, [
    'dispatch:run',
  ]);
  const state = loadRuns(workspacePath);
  const run = state.runs.find((entry) => entry.id === runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (!['queued', 'running'].includes(run.status)) {
    throw new Error(`Cannot send follow-up to run ${runId} in terminal status "${run.status}".`);
  }
  const now = new Date().toISOString();
  run.followups.push({ ts: now, actor, input });
  run.updatedAt = now;
  run.logs.push({
    ts: now,
    level: 'info',
    message: `Follow-up from ${actor}: ${input}`,
  });
  saveRuns(workspacePath, state);
  ledger.append(workspacePath, actor, 'update', `.workgraph/runs/${run.id}`, 'run', {
    followup: true,
    status: run.status,
  });
  syncRunPrimitive(workspacePath, run, actor);
  return run;
}

export function stop(workspacePath: string, runId: string, actor: string): DispatchRun {
  return setStatus(workspacePath, runId, actor, 'cancelled', 'Run cancelled by operator.');
}

export function markRun(
  workspacePath: string,
  runId: string,
  actor: string,
  nextStatus: Exclude<RunStatus, 'queued'>,
  options: { output?: string; error?: string; contextPatch?: Record<string, unknown> } = {},
): DispatchRun {
  assertDispatchMutationAuthorized(workspacePath, actor, 'dispatch.run.mark', runId, [
    'dispatch:run',
  ]);
  const run = setStatus(workspacePath, runId, actor, nextStatus, `Run moved to ${nextStatus}.`);
  if (options.output) run.output = options.output;
  if (options.error) run.error = options.error;
  if (options.contextPatch && Object.keys(options.contextPatch).length > 0) {
    run.context = {
      ...(run.context ?? {}),
      ...options.contextPatch,
    };
  }
  const state = loadRuns(workspacePath);
  const target = state.runs.find((entry) => entry.id === runId);
  if (target) {
    target.output = run.output;
    target.error = run.error;
    target.context = run.context;
    target.updatedAt = new Date().toISOString();
    saveRuns(workspacePath, state);
    syncRunPrimitive(workspacePath, target, actor);
  }
  return target ?? run;
}

export function heartbeat(
  workspacePath: string,
  runId: string,
  input: DispatchHeartbeatInput,
): DispatchRun {
  assertDispatchMutationAuthorized(workspacePath, input.actor, 'dispatch.run.heartbeat', runId, [
    'dispatch:run',
  ]);
  const state = loadRuns(workspacePath);
  const run = state.runs.find((entry) => entry.id === runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (run.status !== 'running') {
    throw new Error(`Cannot heartbeat run ${runId} in "${run.status}" state. Only running runs may heartbeat.`);
  }

  const now = new Date().toISOString();
  run.heartbeats = [...(run.heartbeats ?? []), now];
  applyLease(run, now, input.leaseMinutes);
  run.updatedAt = now;
  run.logs.push({
    ts: now,
    level: 'info',
    message: `Lease heartbeat from ${input.actor}. Extended until ${run.leaseExpires}.`,
  });

  saveRuns(workspacePath, state);
  ledger.append(workspacePath, input.actor, 'update', `.workgraph/runs/${run.id}`, 'run', {
    heartbeat: true,
    lease_expires: run.leaseExpires,
  });
  syncRunPrimitive(workspacePath, run, input.actor);
  return run;
}

export function reconcileExpiredLeases(
  workspacePath: string,
  actor: string,
): DispatchReconcileResult {
  assertDispatchMutationAuthorized(workspacePath, actor, 'dispatch.run.reconcile', '.workgraph/dispatch-runs', [
    'dispatch:run',
    'policy:manage',
  ]);
  const state = loadRuns(workspacePath);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const requeuedRuns: DispatchRun[] = [];

  for (const run of state.runs) {
    if (run.status !== 'running') continue;
    if (!run.leaseExpires) continue;
    const leaseExpiresMs = Date.parse(run.leaseExpires);
    if (!Number.isFinite(leaseExpiresMs) || leaseExpiresMs > nowMs) continue;

    run.status = 'queued';
    run.updatedAt = nowIso;
    run.logs.push({
      ts: nowIso,
      level: 'warn',
      message: `Lease expired at ${run.leaseExpires}. Run returned to queued.`,
    });
    clearLease(run);
    requeuedRuns.push(run);
  }

  if (requeuedRuns.length > 0) {
    saveRuns(workspacePath, state);
    for (const run of requeuedRuns) {
      ledger.append(workspacePath, actor, 'update', `.workgraph/runs/${run.id}`, 'run', {
        status: run.status,
        reconciled_expired_lease: true,
      });
      syncRunPrimitive(workspacePath, run, actor);
    }
  }

  return {
    reconciledAt: nowIso,
    inspectedRuns: state.runs.length,
    requeuedRuns,
  };
}

export function handoffRun(
  workspacePath: string,
  runId: string,
  input: DispatchHandoffInput,
): DispatchHandoffResult {
  assertDispatchMutationAuthorized(workspacePath, input.actor, 'dispatch.run.handoff', runId, [
    'dispatch:run',
  ]);
  const sourceRun = status(workspacePath, runId);
  const now = new Date().toISOString();
  const handoffContext: Record<string, unknown> = {
    ...(sourceRun.context ?? {}),
    handoff_from_run_id: sourceRun.id,
    handoff_from_actor: sourceRun.actor,
    handoff_initiated_by: input.actor,
    handoff_reason: input.reason,
    handoff_at: now,
  };
  const created = createRun(workspacePath, {
    actor: input.to,
    adapter: input.adapter ?? sourceRun.adapter,
    objective: sourceRun.objective,
    context: handoffContext,
  });

  appendRunLogs(workspacePath, sourceRun.id, input.actor, [{
    ts: now,
    level: 'info',
    message: `Run handed off to ${input.to} as ${created.id}. Reason: ${input.reason}`,
  }]);
  appendRunLogs(workspacePath, created.id, input.actor, [{
    ts: now,
    level: 'info',
    message: `Handoff received from ${sourceRun.id} by ${input.actor}. Reason: ${input.reason}`,
  }]);
  ledger.append(workspacePath, input.actor, 'handoff', `.workgraph/runs/${sourceRun.id}`, 'run', {
    from_run_id: sourceRun.id,
    to_run_id: created.id,
    to_actor: input.to,
    reason: input.reason,
  });

  return {
    sourceRun: status(workspacePath, sourceRun.id),
    handoffRun: status(workspacePath, created.id),
  };
}

export function logs(workspacePath: string, runId: string): DispatchRun['logs'] {
  return status(workspacePath, runId).logs;
}

export function listRuns(workspacePath: string, options: { status?: RunStatus; limit?: number } = {}): DispatchRun[] {
  const runs = loadRuns(workspacePath).runs
    .filter((run) => (options.status ? run.status === options.status : true))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (options.limit && options.limit > 0) {
    return runs.slice(0, options.limit);
  }
  return runs;
}

export async function executeRun(
  workspacePath: string,
  runId: string,
  input: DispatchExecuteInput,
): Promise<DispatchRun> {
  assertDispatchMutationAuthorized(workspacePath, input.actor, 'dispatch.run.execute', runId, [
    'dispatch:run',
  ]);
  const existing = status(workspacePath, runId);
  if (!['queued', 'running'].includes(existing.status)) {
    throw new Error(`Run ${runId} is in terminal status "${existing.status}" and cannot be executed.`);
  }

  const adapter = resolveDispatchAdapter(existing.adapter);
  if (!adapter.execute) {
    throw new Error(`Dispatch adapter "${existing.adapter}" does not implement execute().`);
  }

  if (existing.status === 'queued') {
    setStatus(workspacePath, runId, input.actor, 'running', `Run started on adapter "${existing.adapter}".`);
  }

  const execution = await adapter.execute({
    workspacePath,
    runId,
    actor: input.actor,
    objective: existing.objective,
    context: existing.context,
    agents: input.agents,
    maxSteps: input.maxSteps,
    stepDelayMs: input.stepDelayMs,
    space: input.space,
    createCheckpoint: input.createCheckpoint,
    isCancelled: () => status(workspacePath, runId).status === 'cancelled',
  });

  appendRunLogs(workspacePath, runId, input.actor, execution.logs);

  const finalStatus = execution.status;
  if (finalStatus === 'queued' || finalStatus === 'running') {
    throw new Error(`Adapter returned invalid terminal status "${finalStatus}" for execute().`);
  }

  return markRun(workspacePath, runId, input.actor, finalStatus, {
    output: execution.output,
    error: execution.error,
    contextPatch: execution.metrics
      ? { adapter_metrics: execution.metrics }
      : undefined,
  });
}

export async function createAndExecuteRun(
  workspacePath: string,
  createInput: DispatchCreateInput,
  executeInput: Omit<DispatchExecuteInput, 'actor'> = {},
): Promise<DispatchRun> {
  const run = createRun(workspacePath, createInput);
  return executeRun(workspacePath, run.id, {
    actor: createInput.actor,
    ...executeInput,
  });
}

function appendRunLogs(
  workspacePath: string,
  runId: string,
  actor: string,
  logEntries: DispatchAdapterLogEntry[],
): void {
  assertDispatchMutationAuthorized(workspacePath, actor, 'dispatch.run.logs', runId, [
    'dispatch:run',
  ]);
  if (logEntries.length === 0) return;
  const state = loadRuns(workspacePath);
  const run = state.runs.find((entry) => entry.id === runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  run.logs.push(...logEntries);
  run.updatedAt = new Date().toISOString();
  saveRuns(workspacePath, state);
  ledger.append(workspacePath, actor, 'update', `.workgraph/runs/${run.id}`, 'run', {
    log_append_count: logEntries.length,
  });
  syncRunPrimitive(workspacePath, run, actor);
}

function setStatus(
  workspacePath: string,
  runId: string,
  actor: string,
  statusValue: RunStatus,
  logMessage: string,
): DispatchRun {
  assertDispatchMutationAuthorized(workspacePath, actor, 'dispatch.run.status', runId, [
    'dispatch:run',
  ]);
  const state = loadRuns(workspacePath);
  const run = state.runs.find((entry) => entry.id === runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  assertRunStatusTransition(run.status, statusValue, runId);
  const now = new Date().toISOString();
  run.status = statusValue;
  if (statusValue === 'running') {
    applyLease(run, now);
  } else {
    clearLease(run);
  }
  run.updatedAt = now;
  run.logs.push({ ts: now, level: 'info', message: logMessage });
  saveRuns(workspacePath, state);
  ledger.append(workspacePath, actor, 'update', `.workgraph/runs/${run.id}`, 'run', {
    status: run.status,
  });
  syncRunPrimitive(workspacePath, run, actor);
  return run;
}

function runsPath(workspacePath: string): string {
  return path.join(workspacePath, RUNS_FILE);
}

function loadRuns(workspacePath: string): { version: number; runs: DispatchRun[] } {
  const rPath = runsPath(workspacePath);
  if (!fs.existsSync(rPath)) {
    const seeded = { version: 1, runs: [] as DispatchRun[] };
    saveRuns(workspacePath, seeded);
    return seeded;
  }
  const raw = fs.readFileSync(rPath, 'utf-8');
  const parsed = JSON.parse(raw) as { version: number; runs: DispatchRun[] };
  return {
    version: parsed.version ?? 1,
    runs: (parsed.runs ?? []).map(hydrateRun),
  };
}

function saveRuns(workspacePath: string, value: { version: number; runs: DispatchRun[] }): void {
  const rPath = runsPath(workspacePath);
  const dir = path.dirname(rPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(rPath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

function getRun(workspacePath: string, runId: string): DispatchRun | null {
  const state = loadRuns(workspacePath);
  return state.runs.find((run) => run.id === runId) ?? null;
}

function ensureRunPrimitive(workspacePath: string, run: DispatchRun, actor: string): void {
  const safeTitle = `${run.objective} (${run.id.slice(0, 8)})`;
  const runPrimitivePath = `runs/${run.id}.md`;
  const existing = store.read(workspacePath, runPrimitivePath);
  if (existing) return;
  store.create(
    workspacePath,
    'run',
    {
      title: safeTitle,
      objective: run.objective,
      runtime: run.adapter,
      status: run.status,
      run_id: run.id,
      owner: run.actor,
      lease_expires: run.leaseExpires,
      lease_duration_minutes: run.leaseDurationMinutes,
      last_heartbeat: latestHeartbeat(run),
      heartbeat_timestamps: run.heartbeats ?? [],
      tags: ['dispatch'],
    },
    `## Objective\n\n${run.objective}\n`,
    actor,
    { pathOverride: runPrimitivePath },
  );
}

function syncRunPrimitive(workspacePath: string, run: DispatchRun, actor: string): void {
  const runs = store.list(workspacePath, 'run');
  const existing = runs.find((entry) => String(entry.fields.run_id) === run.id);
  if (!existing) return;
  store.update(
    workspacePath,
    existing.path,
    {
      status: run.status,
      runtime: run.adapter,
      objective: run.objective,
      owner: run.actor,
      lease_expires: run.leaseExpires,
      lease_duration_minutes: run.leaseDurationMinutes,
      last_heartbeat: latestHeartbeat(run),
      heartbeat_timestamps: run.heartbeats ?? [],
    },
    renderRunBody(run),
    actor,
  );
}

function renderRunBody(run: DispatchRun): string {
  const lines = [
    '## Objective',
    '',
    run.objective,
    '',
    '## Status',
    '',
    run.status,
    '',
    '## Lease',
    '',
    run.leaseExpires
      ? `expires: ${run.leaseExpires} (${run.leaseDurationMinutes ?? DEFAULT_LEASE_MINUTES} min lease)`
      : 'none',
    '',
    '## Logs',
    '',
    ...run.logs.slice(-20).map((entry) => `- ${entry.ts} [${entry.level}] ${entry.message}`),
    '',
  ];
  if ((run.heartbeats ?? []).length > 0) {
    lines.push('## Heartbeats');
    lines.push('');
    lines.push(...(run.heartbeats ?? []).slice(-20).map((ts) => `- ${ts}`));
    lines.push('');
  }
  if (run.output) {
    lines.push('## Output');
    lines.push('');
    lines.push(run.output);
    lines.push('');
  }
  if (run.error) {
    lines.push('## Error');
    lines.push('');
    lines.push(run.error);
    lines.push('');
  }
  if (run.context && Object.keys(run.context).length > 0) {
    lines.push('## Context');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(run.context, null, 2));
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

function hydrateRun(run: DispatchRun): DispatchRun {
  return {
    ...run,
    leaseDurationMinutes: normalizeLeaseMinutes(run.leaseDurationMinutes),
    heartbeats: Array.isArray(run.heartbeats) ? run.heartbeats : [],
  };
}

function normalizeLeaseMinutes(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  return DEFAULT_LEASE_MINUTES;
}

function applyLease(run: DispatchRun, nowIso: string, requestedLeaseMinutes?: number): void {
  const leaseMinutes = normalizeLeaseMinutes(requestedLeaseMinutes ?? run.leaseDurationMinutes);
  const expiresAt = new Date(Date.parse(nowIso) + leaseMinutes * 60_000).toISOString();
  run.leaseDurationMinutes = leaseMinutes;
  run.leaseExpires = expiresAt;
}

function clearLease(run: DispatchRun): void {
  run.leaseExpires = undefined;
}

function latestHeartbeat(run: DispatchRun): string | undefined {
  const heartbeats = run.heartbeats ?? [];
  return heartbeats.length > 0 ? heartbeats[heartbeats.length - 1] : undefined;
}

const RUN_STATUS_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  queued: ['running', 'cancelled'],
  running: ['queued', 'succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

function assertRunStatusTransition(from: RunStatus, to: RunStatus, runId: string): void {
  if (from === to) return;
  const allowed = RUN_STATUS_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid run transition for ${runId}: ${from} -> ${to}. Allowed: ${allowed.join(', ') || 'none'}.`);
  }
}

function resolveThreadRef(threadRef: string): string {
  const raw = String(threadRef ?? '').trim();
  const unwrapped = raw.startsWith('[[') && raw.endsWith(']]')
    ? raw.slice(2, -2)
    : raw;
  if (!unwrapped) {
    throw new Error('Thread reference is required.');
  }
  if (unwrapped.includes('/')) {
    return unwrapped.endsWith('.md') ? unwrapped : `${unwrapped}.md`;
  }
  return `threads/${unwrapped.endsWith('.md') ? unwrapped : `${unwrapped}.md`}`;
}

function assertDispatchMutationAuthorized(
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
      module: 'dispatch',
    },
  });
}
