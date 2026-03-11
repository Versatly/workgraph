/**
 * Runtime dispatch contract with adapter-backed execution.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as auth from './auth.js';
import * as ledger from './ledger.js';
import * as store from './store.js';
import * as thread from './thread.js';
import * as gate from './gate.js';
import {
  appendDispatchRunAuditEvent,
  listDispatchRunAuditEvents,
} from './dispatch-run-audit.js';
import {
  captureWorkspaceGitState,
  collectDispatchExternalCorrelationEvidence,
  collectDispatchExecutionEvidence,
} from './dispatch-run-evidence.js';
import {
  findDispatchBrokerState,
  hydrateRunWithDispatchBrokerState,
  isBrokeredRun,
  listDispatchBrokerStates,
  mergeDispatchTracking,
  mergeExternalIdentity,
  normalizeDispatchTracking,
  normalizeExternalIdentity,
  readDispatchBrokerState,
  updateDispatchBrokerState,
} from './dispatch/external-run-state.js';
import { resolveDispatchAdapter } from './runtime-adapter-registry.js';
import {
  ConflictError,
  InputValidationError,
  ResourceNotFoundError,
  asWorkgraphError,
} from './errors.js';
import { atomicWriteFile, withFileLock } from './fs-reliability.js';
import {
  validateActorName,
  validateIdempotencyKey,
  validateObjective,
  validateRunId,
  validateWorkspacePath,
} from './validation.js';
import type {
  DispatchAdapterCancelInput,
  DispatchAdapterDispatchInput,
  DispatchAdapterExternalIdentity,
  DispatchAdapterExternalUpdate,
  DispatchAdapterLogEntry,
} from './runtime-adapter-contracts.js';
import type {
  DispatchRun,
  DispatchRunAuditEvent,
  DispatchRunDispatchTracking,
  DispatchRunEvidenceItem,
  DispatchRunExternalIdentity,
  PrimitiveInstance,
  RunStatus,
} from './types.js';

const RUNS_FILE = '.workgraph/dispatch-runs.json';
const DEFAULT_LEASE_MINUTES = 30;
const DEFAULT_EXECUTE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS = 60_000;
const RUNS_LOCK_SCOPE = 'dispatch-runs-state';

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
  timeoutMs?: number;
  dispatchMode?: 'direct' | 'self-assembly';
  selfAssemblyAgent?: string;
  selfAssemblyOptions?: Record<string, unknown>;
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

export interface DispatchRetryInput {
  actor: string;
  adapter?: string;
  objective?: string;
  contextPatch?: Record<string, unknown>;
  execute?: boolean;
  agents?: string[];
  maxSteps?: number;
  stepDelayMs?: number;
  space?: string;
  createCheckpoint?: boolean;
  timeoutMs?: number;
  dispatchMode?: 'direct' | 'self-assembly';
  selfAssemblyAgent?: string;
  selfAssemblyOptions?: Record<string, unknown>;
}

export interface DispatchStateRecoveryResult {
  repairedAt: string;
  scannedRuns: number;
  repairedRuns: DispatchRun[];
  removedCorruptRuns: number;
  warnings: string[];
}

export interface DispatchExternalReconcileInput {
  actor: string;
  runId?: string;
  provider?: string;
  externalRunId?: string;
  correlationKeys?: string[];
  status?: RunStatus;
  output?: string;
  error?: string;
  acknowledged?: boolean;
  acknowledgedAt?: string;
  external?: DispatchRunExternalIdentity;
  metadata?: Record<string, unknown>;
  logs?: DispatchAdapterLogEntry[];
  source?: 'dispatch' | 'poll' | 'event' | 'cancel';
  ts?: string;
}

export interface DispatchExternalReconcileResult {
  reconciledAt: string;
  matchedRunId?: string;
  statusChanged: boolean;
  previousStatus?: RunStatus;
  currentStatus?: RunStatus;
  run?: DispatchRun;
}

export interface DispatchPollExternalRunsResult {
  reconciledAt: string;
  inspectedRuns: number;
  reconciledRuns: DispatchRun[];
  failures: Array<{
    runId: string;
    error: string;
  }>;
}

function withDispatchOperation<T>(
  operation: string,
  context: {
    workspacePath?: string;
    runId?: string;
    actor?: string;
    threadPath?: string;
  },
  fn: () => T,
): T {
  try {
    return fn();
  } catch (error) {
    throw asWorkgraphError(error, `Dispatch operation failed: ${operation}`, {
      operation,
      workspacePath: context.workspacePath,
      runId: context.runId,
      actor: context.actor,
      threadPath: context.threadPath,
    });
  }
}

async function withDispatchOperationAsync<T>(
  operation: string,
  context: {
    workspacePath?: string;
    runId?: string;
    actor?: string;
    threadPath?: string;
  },
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw asWorkgraphError(error, `Dispatch operation failed: ${operation}`, {
      operation,
      workspacePath: context.workspacePath,
      runId: context.runId,
      actor: context.actor,
      threadPath: context.threadPath,
    });
  }
}

function withRunsMutation<T>(workspacePath: string, fn: (state: { version: number; runs: DispatchRun[] }) => T): T {
  return withFileLock(workspacePath, RUNS_LOCK_SCOPE, () => {
    const state = loadRuns(workspacePath);
    const result = fn(state);
    saveRuns(workspacePath, state);
    return result;
  });
}

function appendDispatchRunAuditEventSafe(
  workspacePath: string,
  payload: Parameters<typeof appendDispatchRunAuditEvent>[1],
  options: {
    runId?: string;
    actor?: string;
    operation?: string;
  } = {},
): void {
  try {
    appendDispatchRunAuditEvent(workspacePath, payload);
  } catch (error) {
    logDispatchWarning(
      `Audit event append failed${options.operation ? ` during ${options.operation}` : ''}.`,
      error,
      {
        runId: options.runId ?? payload.runId,
        actor: options.actor ?? payload.actor,
      },
    );
  }
}

function appendLedgerEventSafe(
  workspacePath: string,
  actor: string,
  op: 'create' | 'update' | 'handoff',
  target: string,
  type: string,
  data?: Record<string, unknown>,
): void {
  try {
    ledger.append(workspacePath, actor, op, target, type, data);
  } catch (error) {
    logDispatchWarning('Ledger append failed for non-critical dispatch telemetry.', error, {
      actor,
      runId: target.replace('.workgraph/runs/', ''),
    });
  }
}

function ensureRunPrimitiveSafe(workspacePath: string, run: DispatchRun, actor: string): void {
  try {
    ensureRunPrimitive(workspacePath, run, actor);
  } catch (error) {
    logDispatchWarning('Run primitive creation failed; continuing dispatch operation.', error, {
      runId: run.id,
      actor,
    });
  }
}

function syncRunPrimitiveSafe(workspacePath: string, run: DispatchRun, actor: string): void {
  try {
    syncRunPrimitive(workspacePath, run, actor);
  } catch (error) {
    logDispatchWarning('Run primitive sync failed; continuing dispatch operation.', error, {
      runId: run.id,
      actor,
    });
  }
}

function validatedWorkspacePath(workspacePath: string, operation: string): string {
  return validateWorkspacePath(workspacePath, { workspacePath, operation });
}

export function createRun(workspacePath: string, input: DispatchCreateInput): DispatchRun {
  const safeWorkspacePath = validatedWorkspacePath(workspacePath, 'dispatch.run.create');
  const safeActor = validateActorName(input.actor, {
    workspacePath: safeWorkspacePath,
    actor: input.actor,
    operation: 'dispatch.run.create',
  });
  const safeObjective = validateObjective(input.objective, {
    workspacePath: safeWorkspacePath,
    actor: safeActor,
    operation: 'dispatch.run.create',
  });
  const safeIdempotencyKey = validateIdempotencyKey(input.idempotencyKey, {
    workspacePath: safeWorkspacePath,
    actor: safeActor,
    operation: 'dispatch.run.create',
  });
  return withDispatchOperation('dispatch.run.create', {
    workspacePath: safeWorkspacePath,
    actor: safeActor,
  }, () => {
    assertDispatchMutationAuthorized(safeWorkspacePath, safeActor, 'dispatch.run.create', '.workgraph/dispatch-runs', [
      'dispatch:run',
    ]);
    const result = withRunsMutation(safeWorkspacePath, (state) => {
      if (safeIdempotencyKey) {
        const existing = state.runs.find((run) => run.idempotencyKey === safeIdempotencyKey);
        if (existing) {
          return {
            run: existing,
            idempotencyHit: true,
          };
        }
      }
      const now = new Date().toISOString();
      const run: DispatchRun = {
        id: `run_${randomUUID()}`,
        createdAt: now,
        updatedAt: now,
        actor: safeActor,
        adapter: input.adapter ?? 'cursor-cloud',
        objective: safeObjective,
        status: 'queued',
        leaseDurationMinutes: DEFAULT_LEASE_MINUTES,
        heartbeats: [],
        idempotencyKey: safeIdempotencyKey,
        context: input.context,
        followups: [],
        logs: [
          { ts: now, level: 'info', message: `Run created for objective: ${safeObjective}` },
        ],
      };
      state.runs.push(run);
      return {
        run,
        idempotencyHit: false,
      };
    });

    if (result.idempotencyHit) {
      appendDispatchRunAuditEventSafe(safeWorkspacePath, {
        runId: result.run.id,
        actor: safeActor,
        kind: 'run-idempotency-hit',
        data: {
          idempotency_key: safeIdempotencyKey,
        },
      }, {
        runId: result.run.id,
        actor: safeActor,
        operation: 'dispatch.run.create.idempotency',
      });
      return hydrateRunWithRuntimeMetadata(safeWorkspacePath, result.run);
    }

    appendDispatchRunAuditEventSafe(safeWorkspacePath, {
      runId: result.run.id,
      actor: safeActor,
      kind: 'run-created',
      data: {
        adapter: result.run.adapter,
        objective: result.run.objective,
        status: result.run.status,
        idempotency_key: result.run.idempotencyKey,
      },
    }, {
      runId: result.run.id,
      actor: safeActor,
      operation: 'dispatch.run.create',
    });
    appendLedgerEventSafe(safeWorkspacePath, safeActor, 'create', `.workgraph/runs/${result.run.id}`, 'run', {
      adapter: result.run.adapter,
      objective: result.run.objective,
      status: result.run.status,
    });
    ensureRunPrimitiveSafe(safeWorkspacePath, result.run, safeActor);
    return hydrateRunWithRuntimeMetadata(safeWorkspacePath, result.run);
  });
}

export function claimThread(workspacePath: string, threadRef: string, actor: string): DispatchClaimResult {
  const safeWorkspacePath = validatedWorkspacePath(workspacePath, 'dispatch.thread.claim');
  const safeActor = validateActorName(actor, {
    workspacePath: safeWorkspacePath,
    actor,
    operation: 'dispatch.thread.claim',
  });
  return withDispatchOperation('dispatch.thread.claim', {
    workspacePath: safeWorkspacePath,
    actor: safeActor,
  }, () => {
    assertDispatchMutationAuthorized(safeWorkspacePath, safeActor, 'dispatch.thread.claim', threadRef, [
      'thread:claim',
      'thread:manage',
    ]);
    const threadPath = resolveThreadRef(threadRef);
    const gateCheck = gate.checkThreadGates(safeWorkspacePath, threadPath);
    if (!gateCheck.allowed) {
      throw new ConflictError(gate.summarizeGateFailures(gateCheck), {
        workspacePath: safeWorkspacePath,
        threadPath,
        actor: safeActor,
        operation: 'dispatch.thread.claim',
      });
    }
    const claimedThread = thread.claim(safeWorkspacePath, threadPath, safeActor);
    return {
      thread: claimedThread,
      gateCheck,
    };
  });
}

export function status(workspacePath: string, runId: string): DispatchRun {
  const safeWorkspacePath = validatedWorkspacePath(workspacePath, 'dispatch.run.status');
  const safeRunId = validateRunId(runId, {
    workspacePath: safeWorkspacePath,
    runId,
    operation: 'dispatch.run.status',
  });
  return withDispatchOperation('dispatch.run.status', {
    workspacePath: safeWorkspacePath,
    runId: safeRunId,
  }, () => {
    const run = getRun(safeWorkspacePath, safeRunId);
    if (!run) {
      throw new ResourceNotFoundError(`Run not found: ${safeRunId}`, {
        workspacePath: safeWorkspacePath,
        runId: safeRunId,
        operation: 'dispatch.run.status',
      });
    }
    return hydrateRunWithRuntimeMetadata(safeWorkspacePath, run);
  });
}

export function followup(workspacePath: string, runId: string, actor: string, input: string): DispatchRun {
  const safeWorkspacePath = validatedWorkspacePath(workspacePath, 'dispatch.run.followup');
  const safeRunId = validateRunId(runId, {
    workspacePath: safeWorkspacePath,
    runId,
    operation: 'dispatch.run.followup',
  });
  const safeActor = validateActorName(actor, {
    workspacePath: safeWorkspacePath,
    runId: safeRunId,
    actor,
    operation: 'dispatch.run.followup',
  });
  const safeInput = String(input ?? '').trim();
  if (!safeInput) {
    throw new InputValidationError('Follow-up input must be a non-empty string.', {
      workspacePath: safeWorkspacePath,
      runId: safeRunId,
      actor: safeActor,
      operation: 'dispatch.run.followup',
    });
  }
  return withDispatchOperation('dispatch.run.followup', {
    workspacePath: safeWorkspacePath,
    runId: safeRunId,
    actor: safeActor,
  }, () => {
    assertDispatchMutationAuthorized(safeWorkspacePath, safeActor, 'dispatch.run.followup', safeRunId, [
      'dispatch:run',
    ]);
    const run = withRunsMutation(safeWorkspacePath, (state) => {
      const target = state.runs.find((entry) => entry.id === safeRunId);
      if (!target) {
        throw new ResourceNotFoundError(`Run not found: ${safeRunId}`, {
          workspacePath: safeWorkspacePath,
          runId: safeRunId,
          actor: safeActor,
          operation: 'dispatch.run.followup',
        });
      }
      if (!['queued', 'running'].includes(target.status)) {
        throw new ConflictError(
          `Cannot send follow-up to run ${safeRunId} in terminal status "${target.status}".`,
          {
            workspacePath: safeWorkspacePath,
            runId: safeRunId,
            actor: safeActor,
            operation: 'dispatch.run.followup',
          },
        );
      }
      const now = new Date().toISOString();
      target.followups.push({ ts: now, actor: safeActor, input: safeInput });
      target.updatedAt = now;
      target.logs.push({
        ts: now,
        level: 'info',
        message: `Follow-up from ${safeActor}: ${safeInput}`,
      });
      return target;
    });
    appendDispatchRunAuditEventSafe(safeWorkspacePath, {
      runId: run.id,
      actor: safeActor,
      kind: 'run-followup',
      data: {
        input: safeInput,
        status: run.status,
      },
    }, {
      runId: run.id,
      actor: safeActor,
      operation: 'dispatch.run.followup',
    });
    appendLedgerEventSafe(safeWorkspacePath, safeActor, 'update', `.workgraph/runs/${run.id}`, 'run', {
      followup: true,
      status: run.status,
    });
    syncRunPrimitiveSafe(safeWorkspacePath, run, safeActor);
    return hydrateRunWithRuntimeMetadata(safeWorkspacePath, run);
  });
}

export function stop(workspacePath: string, runId: string, actor: string): DispatchRun {
  const safeWorkspacePath = validatedWorkspacePath(workspacePath, 'dispatch.run.stop');
  const safeRunId = validateRunId(runId, {
    workspacePath: safeWorkspacePath,
    runId,
    operation: 'dispatch.run.stop',
  });
  const safeActor = validateActorName(actor, {
    workspacePath: safeWorkspacePath,
    runId: safeRunId,
    actor,
    operation: 'dispatch.run.stop',
  });
  return withDispatchOperation('dispatch.run.stop', {
    workspacePath: safeWorkspacePath,
    runId: safeRunId,
    actor: safeActor,
  }, () => {
    const run = status(safeWorkspacePath, safeRunId);
    if (wantsExternalBroker(run)) {
      return requestBrokeredRunCancellation(safeWorkspacePath, run, safeActor);
    }
    return setStatus(safeWorkspacePath, safeRunId, safeActor, 'cancelled', 'Run cancelled by operator.');
  });
}

export function markRun(
  workspacePath: string,
  runId: string,
  actor: string,
  nextStatus: Exclude<RunStatus, 'queued'>,
  options: { output?: string; error?: string; contextPatch?: Record<string, unknown> } = {},
): DispatchRun {
  const safeWorkspacePath = validatedWorkspacePath(workspacePath, 'dispatch.run.mark');
  const safeRunId = validateRunId(runId, {
    workspacePath: safeWorkspacePath,
    runId,
    operation: 'dispatch.run.mark',
  });
  const safeActor = validateActorName(actor, {
    workspacePath: safeWorkspacePath,
    runId: safeRunId,
    actor,
    operation: 'dispatch.run.mark',
  });
  return withDispatchOperation('dispatch.run.mark', {
    workspacePath: safeWorkspacePath,
    runId: safeRunId,
    actor: safeActor,
  }, () => {
    assertDispatchMutationAuthorized(safeWorkspacePath, safeActor, 'dispatch.run.mark', safeRunId, [
      'dispatch:run',
    ]);
    const run = setStatus(safeWorkspacePath, safeRunId, safeActor, nextStatus, `Run moved to ${nextStatus}.`);
    if (options.output) run.output = options.output;
    if (options.error) run.error = options.error;
    if (options.contextPatch && Object.keys(options.contextPatch).length > 0) {
      run.context = {
        ...(run.context ?? {}),
        ...options.contextPatch,
      };
    }
    const target = withRunsMutation(safeWorkspacePath, (state) => {
      const entry = state.runs.find((candidate) => candidate.id === safeRunId);
      if (!entry) return null;
      entry.output = run.output;
      entry.error = run.error;
      entry.context = run.context;
      entry.updatedAt = new Date().toISOString();
      return entry;
    });
    if (target) {
      appendDispatchRunAuditEventSafe(safeWorkspacePath, {
        runId: target.id,
        actor: safeActor,
        kind: 'run-marked',
        data: {
          status: target.status,
          has_output: Boolean(target.output),
          has_error: Boolean(target.error),
          context_keys: Object.keys(target.context ?? {}),
        },
      }, {
        runId: target.id,
        actor: safeActor,
        operation: 'dispatch.run.mark',
      });
      syncRunPrimitiveSafe(safeWorkspacePath, target, safeActor);
    }
    return hydrateRunWithRuntimeMetadata(safeWorkspacePath, target ?? run);
  });
}

export function heartbeat(
  workspacePath: string,
  runId: string,
  input: DispatchHeartbeatInput,
): DispatchRun {
  const safeWorkspacePath = validatedWorkspacePath(workspacePath, 'dispatch.run.heartbeat');
  const safeRunId = validateRunId(runId, {
    workspacePath: safeWorkspacePath,
    runId,
    operation: 'dispatch.run.heartbeat',
  });
  const safeActor = validateActorName(input.actor, {
    workspacePath: safeWorkspacePath,
    runId: safeRunId,
    actor: input.actor,
    operation: 'dispatch.run.heartbeat',
  });
  return withDispatchOperation('dispatch.run.heartbeat', {
    workspacePath: safeWorkspacePath,
    runId: safeRunId,
    actor: safeActor,
  }, () => {
    assertDispatchMutationAuthorized(safeWorkspacePath, safeActor, 'dispatch.run.heartbeat', safeRunId, [
      'dispatch:run',
    ]);
    const run = withRunsMutation(safeWorkspacePath, (state) => {
      const target = state.runs.find((entry) => entry.id === safeRunId);
      if (!target) {
        throw new ResourceNotFoundError(`Run not found: ${safeRunId}`, {
          workspacePath: safeWorkspacePath,
          runId: safeRunId,
          actor: safeActor,
          operation: 'dispatch.run.heartbeat',
        });
      }
      if (target.status !== 'running') {
        throw new ConflictError(
          `Cannot heartbeat run ${safeRunId} in "${target.status}" state. Only running runs may heartbeat.`,
          {
            workspacePath: safeWorkspacePath,
            runId: safeRunId,
            actor: safeActor,
            operation: 'dispatch.run.heartbeat',
          },
        );
      }

      const now = new Date().toISOString();
      target.heartbeats = [...(target.heartbeats ?? []), now];
      applyLease(target, now, input.leaseMinutes);
      target.updatedAt = now;
      target.logs.push({
        ts: now,
        level: 'info',
        message: `Lease heartbeat from ${safeActor}. Extended until ${target.leaseExpires}.`,
      });
      return target;
    });
    appendDispatchRunAuditEventSafe(safeWorkspacePath, {
      runId: run.id,
      actor: safeActor,
      kind: 'run-heartbeat',
      data: {
        lease_expires: run.leaseExpires,
        lease_duration_minutes: run.leaseDurationMinutes,
        heartbeat_count: run.heartbeats?.length ?? 0,
      },
    }, {
      runId: run.id,
      actor: safeActor,
      operation: 'dispatch.run.heartbeat',
    });
    appendLedgerEventSafe(safeWorkspacePath, safeActor, 'update', `.workgraph/runs/${run.id}`, 'run', {
      heartbeat: true,
      lease_expires: run.leaseExpires,
    });
    syncRunPrimitiveSafe(safeWorkspacePath, run, safeActor);
    return hydrateRunWithRuntimeMetadata(safeWorkspacePath, run);
  });
}

export function reconcileExpiredLeases(
  workspacePath: string,
  actor: string,
): DispatchReconcileResult {
  const safeWorkspacePath = validatedWorkspacePath(workspacePath, 'dispatch.run.reconcile');
  const safeActor = validateActorName(actor, {
    workspacePath: safeWorkspacePath,
    actor,
    operation: 'dispatch.run.reconcile',
  });
  return withDispatchOperation('dispatch.run.reconcile', {
    workspacePath: safeWorkspacePath,
    actor: safeActor,
  }, () => {
    assertDispatchMutationAuthorized(safeWorkspacePath, safeActor, 'dispatch.run.reconcile', '.workgraph/dispatch-runs', [
      'dispatch:run',
      'policy:manage',
    ]);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const requeuedRuns = withRunsMutation(safeWorkspacePath, (state) => {
      const requeued: DispatchRun[] = [];
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
        requeued.push(run);
      }
      return requeued;
    });
    for (const run of requeuedRuns) {
      appendDispatchRunAuditEventSafe(safeWorkspacePath, {
        runId: run.id,
        actor: safeActor,
        kind: 'run-status-changed',
        data: {
          from_status: 'running',
          to_status: 'queued',
          reason: 'lease-expired',
        },
      }, {
        runId: run.id,
        actor: safeActor,
        operation: 'dispatch.run.reconcile',
      });
      appendLedgerEventSafe(safeWorkspacePath, safeActor, 'update', `.workgraph/runs/${run.id}`, 'run', {
        status: run.status,
        reconciled_expired_lease: true,
      });
      syncRunPrimitiveSafe(safeWorkspacePath, run, safeActor);
    }

    return {
      reconciledAt: nowIso,
      inspectedRuns: loadRuns(safeWorkspacePath).runs.length,
      requeuedRuns,
    };
  });
}

export function handoffRun(
  workspacePath: string,
  runId: string,
  input: DispatchHandoffInput,
): DispatchHandoffResult {
  const safeWorkspacePath = validatedWorkspacePath(workspacePath, 'dispatch.run.handoff');
  const safeRunId = validateRunId(runId, {
    workspacePath: safeWorkspacePath,
    runId,
    operation: 'dispatch.run.handoff',
  });
  const safeActor = validateActorName(input.actor, {
    workspacePath: safeWorkspacePath,
    runId: safeRunId,
    actor: input.actor,
    operation: 'dispatch.run.handoff',
  });
  const safeToActor = validateActorName(input.to, {
    workspacePath: safeWorkspacePath,
    runId: safeRunId,
    actor: input.to,
    operation: 'dispatch.run.handoff',
  });
  const safeReason = String(input.reason ?? '').trim();
  if (!safeReason) {
    throw new InputValidationError('Handoff reason is required.', {
      workspacePath: safeWorkspacePath,
      runId: safeRunId,
      actor: safeActor,
      operation: 'dispatch.run.handoff',
    });
  }
  return withDispatchOperation('dispatch.run.handoff', {
    workspacePath: safeWorkspacePath,
    runId: safeRunId,
    actor: safeActor,
  }, () => {
    assertDispatchMutationAuthorized(safeWorkspacePath, safeActor, 'dispatch.run.handoff', safeRunId, [
      'dispatch:run',
    ]);
    const sourceRun = status(safeWorkspacePath, safeRunId);
    const now = new Date().toISOString();
    const handoffContext: Record<string, unknown> = {
      ...(sourceRun.context ?? {}),
      handoff_from_run_id: sourceRun.id,
      handoff_from_actor: sourceRun.actor,
      handoff_initiated_by: safeActor,
      handoff_reason: safeReason,
      handoff_at: now,
    };
    const created = createRun(safeWorkspacePath, {
      actor: safeToActor,
      adapter: input.adapter ?? sourceRun.adapter,
      objective: sourceRun.objective,
      context: handoffContext,
    });

    appendRunLogs(safeWorkspacePath, sourceRun.id, safeActor, [{
      ts: now,
      level: 'info',
      message: `Run handed off to ${safeToActor} as ${created.id}. Reason: ${safeReason}`,
    }]);
    appendRunLogs(safeWorkspacePath, created.id, safeActor, [{
      ts: now,
      level: 'info',
      message: `Handoff received from ${sourceRun.id} by ${safeActor}. Reason: ${safeReason}`,
    }]);
    appendLedgerEventSafe(safeWorkspacePath, safeActor, 'handoff', `.workgraph/runs/${sourceRun.id}`, 'run', {
      from_run_id: sourceRun.id,
      to_run_id: created.id,
      to_actor: safeToActor,
      reason: safeReason,
    });
    appendDispatchRunAuditEventSafe(safeWorkspacePath, {
      runId: sourceRun.id,
      actor: safeActor,
      kind: 'run-handoff',
      data: {
        to_run_id: created.id,
        to_actor: safeToActor,
        reason: safeReason,
      },
    }, {
      runId: sourceRun.id,
      actor: safeActor,
      operation: 'dispatch.run.handoff',
    });
    appendDispatchRunAuditEventSafe(safeWorkspacePath, {
      runId: created.id,
      actor: safeActor,
      kind: 'run-handoff',
      data: {
        from_run_id: sourceRun.id,
        from_actor: sourceRun.actor,
        reason: safeReason,
      },
    }, {
      runId: created.id,
      actor: safeActor,
      operation: 'dispatch.run.handoff',
    });

    return {
      sourceRun: status(safeWorkspacePath, sourceRun.id),
      handoffRun: status(safeWorkspacePath, created.id),
    };
  });
}

export function logs(workspacePath: string, runId: string): DispatchRun['logs'] {
  return status(workspacePath, runId).logs;
}

export function auditTrail(workspacePath: string, runId: string): DispatchRunAuditEvent[] {
  const safeWorkspacePath = validatedWorkspacePath(workspacePath, 'dispatch.run.audit');
  const safeRunId = validateRunId(runId, {
    workspacePath: safeWorkspacePath,
    runId,
    operation: 'dispatch.run.audit',
  });
  return withDispatchOperation('dispatch.run.audit', {
    workspacePath: safeWorkspacePath,
    runId: safeRunId,
  }, () => {
    const run = status(safeWorkspacePath, safeRunId);
    try {
      return listDispatchRunAuditEvents(safeWorkspacePath, run.id);
    } catch (error) {
      logDispatchWarning('Audit trail listing failed; returning an empty trail.', error, { runId: run.id });
      return [];
    }
  });
}

export function listRunEvidence(workspacePath: string, runId: string): DispatchRunEvidenceItem[] {
  const safeWorkspacePath = validatedWorkspacePath(workspacePath, 'dispatch.run.evidence');
  const safeRunId = validateRunId(runId, {
    workspacePath: safeWorkspacePath,
    runId,
    operation: 'dispatch.run.evidence',
  });
  return withDispatchOperation('dispatch.run.evidence', {
    workspacePath: safeWorkspacePath,
    runId: safeRunId,
  }, () => {
    const trail = auditTrail(safeWorkspacePath, safeRunId);
    const evidence: DispatchRunEvidenceItem[] = [];
    for (const entry of trail) {
      if (entry.kind !== 'run-evidence-collected') continue;
      const items = Array.isArray(entry.data.items) ? entry.data.items : [];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        evidence.push(item as DispatchRunEvidenceItem);
      }
    }
    return evidence;
  });
}

export function listRuns(workspacePath: string, options: { status?: RunStatus; limit?: number } = {}): DispatchRun[] {
  const safeWorkspacePath = validatedWorkspacePath(workspacePath, 'dispatch.run.list');
  return withDispatchOperation('dispatch.run.list', { workspacePath: safeWorkspacePath }, () => {
    const runs = loadRuns(safeWorkspacePath).runs
      .filter((run) => (options.status ? run.status === options.status : true))
      .map((run) => hydrateRunWithRuntimeMetadata(safeWorkspacePath, run))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (options.limit && options.limit > 0) {
      return runs.slice(0, options.limit);
    }
    return runs;
  });
}

export async function executeRun(
  workspacePath: string,
  runId: string,
  input: DispatchExecuteInput,
): Promise<DispatchRun> {
  const safeWorkspacePath = validatedWorkspacePath(workspacePath, 'dispatch.run.execute');
  const safeRunId = validateRunId(runId, {
    workspacePath: safeWorkspacePath,
    runId,
    operation: 'dispatch.run.execute',
  });
  const safeActor = validateActorName(input.actor, {
    workspacePath: safeWorkspacePath,
    runId: safeRunId,
    actor: input.actor,
    operation: 'dispatch.run.execute',
  });
  return withDispatchOperationAsync('dispatch.run.execute', {
    workspacePath: safeWorkspacePath,
    runId: safeRunId,
    actor: safeActor,
  }, async () => {
    assertDispatchMutationAuthorized(safeWorkspacePath, safeActor, 'dispatch.run.execute', safeRunId, [
      'dispatch:run',
    ]);
    const existing = status(safeWorkspacePath, safeRunId);
    if (!['queued', 'running'].includes(existing.status)) {
      throw new ConflictError(
        `Run ${safeRunId} is in terminal status "${existing.status}" and cannot be executed.`,
        {
          workspacePath: safeWorkspacePath,
          runId: safeRunId,
          actor: safeActor,
          operation: 'dispatch.run.execute',
        },
      );
    }

    const adapter = resolveDispatchAdapter(existing.adapter);
    const resolvedDispatchMode = input.dispatchMode
      ?? normalizeDispatchMode(existing.context?.dispatch_mode)
      ?? 'direct';
    const resolvedTimeoutMs = normalizeExecutionTimeoutMs(
      input.timeoutMs ?? readOptionalNumber(existing.context?.run_timeout_ms),
    );
    const resolvedHeartbeatIntervalMs = normalizeLeaseHeartbeatIntervalMs(
      readOptionalNumber(existing.context?.run_lease_heartbeat_ms),
      existing.leaseDurationMinutes,
    );
    const abortController = new AbortController();
    let beforeGitState: ReturnType<typeof captureWorkspaceGitState> = null;
    try {
      beforeGitState = captureWorkspaceGitState(safeWorkspacePath);
    } catch (error) {
      logDispatchWarning('Unable to capture pre-run git state; continuing without git evidence.', error, {
        runId: safeRunId,
        actor: safeActor,
      });
    }

    appendDispatchRunAuditEventSafe(safeWorkspacePath, {
      runId: safeRunId,
      actor: safeActor,
      kind: 'run-execution-started',
      data: {
        adapter: existing.adapter,
        dispatch_mode: resolvedDispatchMode,
        timeout_ms: resolvedTimeoutMs,
      },
    }, {
      runId: safeRunId,
      actor: safeActor,
      operation: 'dispatch.run.execute',
    });

    if (resolvedDispatchMode === 'self-assembly') {
      const selfAssembly = await attemptSelfAssembly(safeWorkspacePath, existing, {
        ...input,
        actor: safeActor,
      });
      appendRunLogs(safeWorkspacePath, safeRunId, safeActor, selfAssembly.logs);
      if (!selfAssembly.ok) {
        appendDispatchRunAuditEventSafe(safeWorkspacePath, {
          runId: safeRunId,
          actor: safeActor,
          kind: 'run-execution-error',
          data: {
            dispatch_mode: resolvedDispatchMode,
            error: selfAssembly.error,
            stage: 'self-assembly',
          },
        }, {
          runId: safeRunId,
          actor: safeActor,
          operation: 'dispatch.run.execute.self-assembly',
        });
        return markRun(safeWorkspacePath, safeRunId, safeActor, 'failed', {
          error: selfAssembly.error,
          contextPatch: {
            dispatch_mode: resolvedDispatchMode,
            self_assembly_failed: true,
          },
        });
      }
    }

    if (wantsExternalBroker(existing)) {
      try {
        if (existing.external?.externalRunId) {
          if (adapter.poll) {
            await pollExternalRuns(safeWorkspacePath, safeActor, { runId: safeRunId });
          }
          return status(safeWorkspacePath, safeRunId);
        }
        return await attemptExternalBrokerDispatch(safeWorkspacePath, existing, safeActor, adapter);
      } catch (error) {
        return failBrokeredRun(safeWorkspacePath, safeRunId, safeActor, errorMessage(error));
      }
    }

    if (!adapter.execute) {
      throw new ConflictError(`Dispatch adapter "${existing.adapter}" does not implement execute().`, {
        workspacePath: safeWorkspacePath,
        runId: safeRunId,
        actor: safeActor,
        operation: 'dispatch.run.execute',
      });
    }

    if (existing.status === 'queued') {
      setStatus(safeWorkspacePath, safeRunId, safeActor, 'running', `Run started on adapter "${existing.adapter}".`);
    }

    const stopLeaseHeartbeat = startRunLeaseHeartbeat(
      safeWorkspacePath,
      safeRunId,
      safeActor,
      resolvedHeartbeatIntervalMs,
    );
    try {
      const execution = await withExecutionTimeout(
        adapter.execute({
          workspacePath: safeWorkspacePath,
          runId: safeRunId,
          actor: safeActor,
          objective: existing.objective,
          context: existing.context,
          agents: input.agents,
          maxSteps: input.maxSteps,
          stepDelayMs: input.stepDelayMs,
          space: input.space,
          createCheckpoint: input.createCheckpoint,
          isCancelled: () => abortController.signal.aborted || getRun(safeWorkspacePath, safeRunId)?.status === 'cancelled',
          onHeartbeat: () => {
            heartbeat(safeWorkspacePath, safeRunId, { actor: safeActor });
          },
          abortSignal: abortController.signal,
          heartbeatIntervalMs: resolvedHeartbeatIntervalMs,
        }),
        resolvedTimeoutMs,
        safeRunId,
        async () => {
          abortController.abort();
          await safeStopAdapterExecution(adapter, safeRunId, safeActor);
        },
      );

      appendRunLogs(safeWorkspacePath, safeRunId, safeActor, execution.logs);
      const currentRun = status(safeWorkspacePath, safeRunId);
      if (currentRun.status === 'cancelled') {
        appendDispatchRunAuditEventSafe(safeWorkspacePath, {
          runId: safeRunId,
          actor: safeActor,
          kind: 'run-execution-finished',
          data: {
            status: 'cancelled',
            reason: 'execution result ignored after cancellation',
          },
        }, {
          runId: safeRunId,
          actor: safeActor,
          operation: 'dispatch.run.execute',
        });
        return currentRun;
      }
      const finalStatus = execution.status;
      if (finalStatus === 'queued' || finalStatus === 'running') {
        throw new ConflictError(`Adapter returned invalid terminal status "${finalStatus}" for execute().`, {
          workspacePath: safeWorkspacePath,
          runId: safeRunId,
          actor: safeActor,
          operation: 'dispatch.run.execute',
        });
      }
      let evidenceSummary: DispatchRun['evidenceChain'] | undefined;
      try {
        const afterGitState = captureWorkspaceGitState(safeWorkspacePath);
        const evidence = collectDispatchExecutionEvidence({
          runId: safeRunId,
          execution,
          beforeGitState,
          afterGitState,
        });
        evidenceSummary = evidence.summary;
        appendDispatchRunAuditEventSafe(safeWorkspacePath, {
          runId: safeRunId,
          actor: safeActor,
          kind: 'run-evidence-collected',
          data: {
            items: evidence.items,
            summary: evidence.summary,
          },
        }, {
          runId: safeRunId,
          actor: safeActor,
          operation: 'dispatch.run.execute.evidence',
        });
      } catch (error) {
        logDispatchWarning('Evidence collection failed; completing run without evidence chain.', error, {
          runId: safeRunId,
          actor: safeActor,
        });
        appendRunLogs(safeWorkspacePath, safeRunId, safeActor, [{
          ts: new Date().toISOString(),
          level: 'warn',
          message: `Evidence collection failed: ${errorMessage(error)}`,
        }]);
      }
      appendDispatchRunAuditEventSafe(safeWorkspacePath, {
        runId: safeRunId,
        actor: safeActor,
        kind: 'run-execution-finished',
        data: {
          status: finalStatus,
          evidence_count: evidenceSummary?.count ?? 0,
        },
      }, {
        runId: safeRunId,
        actor: safeActor,
        operation: 'dispatch.run.execute',
      });

      return markRun(safeWorkspacePath, safeRunId, safeActor, finalStatus, {
        output: execution.output,
        error: execution.error,
        contextPatch: {
          ...(execution.metrics ? { adapter_metrics: execution.metrics } : {}),
          dispatch_mode: resolvedDispatchMode,
          lease_heartbeat_ms: resolvedHeartbeatIntervalMs,
          ...(evidenceSummary ? { evidence_chain: evidenceSummary } : {}),
        },
      });
    } catch (error) {
      const message = errorMessage(error);
      const statusValue = status(safeWorkspacePath, safeRunId);
      if (statusValue.status === 'cancelled') {
        appendDispatchRunAuditEventSafe(safeWorkspacePath, {
          runId: safeRunId,
          actor: safeActor,
          kind: 'run-execution-finished',
          data: {
            status: 'cancelled',
            reason: 'execution cancelled',
          },
        }, {
          runId: safeRunId,
          actor: safeActor,
          operation: 'dispatch.run.execute',
        });
        return statusValue;
      }
      const kind = message.includes('timed out')
        ? 'run-execution-timeout'
        : 'run-execution-error';
      appendDispatchRunAuditEventSafe(safeWorkspacePath, {
        runId: safeRunId,
        actor: safeActor,
        kind,
        data: {
          error: message,
        },
      }, {
        runId: safeRunId,
        actor: safeActor,
        operation: 'dispatch.run.execute',
      });
      return markRun(safeWorkspacePath, safeRunId, safeActor, 'failed', {
        error: message,
        contextPatch: {
          dispatch_mode: resolvedDispatchMode,
          lease_heartbeat_ms: resolvedHeartbeatIntervalMs,
        },
      });
    } finally {
      stopLeaseHeartbeat();
      abortController.abort();
    }
  });
}

export async function createAndExecuteRun(
  workspacePath: string,
  createInput: DispatchCreateInput,
  executeInput: Omit<DispatchExecuteInput, 'actor'> = {},
): Promise<DispatchRun> {
  const safeWorkspacePath = validatedWorkspacePath(workspacePath, 'dispatch.run.create-execute');
  return withDispatchOperationAsync('dispatch.run.create-execute', {
    workspacePath: safeWorkspacePath,
    actor: createInput.actor,
  }, async () => {
    const run = createRun(safeWorkspacePath, createInput);
    return executeRun(safeWorkspacePath, run.id, {
      actor: createInput.actor,
      ...executeInput,
    });
  });
}

export async function retryRun(
  workspacePath: string,
  runId: string,
  input: DispatchRetryInput,
): Promise<DispatchRun> {
  const safeWorkspacePath = validatedWorkspacePath(workspacePath, 'dispatch.run.retry');
  const safeRunId = validateRunId(runId, {
    workspacePath: safeWorkspacePath,
    runId,
    operation: 'dispatch.run.retry',
  });
  const safeActor = validateActorName(input.actor, {
    workspacePath: safeWorkspacePath,
    runId: safeRunId,
    actor: input.actor,
    operation: 'dispatch.run.retry',
  });
  return withDispatchOperationAsync('dispatch.run.retry', {
    workspacePath: safeWorkspacePath,
    runId: safeRunId,
    actor: safeActor,
  }, async () => {
    assertDispatchMutationAuthorized(safeWorkspacePath, safeActor, 'dispatch.run.retry', safeRunId, [
      'dispatch:run',
    ]);
    const source = status(safeWorkspacePath, safeRunId);
    if (source.status !== 'failed') {
      throw new ConflictError(`Run ${safeRunId} is in status "${source.status}". Only failed runs can be retried.`, {
        workspacePath: safeWorkspacePath,
        runId: safeRunId,
        actor: safeActor,
        operation: 'dispatch.run.retry',
      });
    }
    const priorAttempt = readOptionalNumber(source.context?.retry_attempt) ?? 0;
    const retryAttempt = Math.trunc(priorAttempt) + 1;
    const retried = createRun(safeWorkspacePath, {
      actor: safeActor,
      adapter: input.adapter ?? source.adapter,
      objective: input.objective ?? source.objective,
      context: {
        ...(source.context ?? {}),
        ...(input.contextPatch ?? {}),
        retry_of_run_id: source.id,
        retry_attempt: retryAttempt,
        retry_requested_by: safeActor,
        retry_requested_at: new Date().toISOString(),
      },
    });
    appendDispatchRunAuditEventSafe(safeWorkspacePath, {
      runId: source.id,
      actor: safeActor,
      kind: 'run-retried',
      data: {
        retried_run_id: retried.id,
        retry_attempt: retryAttempt,
      },
    }, {
      runId: source.id,
      actor: safeActor,
      operation: 'dispatch.run.retry',
    });
    if (input.execute === false) {
      return retried;
    }
    return executeRun(safeWorkspacePath, retried.id, {
      actor: safeActor,
      agents: input.agents,
      maxSteps: input.maxSteps,
      stepDelayMs: input.stepDelayMs,
      space: input.space,
      createCheckpoint: input.createCheckpoint,
      timeoutMs: input.timeoutMs,
      dispatchMode: input.dispatchMode,
      selfAssemblyAgent: input.selfAssemblyAgent,
      selfAssemblyOptions: input.selfAssemblyOptions,
    });
  });
}

export function recoverDispatchState(workspacePath: string, actor: string): DispatchStateRecoveryResult {
  const safeWorkspacePath = validatedWorkspacePath(workspacePath, 'dispatch.state.recover');
  const safeActor = validateActorName(actor, {
    workspacePath: safeWorkspacePath,
    actor,
    operation: 'dispatch.state.recover',
  });
  return withDispatchOperation('dispatch.state.recover', {
    workspacePath: safeWorkspacePath,
    actor: safeActor,
  }, () => {
    assertDispatchMutationAuthorized(safeWorkspacePath, safeActor, 'dispatch.state.recover', '.workgraph/dispatch-runs', [
      'dispatch:run',
      'policy:manage',
    ]);
    const nowIso = new Date().toISOString();
    const warnings: string[] = [];
    let removedCorruptRuns = 0;
    const repairedRuns = withRunsMutation(safeWorkspacePath, (state) => {
      const repaired: DispatchRun[] = [];
      const healthyRuns: DispatchRun[] = [];
      for (const rawRun of state.runs) {
        try {
          const run = hydrateRun(rawRun);
          const brokerState = readDispatchBrokerState(safeWorkspacePath, run.id);
          const brokered = hydrateRunWithDispatchBrokerState(run, brokerState);
          if (!run.id || !run.id.startsWith('run_')) {
            removedCorruptRuns += 1;
            warnings.push('Dropped corrupt run entry with missing/invalid run ID.');
            continue;
          }
          let changed = false;
          if (run.status === 'running' && !run.leaseExpires && !isBrokeredRun(brokered)) {
            run.status = 'queued';
            run.updatedAt = nowIso;
            run.logs.push({
              ts: nowIso,
              level: 'warn',
              message: 'Recovered run with missing lease by re-queueing it.',
            });
            changed = true;
          }
          if (run.status === 'running' && run.leaseExpires && !isBrokeredRun(brokered)) {
            const leaseMs = Date.parse(run.leaseExpires);
            if (!Number.isFinite(leaseMs) || leaseMs <= Date.now()) {
              run.status = 'queued';
              run.updatedAt = nowIso;
              clearLease(run);
              run.logs.push({
                ts: nowIso,
                level: 'warn',
                message: 'Recovered run with expired/invalid lease by re-queueing it.',
              });
              changed = true;
            }
          }
          if (changed) repaired.push(run);
          healthyRuns.push(run);
        } catch {
          removedCorruptRuns += 1;
          warnings.push('Dropped an unreadable dispatch run record while repairing state.');
        }
      }
      state.runs = healthyRuns;
      return repaired;
    });
    for (const run of repairedRuns) {
      appendDispatchRunAuditEventSafe(safeWorkspacePath, {
        runId: run.id,
        actor: safeActor,
        kind: 'run-status-changed',
        data: {
          to_status: run.status,
          reason: 'state-recovery',
        },
      }, {
        runId: run.id,
        actor: safeActor,
        operation: 'dispatch.state.recover',
      });
      appendLedgerEventSafe(safeWorkspacePath, safeActor, 'update', `.workgraph/runs/${run.id}`, 'run', {
        status: run.status,
        recovered: true,
      });
      ensureRunPrimitiveSafe(safeWorkspacePath, run, safeActor);
      syncRunPrimitiveSafe(safeWorkspacePath, run, safeActor);
    }
    return {
      repairedAt: nowIso,
      scannedRuns: loadRuns(safeWorkspacePath).runs.length,
      repairedRuns,
      removedCorruptRuns,
      warnings,
    };
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
  const run = withRunsMutation(workspacePath, (state) => {
    const target = state.runs.find((entry) => entry.id === runId);
    if (!target) {
      throw new ResourceNotFoundError(`Run not found: ${runId}`, {
        workspacePath,
        runId,
        actor,
        operation: 'dispatch.run.logs',
      });
    }
    target.logs.push(...logEntries);
    target.updatedAt = new Date().toISOString();
    return target;
  });
  appendDispatchRunAuditEventSafe(workspacePath, {
    runId: run.id,
    actor,
    kind: 'run-logs-appended',
    data: {
      count: logEntries.length,
      levels: [...new Set(logEntries.map((entry) => entry.level))],
    },
  }, {
    runId: run.id,
    actor,
    operation: 'dispatch.run.logs',
  });
  appendLedgerEventSafe(workspacePath, actor, 'update', `.workgraph/runs/${run.id}`, 'run', {
    log_append_count: logEntries.length,
  });
  syncRunPrimitiveSafe(workspacePath, run, actor);
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
  const run = withRunsMutation(workspacePath, (state) => {
    const target = state.runs.find((entry) => entry.id === runId);
    if (!target) {
      throw new ResourceNotFoundError(`Run not found: ${runId}`, {
        workspacePath,
        runId,
        actor,
        operation: 'dispatch.run.status',
      });
    }
    const previousStatus = target.status;
    assertRunStatusTransition(target.status, statusValue, runId);
    const now = new Date().toISOString();
    target.status = statusValue;
    if (statusValue === 'running') {
      applyLease(target, now);
    } else {
      clearLease(target);
    }
    target.updatedAt = now;
    target.logs.push({ ts: now, level: 'info', message: logMessage });
    appendDispatchRunAuditEventSafe(workspacePath, {
      runId: target.id,
      actor,
      kind: 'run-status-changed',
      data: {
        from_status: previousStatus,
        to_status: statusValue,
        lease_expires: target.leaseExpires,
      },
    }, {
      runId: target.id,
      actor,
      operation: 'dispatch.run.status',
    });
    appendLedgerEventSafe(workspacePath, actor, 'update', `.workgraph/runs/${target.id}`, 'run', {
      status: target.status,
    });
    return target;
  });
  syncRunPrimitiveSafe(workspacePath, run, actor);
  return hydrateRunWithRuntimeMetadata(workspacePath, run);
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
  try {
    const raw = fs.readFileSync(rPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: number; runs?: DispatchRun[] };
    return {
      version: parsed.version ?? 1,
      runs: Array.isArray(parsed.runs) ? parsed.runs.map(hydrateRun) : [],
    };
  } catch (error) {
    logDispatchWarning('Dispatch runs state is unreadable; seeding an empty run state.', error, {
      target: rPath,
    });
    const seeded = { version: 1, runs: [] as DispatchRun[] };
    saveRuns(workspacePath, seeded);
    return seeded;
  }
}

function saveRuns(workspacePath: string, value: { version: number; runs: DispatchRun[] }): void {
  const rPath = runsPath(workspacePath);
  const dir = path.dirname(rPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteFile(rPath, JSON.stringify(value, null, 2) + '\n');
}

function getRun(workspacePath: string, runId: string): DispatchRun | null {
  const state = loadRuns(workspacePath);
  return state.runs.find((run) => run.id === runId) ?? null;
}

function ensureRunPrimitive(workspacePath: string, run: DispatchRun, actor: string): void {
  const hydrated = hydrateRunWithRuntimeMetadata(workspacePath, run);
  const safeTitle = `${hydrated.objective} (${hydrated.id.slice(0, 8)})`;
  const runPrimitivePath = `runs/${run.id}.md`;
  const existing = store.read(workspacePath, runPrimitivePath);
  if (existing) return;
  store.create(
    workspacePath,
    'run',
    {
      title: safeTitle,
      objective: hydrated.objective,
      runtime: hydrated.adapter,
      status: hydrated.status,
      run_id: hydrated.id,
      owner: hydrated.actor,
      lease_expires: hydrated.leaseExpires,
      lease_duration_minutes: hydrated.leaseDurationMinutes,
      last_heartbeat: latestHeartbeat(hydrated),
      heartbeat_timestamps: hydrated.heartbeats ?? [],
      ...(hydrated.external ? { external: sanitizeFrontmatterValue(hydrated.external) } : {}),
      ...(hydrated.dispatchTracking ? { dispatch_tracking: sanitizeFrontmatterValue(hydrated.dispatchTracking) } : {}),
      tags: ['dispatch'],
    },
    renderRunBody(hydrated),
    actor,
    { pathOverride: runPrimitivePath },
  );
}

function syncRunPrimitive(workspacePath: string, run: DispatchRun, actor: string): void {
  const runs = store.list(workspacePath, 'run');
  const existing = runs.find((entry) => String(entry.fields.run_id) === run.id);
  if (!existing) return;
  const hydrated = hydrateRunWithRuntimeMetadata(workspacePath, run);
  store.update(
    workspacePath,
    existing.path,
    {
      status: hydrated.status,
      runtime: hydrated.adapter,
      objective: hydrated.objective,
      owner: hydrated.actor,
      lease_expires: hydrated.leaseExpires,
      lease_duration_minutes: hydrated.leaseDurationMinutes,
      last_heartbeat: latestHeartbeat(hydrated),
      heartbeat_timestamps: hydrated.heartbeats ?? [],
      ...(hydrated.external ? { external: sanitizeFrontmatterValue(hydrated.external) } : {}),
      ...(hydrated.dispatchTracking ? { dispatch_tracking: sanitizeFrontmatterValue(hydrated.dispatchTracking) } : {}),
    },
    renderRunBody(hydrated),
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
    '## External correlation',
    '',
    ...(run.external
      ? [
          `provider: ${run.external.provider}`,
          `external_run_id: ${run.external.externalRunId}`,
          `last_known_status: ${run.external.lastKnownStatus ?? 'unknown'}`,
          `last_known_at: ${run.external.lastKnownAt ?? 'unknown'}`,
          ...(run.external.externalAgentId ? [`external_agent_id: ${run.external.externalAgentId}`] : []),
          ...(run.external.externalThreadId ? [`external_thread_id: ${run.external.externalThreadId}`] : []),
          ...((run.external.correlationKeys ?? []).length > 0
            ? [`correlation_keys: ${(run.external.correlationKeys ?? []).join(', ')}`]
            : []),
        ]
      : ['none']),
    '',
    '## Dispatch tracking',
    '',
    `dispatched_at: ${run.dispatchTracking?.dispatchedAt ?? 'n/a'}`,
    `last_sent_at: ${run.dispatchTracking?.lastSentAt ?? 'n/a'}`,
    `acknowledged: ${run.dispatchTracking?.acknowledged === true ? 'yes' : 'no'}`,
    `acknowledged_at: ${run.dispatchTracking?.acknowledgedAt ?? 'n/a'}`,
    `retry_count: ${run.dispatchTracking?.retryCount ?? 0}`,
    `last_reconciled_at: ${run.dispatchTracking?.lastReconciledAt ?? 'n/a'}`,
    `reconciliation_error: ${run.dispatchTracking?.reconciliationError ?? 'n/a'}`,
    `cancellation_requested_at: ${run.dispatchTracking?.cancellationRequestedAt ?? 'n/a'}`,
    `cancellation_acknowledged_at: ${run.dispatchTracking?.cancellationAcknowledgedAt ?? 'n/a'}`,
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
  if (run.audit?.eventCount || run.evidenceChain?.count) {
    lines.push('## Evidence & Audit');
    lines.push('');
    lines.push(`audit_events: ${run.audit?.eventCount ?? 0}`);
    lines.push(`audit_head_hash: ${run.audit?.headHash ?? 'none'}`);
    lines.push(`evidence_items: ${run.evidenceChain?.count ?? 0}`);
    if (run.evidenceChain?.lastCollectedAt) {
      lines.push(`evidence_last_collected_at: ${run.evidenceChain.lastCollectedAt}`);
    }
    if (run.evidenceChain?.byType && Object.keys(run.evidenceChain.byType).length > 0) {
      lines.push('evidence_by_type:');
      for (const [type, count] of Object.entries(run.evidenceChain.byType)) {
        lines.push(`  - ${type}: ${count}`);
      }
    }
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
    external: normalizeExternalIdentity(run.external),
    dispatchTracking: normalizeDispatchTracking(run.dispatchTracking),
  };
}

function hydrateRunWithRuntimeMetadata(workspacePath: string, run: DispatchRun): DispatchRun {
  const brokerState = readDispatchBrokerState(workspacePath, run.id);
  const base = hydrateRunWithDispatchBrokerState(hydrateRun(run), brokerState);
  const trail = listDispatchRunAuditEvents(workspacePath, run.id);
  const evidenceCount = trail
    .filter((entry) => entry.kind === 'run-evidence-collected')
    .reduce((total, entry) => {
      const items = Array.isArray(entry.data.items) ? entry.data.items : [];
      return total + items.length;
    }, 0);
  const byType: Record<string, number> = {};
  for (const item of listRunEvidenceFromTrail(trail)) {
    byType[item.type] = (byType[item.type] ?? 0) + 1;
  }
  return {
    ...base,
    audit: {
      eventCount: trail.length,
      headHash: trail[trail.length - 1]?.hash,
    },
    evidenceChain: {
      count: evidenceCount,
      byType,
      lastCollectedAt: trail.filter((entry) => entry.kind === 'run-evidence-collected').at(-1)?.ts,
    },
  };
}

function listRunEvidenceFromTrail(trail: DispatchRunAuditEvent[]): DispatchRunEvidenceItem[] {
  const items: DispatchRunEvidenceItem[] = [];
  for (const entry of trail) {
    if (entry.kind !== 'run-evidence-collected') continue;
    const rawItems = Array.isArray(entry.data.items) ? entry.data.items : [];
    for (const item of rawItems) {
      if (!item || typeof item !== 'object') continue;
      items.push(item as DispatchRunEvidenceItem);
    }
  }
  return items;
}

async function attemptExternalBrokerDispatch(
  workspacePath: string,
  run: DispatchRun,
  actor: string,
  adapter: ReturnType<typeof resolveDispatchAdapter>,
): Promise<DispatchRun> {
  if (!adapter.dispatch) {
    throw new ConflictError(`Dispatch adapter "${run.adapter}" does not implement dispatch().`, {
      workspacePath,
      runId: run.id,
      actor,
      operation: 'dispatch.run.external-dispatch',
    });
  }
  const now = new Date().toISOString();
  const dispatchInput: DispatchAdapterDispatchInput = {
    workspacePath,
    runId: run.id,
    actor,
    objective: run.objective,
    context: run.context,
    followups: run.followups,
    external: normalizeDispatchAdapterExternalIdentity(run.external),
  };
  const payloadDigest = hashExternalDispatchPayload(dispatchInput);
  const trackingBefore = normalizeDispatchTracking(run.dispatchTracking);
  const tracking: DispatchRunDispatchTracking = {
    ...trackingBefore,
    dispatchedAt: trackingBefore.dispatchedAt ?? now,
    lastSentAt: now,
    outboundPayloadDigest: payloadDigest,
    retryCount: trackingBefore.retryCount + 1,
    reconciliationError: undefined,
  };
  persistBrokerState(workspacePath, run.id, {
    external: run.external,
    tracking,
  });
  appendDispatchRunAuditEventSafe(workspacePath, {
    runId: run.id,
    actor,
    kind: 'run-dispatch-attempted',
    data: {
      adapter: run.adapter,
      payload_digest: payloadDigest,
      retry_count: tracking.retryCount,
      dispatched_at: tracking.dispatchedAt,
      last_sent_at: tracking.lastSentAt,
    },
  }, {
    runId: run.id,
    actor,
    operation: 'dispatch.run.external-dispatch',
  });

  let dispatched: DispatchAdapterExternalUpdate;
  try {
    dispatched = await adapter.dispatch(dispatchInput);
  } catch (error) {
    persistBrokerState(workspacePath, run.id, {
      tracking: {
        ...tracking,
        reconciliationError: errorMessage(error),
      },
    });
    appendDispatchRunAuditEventSafe(workspacePath, {
      runId: run.id,
      actor,
      kind: 'run-dispatch-failed',
      data: {
        adapter: run.adapter,
        error: errorMessage(error),
      },
    }, {
      runId: run.id,
      actor,
      operation: 'dispatch.run.external-dispatch',
    });
    throw error;
  }

  const external = mergeExternalIdentity(run.external, normalizeExternalFromUpdate(run.adapter, dispatched));
  if (!external) {
    throw new ConflictError(`Dispatch adapter "${run.adapter}" did not return an external run identifier.`, {
      workspacePath,
      runId: run.id,
      actor,
      operation: 'dispatch.run.external-dispatch',
    });
  }
  const mergedTracking = mergeDispatchTracking(tracking, {
    acknowledged: dispatched.acknowledged,
    acknowledgedAt: dispatched.acknowledgedAt ?? (dispatched.acknowledged === true ? now : undefined),
    lastReconciledAt: dispatched.status ? (dispatched.lastKnownAt ?? now) : undefined,
  });
  persistBrokerState(workspacePath, run.id, {
    external: mergeExternalIdentity(external, {
      provider: external.provider,
      externalRunId: external.externalRunId,
      lastKnownStatus: dispatched.status,
      lastKnownAt: dispatched.lastKnownAt ?? now,
      correlationKeys: external?.correlationKeys,
      metadata: {
        ...(external?.metadata ?? {}),
        ...(dispatched.metadata ?? {}),
      },
    }),
    tracking: mergedTracking,
  });
  if ((dispatched.logs ?? []).length > 0) {
    appendRunLogs(workspacePath, run.id, actor, dispatched.logs ?? []);
  }
  recordExternalCorrelationEvidence(workspacePath, run.id, actor, external, mergedTracking, dispatched.metadata);
  appendDispatchRunAuditEventSafe(workspacePath, {
    runId: run.id,
    actor,
    kind: 'run-dispatch-acknowledged',
    data: {
      adapter: run.adapter,
      acknowledged: dispatched.acknowledged === true,
      acknowledged_at: mergedTracking.acknowledgedAt,
      external: external ? serializeExternalIdentityForAudit(external) : undefined,
      status: dispatched.status,
    },
  }, {
    runId: run.id,
    actor,
    operation: 'dispatch.run.external-dispatch',
  });
  if (dispatched.status || dispatched.output || dispatched.error || dispatched.acknowledged || external) {
    reconcileExternalRun(workspacePath, {
      actor,
      runId: run.id,
      source: 'dispatch',
      status: dispatched.status,
      output: dispatched.output,
      error: dispatched.error,
      acknowledged: dispatched.acknowledged,
      acknowledgedAt: dispatched.acknowledgedAt,
      external: external
        ? {
            ...external,
            ...(dispatched.status ? { lastKnownStatus: dispatched.status } : {}),
            lastKnownAt: dispatched.lastKnownAt ?? now,
          }
        : undefined,
      metadata: dispatched.metadata,
      logs: [],
      ts: dispatched.lastKnownAt ?? now,
    });
  }
  return status(workspacePath, run.id);
}

function requestBrokeredRunCancellation(
  workspacePath: string,
  run: DispatchRun,
  actor: string,
): DispatchRun {
  const adapter = resolveDispatchAdapter(run.adapter);
  const now = new Date().toISOString();
  const tracking = mergeDispatchTracking(run.dispatchTracking, {
    cancellationRequestedAt: now,
    reconciliationError: undefined,
  });
  persistBrokerState(workspacePath, run.id, {
    external: run.external,
    tracking,
  });
  appendDispatchRunAuditEventSafe(workspacePath, {
    runId: run.id,
    actor,
    kind: 'run-cancel-requested',
    data: {
      adapter: run.adapter,
      external: run.external ? serializeExternalIdentityForAudit(run.external) : undefined,
      cancellation_requested_at: now,
    },
  }, {
    runId: run.id,
    actor,
    operation: 'dispatch.run.stop',
  });

  const cancelInput: DispatchAdapterCancelInput = {
    workspacePath,
    runId: run.id,
    actor,
    objective: run.objective,
    context: run.context,
    external: normalizeDispatchAdapterExternalIdentity(run.external),
  };
  const cancelPromise: Promise<DispatchAdapterExternalUpdate> = adapter.cancel
    ? adapter.cancel(cancelInput)
    : adapter.stop(run.id, actor).then((value) => ({ status: value.status } as DispatchAdapterExternalUpdate));
  void cancelPromise
    .then((result) => {
      if ((result.logs ?? []).length > 0) {
        appendRunLogs(workspacePath, run.id, actor, result.logs ?? []);
      }
      reconcileExternalRun(workspacePath, {
        actor,
        runId: run.id,
        source: 'cancel',
        status: result.status,
        output: result.output,
        error: result.error,
        acknowledged: result.acknowledged,
        acknowledgedAt: result.acknowledgedAt,
        external: mergeExternalIdentity(run.external, normalizeExternalFromUpdate(run.adapter, result)),
        metadata: result.metadata,
        ts: result.lastKnownAt ?? new Date().toISOString(),
      });
    })
    .catch((error) => {
      persistBrokerState(workspacePath, run.id, {
        external: run.external,
        tracking: mergeDispatchTracking(tracking, {
          lastReconciledAt: new Date().toISOString(),
          reconciliationError: errorMessage(error),
        }),
      });
      appendDispatchRunAuditEventSafe(workspacePath, {
        runId: run.id,
        actor,
        kind: 'run-dispatch-failed',
        data: {
          adapter: run.adapter,
          stage: 'cancel',
          error: errorMessage(error),
        },
      }, {
        runId: run.id,
        actor,
        operation: 'dispatch.run.stop',
      });
    });
  return status(workspacePath, run.id);
}

export function reconcileExternalRun(
  workspacePath: string,
  input: DispatchExternalReconcileInput,
): DispatchExternalReconcileResult {
  const safeWorkspacePath = validatedWorkspacePath(workspacePath, 'dispatch.run.external-reconcile');
  const safeActor = validateActorName(input.actor, {
    workspacePath: safeWorkspacePath,
    runId: input.runId,
    actor: input.actor,
    operation: 'dispatch.run.external-reconcile',
  });
  return withDispatchOperation('dispatch.run.external-reconcile', {
    workspacePath: safeWorkspacePath,
    runId: input.runId,
    actor: safeActor,
  }, () => {
    assertDispatchMutationAuthorized(safeWorkspacePath, safeActor, 'dispatch.run.external-reconcile', input.runId ?? '.workgraph/dispatch-broker', [
      'dispatch:run',
    ]);
    const normalizedInput = normalizeExternalReconcileInput(input);
    const brokerState = findDispatchBrokerState(safeWorkspacePath, {
      runId: normalizedInput.runId,
      provider: normalizedInput.provider,
      externalRunId: normalizedInput.externalRunId,
      correlationKeys: normalizedInput.correlationKeys,
    });
    if (!brokerState) {
      throw new ResourceNotFoundError('External run correlation not found.', {
        workspacePath: safeWorkspacePath,
        actor: safeActor,
        operation: 'dispatch.run.external-reconcile',
      });
    }
    const current = getRun(safeWorkspacePath, brokerState.runId);
    if (!current) {
      throw new ResourceNotFoundError(`Run not found: ${brokerState.runId}`, {
        workspacePath: safeWorkspacePath,
        runId: brokerState.runId,
        actor: safeActor,
        operation: 'dispatch.run.external-reconcile',
      });
    }
    if ((normalizedInput.logs ?? []).length > 0) {
      appendRunLogs(safeWorkspacePath, brokerState.runId, safeActor, normalizedInput.logs ?? []);
    }
    const nowIso = normalizedInput.ts ?? new Date().toISOString();
    const nextExternal = mergeExternalIdentity(
      mergeExternalIdentity(current.external, brokerState.external),
      normalizedInput.external ?? (
        normalizedInput.provider && normalizedInput.externalRunId
          ? {
              provider: normalizedInput.provider,
              externalRunId: normalizedInput.externalRunId,
              correlationKeys: normalizedInput.correlationKeys,
              lastKnownStatus: normalizedInput.status,
              lastKnownAt: nowIso,
            }
          : undefined
      ),
    );
    const nextTracking = mergeDispatchTracking(
      mergeDispatchTracking(current.dispatchTracking, brokerState.tracking),
      {
        acknowledged: normalizedInput.acknowledged,
        acknowledgedAt: normalizedInput.acknowledgedAt,
        lastReconciledAt: nowIso,
        reconciliationError: undefined,
        ...(normalizedInput.source === 'cancel' && normalizedInput.status === 'cancelled'
          ? { cancellationAcknowledgedAt: nowIso }
          : {}),
      },
    );
    persistBrokerState(safeWorkspacePath, brokerState.runId, {
      external: nextExternal,
      tracking: nextTracking,
    });
    recordExternalCorrelationEvidence(
      safeWorkspacePath,
      brokerState.runId,
      safeActor,
      nextExternal,
      nextTracking,
      normalizedInput.metadata,
    );

    const previousStatus = current.status;
    let nextStatus = current.status;
    if (normalizedInput.status && canApplyExternalRunStatus(current.status, normalizedInput.status)) {
      nextStatus = normalizedInput.status;
    }
    const statusChanged = withRunsMutation(safeWorkspacePath, (state) => {
      const target = state.runs.find((candidate) => candidate.id === brokerState.runId);
      if (!target) return false;
      target.external = nextExternal;
      target.dispatchTracking = nextTracking;
      if (normalizedInput.output) target.output = normalizedInput.output;
      if (normalizedInput.error) target.error = normalizedInput.error;
      target.updatedAt = nowIso;
      if (target.status !== nextStatus) {
        target.status = nextStatus;
        clearLease(target);
        target.logs.push({
          ts: nowIso,
          level: 'info',
          message: `External reconciliation (${normalizedInput.source}) set status to ${nextStatus}.`,
        });
        return true;
      }
      return false;
    });
    appendDispatchRunAuditEventSafe(safeWorkspacePath, {
      runId: brokerState.runId,
      actor: safeActor,
      kind: 'run-external-reconciled',
      data: {
        source: normalizedInput.source,
        previous_status: previousStatus,
        current_status: nextStatus,
        acknowledged: nextTracking.acknowledged === true,
        external: nextExternal ? serializeExternalIdentityForAudit(nextExternal) : undefined,
      },
    }, {
      runId: brokerState.runId,
      actor: safeActor,
      operation: 'dispatch.run.external-reconcile',
    });
    if (normalizedInput.source === 'cancel' && nextStatus === 'cancelled') {
      appendDispatchRunAuditEventSafe(safeWorkspacePath, {
        runId: brokerState.runId,
        actor: safeActor,
        kind: 'run-cancel-acknowledged',
        data: {
          cancelled_at: nowIso,
          external: nextExternal ? serializeExternalIdentityForAudit(nextExternal) : undefined,
        },
      }, {
        runId: brokerState.runId,
        actor: safeActor,
        operation: 'dispatch.run.external-reconcile',
      });
    }
    if (statusChanged) {
      appendDispatchRunAuditEventSafe(safeWorkspacePath, {
        runId: brokerState.runId,
        actor: safeActor,
        kind: 'run-status-changed',
        data: {
          from_status: previousStatus,
          to_status: nextStatus,
          reason: `external-reconcile:${normalizedInput.source}`,
        },
      }, {
        runId: brokerState.runId,
        actor: safeActor,
        operation: 'dispatch.run.external-reconcile',
      });
      appendLedgerEventSafe(safeWorkspacePath, safeActor, 'update', `.workgraph/runs/${brokerState.runId}`, 'run', {
        status: nextStatus,
        external_reconcile: normalizedInput.source,
      });
    }
    const reconciled = status(safeWorkspacePath, brokerState.runId);
    syncRunPrimitiveSafe(safeWorkspacePath, reconciled, safeActor);
    return {
      reconciledAt: nowIso,
      matchedRunId: brokerState.runId,
      statusChanged,
      previousStatus,
      currentStatus: reconciled.status,
      run: reconciled,
    };
  });
}

export async function pollExternalRuns(
  workspacePath: string,
  actor: string,
  options: { runId?: string } = {},
): Promise<DispatchPollExternalRunsResult> {
  const safeWorkspacePath = validatedWorkspacePath(workspacePath, 'dispatch.run.external-poll');
  const safeActor = validateActorName(actor, {
    workspacePath: safeWorkspacePath,
    runId: options.runId,
    actor,
    operation: 'dispatch.run.external-poll',
  });
  return withDispatchOperationAsync('dispatch.run.external-poll', {
    workspacePath: safeWorkspacePath,
    runId: options.runId,
    actor: safeActor,
  }, async () => {
    assertDispatchMutationAuthorized(safeWorkspacePath, safeActor, 'dispatch.run.external-poll', options.runId ?? '.workgraph/dispatch-broker', [
      'dispatch:run',
    ]);
    const candidateRuns = (options.runId
      ? [status(safeWorkspacePath, options.runId)]
      : listRuns(safeWorkspacePath)).filter((run) => !isTerminalRunStatus(run.status));
    const brokered = candidateRuns.filter((run) => wantsExternalBroker(run));
    const reconciledRuns: DispatchRun[] = [];
    const failures: DispatchPollExternalRunsResult['failures'] = [];
    for (const run of brokered) {
      const adapter = resolveDispatchAdapter(run.adapter);
      if (!adapter.poll || !run.external) continue;
      try {
        const polled = await adapter.poll({
          workspacePath: safeWorkspacePath,
          runId: run.id,
          actor: safeActor,
          objective: run.objective,
          context: run.context,
          external: normalizeDispatchAdapterExternalIdentity(run.external)!,
        });
        if (!polled) continue;
        const reconciled = reconcileExternalRun(safeWorkspacePath, {
          actor: safeActor,
          runId: run.id,
          source: 'poll',
          status: polled.status,
          output: polled.output,
          error: polled.error,
          acknowledged: polled.acknowledged,
          acknowledgedAt: polled.acknowledgedAt,
          external: mergeExternalIdentity(run.external, normalizeExternalFromUpdate(run.adapter, polled)),
          metadata: polled.metadata,
          logs: polled.logs,
          ts: polled.lastKnownAt,
        }).run;
        if (reconciled) reconciledRuns.push(reconciled);
      } catch (error) {
        failures.push({
          runId: run.id,
          error: errorMessage(error),
        });
        persistBrokerState(safeWorkspacePath, run.id, {
          external: run.external,
          tracking: mergeDispatchTracking(run.dispatchTracking, {
            lastReconciledAt: new Date().toISOString(),
            reconciliationError: errorMessage(error),
          }),
        });
      }
    }
    return {
      reconciledAt: new Date().toISOString(),
      inspectedRuns: brokered.length,
      reconciledRuns,
      failures,
    };
  });
}

function persistBrokerState(
  workspacePath: string,
  runId: string,
  updates: {
    external?: DispatchRunExternalIdentity;
    tracking?: DispatchRunDispatchTracking;
  },
): void {
  updateDispatchBrokerState(workspacePath, runId, (current) => ({
    runId,
    external: mergeExternalIdentity(current?.external, updates.external),
    tracking: mergeDispatchTracking(current?.tracking, updates.tracking),
    updatedAt: new Date().toISOString(),
  }));
}

function recordExternalCorrelationEvidence(
  workspacePath: string,
  runId: string,
  actor: string,
  external: DispatchRunExternalIdentity | undefined,
  tracking: DispatchRunDispatchTracking | undefined,
  metadata?: Record<string, unknown>,
): void {
  try {
    const evidence = collectDispatchExternalCorrelationEvidence({
      runId,
      external,
      tracking,
      metadata,
    });
    if (evidence.items.length === 0) return;
    appendDispatchRunAuditEventSafe(workspacePath, {
      runId,
      actor,
      kind: 'run-evidence-collected',
      data: {
        items: evidence.items,
        summary: evidence.summary,
      },
    }, {
      runId,
      actor,
      operation: 'dispatch.run.external-evidence',
    });
  } catch (error) {
    logDispatchWarning('Failed to record external correlation evidence.', error, {
      runId,
      actor,
    });
  }
}

function failBrokeredRun(
  workspacePath: string,
  runId: string,
  actor: string,
  error: string,
): DispatchRun {
  const current = status(workspacePath, runId);
  if (current.status !== 'queued') {
    return markRun(workspacePath, runId, actor, 'failed', {
      error,
      contextPatch: {
        external_broker_mode: true,
      },
    });
  }
  const now = new Date().toISOString();
  const failed = withRunsMutation(workspacePath, (state) => {
    const target = state.runs.find((entry) => entry.id === runId);
    if (!target) {
      throw new ResourceNotFoundError(`Run not found: ${runId}`, {
        workspacePath,
        runId,
        actor,
        operation: 'dispatch.run.external-fail',
      });
    }
    target.status = 'failed';
    target.error = error;
    target.updatedAt = now;
    clearLease(target);
    target.logs.push({
      ts: now,
      level: 'error',
      message: `External broker dispatch failed: ${error}`,
    });
    return target;
  });
  appendDispatchRunAuditEventSafe(workspacePath, {
    runId,
    actor,
    kind: 'run-status-changed',
    data: {
      from_status: 'queued',
      to_status: 'failed',
      reason: 'external-dispatch-failed',
    },
  }, {
    runId,
    actor,
    operation: 'dispatch.run.external-fail',
  });
  appendLedgerEventSafe(workspacePath, actor, 'update', `.workgraph/runs/${runId}`, 'run', {
    status: 'failed',
    external_dispatch_failed: true,
  });
  syncRunPrimitiveSafe(workspacePath, failed, actor);
  return status(workspacePath, runId);
}

function normalizeExternalReconcileInput(input: DispatchExternalReconcileInput): DispatchExternalReconcileInput {
  return {
    ...input,
    runId: readOptionalString(input.runId),
    provider: readOptionalString(input.provider),
    externalRunId: readOptionalString(input.externalRunId),
    correlationKeys: (input.correlationKeys ?? []).map((entry) => String(entry).trim()).filter(Boolean),
    status: normalizeRunStatusValue(input.status),
    acknowledged: input.acknowledged === true ? true : undefined,
    acknowledgedAt: readOptionalString(input.acknowledgedAt),
    external: normalizeExternalIdentity(input.external),
    metadata: isRecord(input.metadata) ? input.metadata : undefined,
    source: input.source ?? 'event',
    ts: readOptionalString(input.ts),
    logs: Array.isArray(input.logs) ? input.logs : [],
  };
}

function normalizeRunStatusValue(value: unknown): RunStatus | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (
    normalized === 'queued'
    || normalized === 'running'
    || normalized === 'succeeded'
    || normalized === 'failed'
    || normalized === 'cancelled'
  ) {
    return normalized;
  }
  return undefined;
}

function normalizeExternalFromUpdate(
  fallbackProvider: string,
  update: DispatchAdapterExternalUpdate,
): DispatchRunExternalIdentity | undefined {
  const external = normalizeDispatchAdapterExternalIdentity(update.external);
  if (!external) return undefined;
  return {
    provider: external.provider || fallbackProvider,
    externalRunId: external.externalRunId,
    externalAgentId: external.externalAgentId,
    externalThreadId: external.externalThreadId,
    correlationKeys: external.correlationKeys,
    metadata: external.metadata,
    lastKnownStatus: update.status,
    lastKnownAt: update.lastKnownAt,
  };
}

function normalizeDispatchAdapterExternalIdentity(
  external: DispatchRunExternalIdentity | DispatchAdapterExternalIdentity | undefined,
): DispatchAdapterExternalIdentity | undefined {
  const normalized = normalizeExternalIdentity(external as DispatchRunExternalIdentity | undefined);
  if (!normalized) return undefined;
  return {
    provider: normalized.provider,
    externalRunId: normalized.externalRunId,
    externalAgentId: normalized.externalAgentId,
    externalThreadId: normalized.externalThreadId,
    correlationKeys: normalized.correlationKeys,
    metadata: normalized.metadata,
  };
}

function serializeExternalIdentityForAudit(external: DispatchRunExternalIdentity): Record<string, unknown> {
  return {
    provider: external.provider,
    external_run_id: external.externalRunId,
    external_agent_id: external.externalAgentId,
    external_thread_id: external.externalThreadId,
    correlation_keys: external.correlationKeys ?? [],
    last_known_status: external.lastKnownStatus,
    last_known_at: external.lastKnownAt,
  };
}

function hashExternalDispatchPayload(input: DispatchAdapterDispatchInput): string {
  return createStableHash({
    workspacePath: input.workspacePath,
    runId: input.runId,
    actor: input.actor,
    objective: input.objective,
    context: input.context ?? {},
    followups: input.followups ?? [],
    external: input.external ?? null,
  });
}

function canApplyExternalRunStatus(from: RunStatus, to: RunStatus): boolean {
  if (from === to) return true;
  if (isTerminalRunStatus(from)) return false;
  if (from === 'queued') {
    return to === 'running' || to === 'succeeded' || to === 'failed' || to === 'cancelled';
  }
  if (from === 'running') {
    return to === 'succeeded' || to === 'failed' || to === 'cancelled';
  }
  return false;
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function wantsExternalBroker(run: DispatchRun): boolean {
  if (isBrokeredRun(run)) return true;
  if (run.context?.external_broker_mode === true) return true;
  if (run.adapter === 'cursor-cloud') {
    return hasCursorExternalBrokerConfig(run.context);
  }
  return false;
}

function hasCursorExternalBrokerConfig(context: Record<string, unknown> | undefined): boolean {
  return Boolean(
    readOptionalString(context?.cursor_cloud_api_base_url)
    || readOptionalString(context?.cursor_cloud_dispatch_url)
    || readOptionalString(context?.cursor_cloud_status_url_template)
    || readOptionalString(context?.cursor_cloud_cancel_url_template),
  );
}

function createStableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((left, right) => left.localeCompare(right));
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function sanitizeFrontmatterValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeFrontmatterValue(entry))
      .filter((entry) => entry !== undefined) as T;
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const cleaned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined) continue;
    cleaned[key] = sanitizeFrontmatterValue(entry);
  }
  return cleaned as T;
}

async function attemptSelfAssembly(
  workspacePath: string,
  run: DispatchRun,
  input: DispatchExecuteInput,
): Promise<{
  ok: boolean;
  logs: DispatchAdapterLogEntry[];
  error?: string;
}> {
  const now = new Date().toISOString();
  const agentName = input.selfAssemblyAgent
    ?? readOptionalString(run.context?.self_assembly_agent)
    ?? readOptionalString(input.selfAssemblyOptions?.agentName)
    ?? input.actor;
  const rawOptions = isRecord(run.context?.self_assembly_options)
    ? run.context?.self_assembly_options
    : undefined;
  const mergedOptions = {
    ...normalizeSelfAssemblyOptions(rawOptions),
    ...normalizeSelfAssemblyOptions(input.selfAssemblyOptions),
  };
  try {
    const module = await import('./agent-self-assembly.js');
    const result = module.assembleAgent(workspacePath, agentName, {
      ...mergedOptions,
    });
    return {
      ok: true,
      logs: [
        {
          ts: now,
          level: 'info',
          message: `Self-assembly dispatched agent "${result.agentName}" before run execution.`,
        },
        ...(result.claimedThread
          ? [{
              ts: now,
              level: 'info' as const,
              message: `Self-assembly claimed ${result.claimedThread.path}.`,
            }]
          : []),
        ...(result.warnings.length > 0
          ? result.warnings.map((warning) => ({
              ts: now,
              level: 'warn' as const,
              message: `Self-assembly warning: ${warning}`,
            }))
          : []),
      ],
    };
  } catch (error) {
    return {
      ok: false,
      logs: [{
        ts: now,
        level: 'error',
        message: `Self-assembly failed: ${errorMessage(error)}`,
      }],
      error: `Self-assembly failed: ${errorMessage(error)}`,
    };
  }
}

function normalizeSelfAssemblyOptions(
  value: Record<string, unknown> | undefined,
): SelfAssemblyDispatchOptions {
  if (!value) return {};
  const normalized: SelfAssemblyDispatchOptions = {};
  const credentialToken = readOptionalString(value.credentialToken);
  const bootstrapToken = readOptionalString(value.bootstrapToken);
  const role = readOptionalString(value.role);
  const registerActor = readOptionalString(value.registerActor);
  const recoveryActor = readOptionalString(value.recoveryActor);
  const spaceRef = readOptionalString(value.spaceRef);
  const recoveryLimit = readOptionalNumber(value.recoveryLimit);
  const leaseTtlMinutes = readOptionalNumber(value.leaseTtlMinutes);
  if (credentialToken) normalized.credentialToken = credentialToken;
  if (bootstrapToken) normalized.bootstrapToken = bootstrapToken;
  if (role) normalized.role = role;
  if (registerActor) normalized.registerActor = registerActor;
  if (typeof value.recoverStaleClaims === 'boolean') normalized.recoverStaleClaims = value.recoverStaleClaims;
  if (recoveryActor) normalized.recoveryActor = recoveryActor;
  if (typeof recoveryLimit === 'number') normalized.recoveryLimit = Math.trunc(recoveryLimit);
  if (typeof value.recoveryRequired === 'boolean') normalized.recoveryRequired = value.recoveryRequired;
  if (spaceRef) normalized.spaceRef = spaceRef;
  if (typeof leaseTtlMinutes === 'number') normalized.leaseTtlMinutes = Math.trunc(leaseTtlMinutes);
  if (typeof value.createPlanStepIfMissing === 'boolean') {
    normalized.createPlanStepIfMissing = value.createPlanStepIfMissing;
  }
  return normalized;
}

interface SelfAssemblyDispatchOptions {
  credentialToken?: string;
  bootstrapToken?: string;
  role?: string;
  registerActor?: string;
  recoverStaleClaims?: boolean;
  recoveryActor?: string;
  recoveryLimit?: number;
  recoveryRequired?: boolean;
  spaceRef?: string;
  leaseTtlMinutes?: number;
  createPlanStepIfMissing?: boolean;
}

function normalizeDispatchMode(rawValue: unknown): 'direct' | 'self-assembly' | undefined {
  const normalized = String(rawValue ?? '').trim().toLowerCase();
  if (normalized === 'direct' || normalized === 'self-assembly') {
    return normalized;
  }
  return undefined;
}

function normalizeExecutionTimeoutMs(value: unknown): number {
  const numeric = readOptionalNumber(value);
  if (numeric === undefined || !Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_EXECUTE_TIMEOUT_MS;
  }
  return Math.trunc(Math.min(60 * 60_000, Math.max(1_000, numeric)));
}

function normalizeLeaseHeartbeatIntervalMs(value: unknown, leaseDurationMinutes: number | undefined): number {
  const numeric = readOptionalNumber(value);
  if (numeric !== undefined && Number.isFinite(numeric) && numeric > 0) {
    return Math.trunc(Math.min(60 * 60_000, Math.max(100, numeric)));
  }
  const leaseMs = normalizeLeaseMinutes(leaseDurationMinutes) * 60_000;
  return Math.trunc(Math.min(DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS, Math.max(1_000, leaseMs / 3)));
}

async function withExecutionTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  runId: string,
  onTimeout?: () => Promise<void> | void,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          void Promise.resolve(onTimeout?.()).catch(() => undefined);
          reject(new Error(`Dispatch execution timed out after ${timeoutMs}ms for run ${runId}.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeLeaseMinutes(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  return DEFAULT_LEASE_MINUTES;
}

function startRunLeaseHeartbeat(
  workspacePath: string,
  runId: string,
  actor: string,
  intervalMs: number,
): () => void {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const run = getRun(workspacePath, runId);
    if (!run || run.status !== 'running') return;
    void Promise.resolve(heartbeat(workspacePath, runId, { actor })).catch(() => undefined);
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function safeStopAdapterExecution(
  adapter: ReturnType<typeof resolveDispatchAdapter>,
  runId: string,
  actor: string,
): Promise<void> {
  try {
    await adapter.stop(runId, actor);
  } catch {
    // Best-effort stop should never mask the original timeout/cancellation path.
  }
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
    throw new ConflictError(
      `Invalid run transition for ${runId}: ${from} -> ${to}. Allowed: ${allowed.join(', ') || 'none'}.`,
      { runId, operation: 'dispatch.run.status-transition' },
    );
  }
}

function resolveThreadRef(threadRef: string): string {
  const raw = String(threadRef ?? '').trim();
  const unwrapped = raw.startsWith('[[') && raw.endsWith(']]')
    ? raw.slice(2, -2)
    : raw;
  if (!unwrapped) {
    throw new InputValidationError('Thread reference is required.', {
      operation: 'dispatch.thread.claim',
    });
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

function logDispatchWarning(
  message: string,
  error: unknown,
  context: {
    runId?: string;
    actor?: string;
    target?: string;
  } = {},
): void {
  const rendered = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const suffixParts = [
    context.runId ? `run=${context.runId}` : undefined,
    context.actor ? `actor=${context.actor}` : undefined,
    context.target ? `target=${context.target}` : undefined,
  ].filter(Boolean);
  const suffix = suffixParts.length > 0 ? ` (${suffixParts.join(', ')})` : '';
  process.stderr.write(`[workgraph][warn][dispatch] ${message}${suffix} -> ${rendered}\n`);
}
