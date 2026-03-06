import { randomUUID } from 'node:crypto';
import { ShellWorkerAdapter } from '@versatly/workgraph-kernel';
import type {
  DispatchAdapterCreateInput,
  DispatchAdapterExecutionInput,
  DispatchAdapterExecutionResult,
  DispatchAdapterLogEntry,
  DispatchAdapterRunStatus,
} from '@versatly/workgraph-kernel';
import type {
  RuntimeAdapterHealthCheckInput,
  RuntimeAdapterHealthCheckResult,
  RuntimeDispatchConfig,
  RuntimeDispatchRunStatus,
  RuntimeDispatchTask,
  RuntimeRunHandle,
} from './contracts.js';
import type { RuntimeDispatchAdapter } from './contracts.js';
import { InMemoryAdapterRunStore } from './run-store.js';

const HEALTH_CHECK_TIMEOUT_MS = 5_000;

export class ShellSubprocessAdapter implements RuntimeDispatchAdapter {
  readonly name = 'shell';
  private readonly worker = new ShellWorkerAdapter();
  private readonly runs = new InMemoryAdapterRunStore(this.name);

  async dispatch(task: RuntimeDispatchTask, config: RuntimeDispatchConfig = {}): Promise<RuntimeRunHandle> {
    const handle = this.runs.seed(task.runId, config.metadata);
    void this.runInBackground(task);
    return handle;
  }

  async poll(runId: string): Promise<RuntimeDispatchRunStatus> {
    return this.runs.status(runId);
  }

  async cancel(runId: string, actor: string): Promise<RuntimeDispatchRunStatus> {
    return this.runs.cancel(runId, actor);
  }

  async create(input: DispatchAdapterCreateInput): Promise<DispatchAdapterRunStatus> {
    const runId = `shell_${randomUUID()}`;
    this.runs.seed(runId, {
      actor: input.actor,
      objective: input.objective,
    });
    return {
      runId,
      status: 'queued',
    };
  }

  async status(runId: string): Promise<DispatchAdapterRunStatus> {
    return this.poll(runId);
  }

  async followup(runId: string, actor: string, input: string): Promise<DispatchAdapterRunStatus> {
    this.runs.appendLogs(runId, [{
      ts: new Date().toISOString(),
      level: 'info',
      message: `Follow-up from ${actor}: ${input}`,
    }]);
    return this.poll(runId);
  }

  async stop(runId: string, actor: string): Promise<DispatchAdapterRunStatus> {
    return this.cancel(runId, actor);
  }

  async logs(runId: string): Promise<DispatchAdapterLogEntry[]> {
    return this.runs.logs(runId);
  }

  async execute(input: DispatchAdapterExecutionInput): Promise<DispatchAdapterExecutionResult> {
    this.runs.seed(input.runId, {
      actor: input.actor,
      objective: input.objective,
    });
    this.runs.markRunning(input.runId);
    const result = await this.worker.execute({
      ...input,
      isCancelled: () => this.runs.isCancelled(input.runId) || input.isCancelled?.() === true,
    });
    this.runs.finalize(input.runId, result);
    return result;
  }

  async healthCheck(input: RuntimeAdapterHealthCheckInput = {}): Promise<RuntimeAdapterHealthCheckResult> {
    const timeoutMs = normalizePositiveInt(input.timeoutMs, HEALTH_CHECK_TIMEOUT_MS);
    const healthRunId = `shell-health-${randomUUID()}`;
    const command = `"${process.execPath}" -e "process.stdout.write('shell-health-ok')"`;
    const result = await this.worker.execute({
      workspacePath: input.workspacePath ?? process.cwd(),
      runId: healthRunId,
      actor: 'adapter-healthcheck',
      objective: 'shell adapter health check',
      context: {
        shell_command: command,
        shell_timeout_ms: timeoutMs,
      },
    });
    return {
      ok: result.status === 'succeeded',
      adapter: this.name,
      checkedAt: new Date().toISOString(),
      message: result.status === 'succeeded'
        ? 'Shell subprocess execution is available.'
        : `Shell subprocess health check failed: ${result.error ?? 'unknown error'}`,
      details: {
        status: result.status,
        output: result.output,
      },
    };
  }

  private async runInBackground(task: RuntimeDispatchTask): Promise<void> {
    try {
      await this.execute(task);
    } catch (error) {
      this.runs.markFailed(task.runId, errorMessage(error));
    }
  }
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
