import type { RunStatus } from './types.js';

export interface DispatchAdapterCreateInput {
  actor: string;
  objective: string;
  idempotencyKey?: string;
  context?: Record<string, unknown>;
}

export interface DispatchAdapterRunStatus {
  runId: string;
  status: RunStatus;
}

export interface DispatchAdapterExternalIdentity {
  provider: string;
  externalRunId: string;
  externalAgentId?: string;
  externalThreadId?: string;
  correlationKeys?: string[];
  metadata?: Record<string, unknown>;
}

export interface DispatchAdapterLogEntry {
  ts: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface DispatchAdapterExecutionInput {
  workspacePath: string;
  runId: string;
  actor: string;
  objective: string;
  context?: Record<string, unknown>;
  agents?: string[];
  maxSteps?: number;
  stepDelayMs?: number;
  space?: string;
  createCheckpoint?: boolean;
  isCancelled?: () => boolean;
  onHeartbeat?: () => Promise<void> | void;
  abortSignal?: AbortSignal;
  heartbeatIntervalMs?: number;
}

export interface DispatchAdapterExecutionResult {
  status: RunStatus;
  output?: string;
  error?: string;
  logs: DispatchAdapterLogEntry[];
  metrics?: Record<string, unknown>;
}

export interface DispatchAdapterDispatchInput {
  workspacePath: string;
  runId: string;
  actor: string;
  objective: string;
  context?: Record<string, unknown>;
  followups?: Array<{
    ts: string;
    actor: string;
    input: string;
  }>;
  external?: DispatchAdapterExternalIdentity;
  abortSignal?: AbortSignal;
}

export interface DispatchAdapterExternalUpdate {
  status?: RunStatus;
  output?: string;
  error?: string;
  logs?: DispatchAdapterLogEntry[];
  metrics?: Record<string, unknown>;
  external?: DispatchAdapterExternalIdentity;
  acknowledged?: boolean;
  acknowledgedAt?: string;
  lastKnownAt?: string;
  metadata?: Record<string, unknown>;
  message?: string;
}

export interface DispatchAdapterPollInput {
  workspacePath: string;
  runId: string;
  actor: string;
  objective: string;
  context?: Record<string, unknown>;
  external: DispatchAdapterExternalIdentity;
  abortSignal?: AbortSignal;
}

export interface DispatchAdapterCancelInput {
  workspacePath: string;
  runId: string;
  actor: string;
  objective: string;
  context?: Record<string, unknown>;
  external?: DispatchAdapterExternalIdentity;
  abortSignal?: AbortSignal;
}

export interface DispatchAdapter {
  name: string;
  create(input: DispatchAdapterCreateInput): Promise<DispatchAdapterRunStatus>;
  status(runId: string): Promise<DispatchAdapterRunStatus>;
  followup(runId: string, actor: string, input: string): Promise<DispatchAdapterRunStatus>;
  stop(runId: string, actor: string): Promise<DispatchAdapterRunStatus>;
  logs(runId: string): Promise<DispatchAdapterLogEntry[]>;
  dispatch?(input: DispatchAdapterDispatchInput): Promise<DispatchAdapterExternalUpdate>;
  poll?(input: DispatchAdapterPollInput): Promise<DispatchAdapterExternalUpdate | null>;
  cancel?(input: DispatchAdapterCancelInput): Promise<DispatchAdapterExternalUpdate>;
  reconcile?(input: DispatchAdapterPollInput & { event?: Record<string, unknown> }): Promise<DispatchAdapterExternalUpdate | null>;
  health?(): Promise<Record<string, unknown>>;
  execute?(input: DispatchAdapterExecutionInput): Promise<DispatchAdapterExecutionResult>;
}
