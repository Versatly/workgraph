import { randomUUID } from 'node:crypto';
import { adapterHttpWebhook } from '@versatly/workgraph-kernel';
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

const DEFAULT_HEALTH_TIMEOUT_MS = 8_000;

export class WebhookAdapter implements RuntimeDispatchAdapter {
  readonly name = 'webhook';
  private readonly webhook = new adapterHttpWebhook.HttpWebhookAdapter();
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
    const runId = `webhook_${randomUUID()}`;
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
    const result = await this.webhook.execute({
      ...input,
      isCancelled: () => this.runs.isCancelled(input.runId) || input.isCancelled?.() === true,
    });
    this.runs.finalize(input.runId, result);
    return result;
  }

  async healthCheck(input: RuntimeAdapterHealthCheckInput = {}): Promise<RuntimeAdapterHealthCheckResult> {
    const checkedAt = new Date().toISOString();
    const timeoutMs = normalizePositiveInt(input.timeoutMs, DEFAULT_HEALTH_TIMEOUT_MS);
    const targetUrl = resolveWebhookHealthUrl(input.context);
    if (!targetUrl) {
      return {
        ok: false,
        adapter: this.name,
        checkedAt,
        message: 'Missing webhook URL. Provide webhook_health_url/webhook_url or related environment variables.',
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response = await fetch(targetUrl, {
        method: 'HEAD',
        signal: controller.signal,
      });
      if (response.status === 405 || response.status === 501) {
        response = await fetch(targetUrl, {
          method: 'GET',
          signal: controller.signal,
        });
      }

      return {
        ok: response.ok,
        adapter: this.name,
        checkedAt,
        message: response.ok
          ? `Webhook endpoint reachable (${response.status}).`
          : `Webhook endpoint unhealthy (${response.status}).`,
        details: {
          url: targetUrl,
          status: response.status,
        },
      };
    } catch (error) {
      return {
        ok: false,
        adapter: this.name,
        checkedAt,
        message: `Webhook connectivity test failed: ${errorMessage(error)}`,
        details: {
          url: targetUrl,
          timeoutMs,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async runInBackground(task: RuntimeDispatchTask): Promise<void> {
    try {
      await this.execute(task);
    } catch (error) {
      this.runs.markFailed(task.runId, errorMessage(error));
    }
  }
}

function resolveWebhookHealthUrl(context: Record<string, unknown> | undefined): string | undefined {
  return readString(context?.webhook_health_url)
    ?? readString(context?.webhook_url)
    ?? readString(process.env.WORKGRAPH_DISPATCH_WEBHOOK_HEALTH_URL)
    ?? readString(process.env.WORKGRAPH_DISPATCH_WEBHOOK_URL);
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
