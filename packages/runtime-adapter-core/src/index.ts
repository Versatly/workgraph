export interface RuntimeAdapter {
  name: string;
  create(input: { objective: string; actor: string; idempotencyKey?: string }): Promise<{ runId: string; status: string }>;
  status(runId: string): Promise<{ runId: string; status: string }>;
  followup(runId: string, input: string, actor: string): Promise<{ runId: string; status: string }>;
  stop(runId: string, actor: string): Promise<{ runId: string; status: string }>;
  logs(runId: string): Promise<Array<{ ts: string; level: string; message: string }>>;
}
