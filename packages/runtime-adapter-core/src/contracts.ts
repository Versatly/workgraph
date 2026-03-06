import type {
  DispatchAdapter,
  DispatchAdapterExecutionInput,
  DispatchAdapterRunStatus,
  RunStatus,
} from '@versatly/workgraph-kernel';

export type {
  DispatchAdapter,
  DispatchAdapterCreateInput,
  DispatchAdapterExecutionInput,
  DispatchAdapterExecutionResult,
  DispatchAdapterLogEntry,
  DispatchAdapterRunStatus,
} from '@versatly/workgraph-kernel';

export type RuntimeDispatchTask = DispatchAdapterExecutionInput;

export interface RuntimeDispatchConfig {
  metadata?: Record<string, unknown>;
}

export interface RuntimeRunHandle {
  adapter: string;
  runId: string;
  status: RunStatus;
  startedAt: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeDispatchRunStatus extends DispatchAdapterRunStatus {
  adapter: string;
  startedAt: string;
  updatedAt: string;
  output?: string;
  error?: string;
  metrics?: Record<string, unknown>;
}

export interface RuntimeAdapterHealthCheckInput {
  workspacePath?: string;
  timeoutMs?: number;
  context?: Record<string, unknown>;
}

export interface RuntimeAdapterHealthCheckResult {
  ok: boolean;
  adapter: string;
  checkedAt: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface RuntimeDispatchAdapter extends DispatchAdapter {
  dispatch(task: RuntimeDispatchTask, config?: RuntimeDispatchConfig): Promise<RuntimeRunHandle>;
  poll(runId: string): Promise<RuntimeDispatchRunStatus>;
  cancel(runId: string, actor: string): Promise<RuntimeDispatchRunStatus>;
  healthCheck(input?: RuntimeAdapterHealthCheckInput): Promise<RuntimeAdapterHealthCheckResult>;
}
