export interface DispatchAdapterCreateInput {
  actor: string;
  objective: string;
  idempotencyKey?: string;
  context?: Record<string, unknown>;
}

export interface DispatchAdapterRunStatus {
  runId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
}

export interface DispatchAdapter {
  name: string;
  create(input: DispatchAdapterCreateInput): Promise<DispatchAdapterRunStatus>;
  status(runId: string): Promise<DispatchAdapterRunStatus>;
  followup(runId: string, actor: string, input: string): Promise<DispatchAdapterRunStatus>;
  stop(runId: string, actor: string): Promise<DispatchAdapterRunStatus>;
  logs(runId: string): Promise<Array<{ ts: string; level: 'info' | 'warn' | 'error'; message: string }>>;
}
