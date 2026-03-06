import type {
  DispatchAdapterExecutionResult,
  DispatchAdapterLogEntry,
} from '@versatly/workgraph-kernel';
import type { RuntimeDispatchRunStatus, RuntimeRunHandle } from './contracts.js';

interface StoredRun {
  runId: string;
  status: RuntimeDispatchRunStatus['status'];
  logs: DispatchAdapterLogEntry[];
  output?: string;
  error?: string;
  metrics?: Record<string, unknown>;
  startedAt: string;
  updatedAt: string;
  cancelRequested: boolean;
  metadata?: Record<string, unknown>;
}

export class InMemoryAdapterRunStore {
  private readonly runs = new Map<string, StoredRun>();

  constructor(private readonly adapterName: string) {}

  seed(runId: string, metadata?: Record<string, unknown>): RuntimeRunHandle {
    const existing = this.runs.get(runId);
    if (existing) {
      return this.toHandle(existing);
    }
    const now = new Date().toISOString();
    const run: StoredRun = {
      runId,
      status: 'queued',
      logs: [],
      startedAt: now,
      updatedAt: now,
      cancelRequested: false,
      metadata,
    };
    this.runs.set(runId, run);
    return this.toHandle(run);
  }

  markRunning(runId: string): void {
    this.patch(runId, (run) => {
      run.status = 'running';
    });
  }

  appendLogs(runId: string, entries: DispatchAdapterLogEntry[]): void {
    if (entries.length === 0) return;
    this.patch(runId, (run) => {
      run.logs.push(...entries);
    });
  }

  finalize(runId: string, result: DispatchAdapterExecutionResult): RuntimeDispatchRunStatus {
    return this.patch(runId, (run) => {
      run.status = result.status;
      run.output = result.output;
      run.error = result.error;
      run.metrics = isRecord(result.metrics) ? result.metrics : undefined;
      if (result.logs.length > 0) {
        run.logs.push(...result.logs);
      }
    });
  }

  markFailed(runId: string, message: string): RuntimeDispatchRunStatus {
    return this.patch(runId, (run) => {
      run.status = 'failed';
      run.error = message;
      run.logs.push({
        ts: new Date().toISOString(),
        level: 'error',
        message,
      });
    });
  }

  cancel(runId: string, actor?: string): RuntimeDispatchRunStatus {
    return this.patch(runId, (run) => {
      run.cancelRequested = true;
      run.status = 'cancelled';
      run.logs.push({
        ts: new Date().toISOString(),
        level: 'warn',
        message: actor
          ? `Cancellation requested by ${actor}.`
          : 'Cancellation requested.',
      });
    });
  }

  isCancelled(runId: string): boolean {
    const run = this.runs.get(runId);
    return run?.cancelRequested ?? false;
  }

  status(runId: string): RuntimeDispatchRunStatus {
    return this.toStatus(this.requireRun(runId));
  }

  logs(runId: string): DispatchAdapterLogEntry[] {
    return [...this.requireRun(runId).logs];
  }

  private patch(runId: string, mutate: (run: StoredRun) => void): RuntimeDispatchRunStatus {
    const run = this.requireRun(runId);
    mutate(run);
    run.updatedAt = new Date().toISOString();
    return this.toStatus(run);
  }

  private requireRun(runId: string): StoredRun {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Run not found in ${this.adapterName} adapter state: ${runId}`);
    }
    return run;
  }

  private toHandle(run: StoredRun): RuntimeRunHandle {
    return {
      adapter: this.adapterName,
      runId: run.runId,
      status: run.status,
      startedAt: run.startedAt,
      metadata: run.metadata,
    };
  }

  private toStatus(run: StoredRun): RuntimeDispatchRunStatus {
    return {
      runId: run.runId,
      status: run.status,
      adapter: this.adapterName,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      output: run.output,
      error: run.error,
      metrics: run.metrics,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
