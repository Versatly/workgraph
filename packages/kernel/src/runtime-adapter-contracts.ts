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

export interface DispatchAdapter {
  name: string;
  create(input: DispatchAdapterCreateInput): Promise<DispatchAdapterRunStatus>;
  status(runId: string): Promise<DispatchAdapterRunStatus>;
  followup(runId: string, actor: string, input: string): Promise<DispatchAdapterRunStatus>;
  stop(runId: string, actor: string): Promise<DispatchAdapterRunStatus>;
  logs(runId: string): Promise<DispatchAdapterLogEntry[]>;
  execute?(input: DispatchAdapterExecutionInput): Promise<DispatchAdapterExecutionResult>;
}
