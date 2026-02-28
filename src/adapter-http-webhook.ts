import type {
  DispatchAdapter,
  DispatchAdapterCreateInput,
  DispatchAdapterExecutionInput,
  DispatchAdapterExecutionResult,
  DispatchAdapterLogEntry,
  DispatchAdapterRunStatus,
} from './runtime-adapter-contracts.js';

const DEFAULT_POLL_MS = 1000;
const DEFAULT_MAX_WAIT_MS = 90_000;

export class HttpWebhookAdapter implements DispatchAdapter {
  name = 'http-webhook';

  async create(_input: DispatchAdapterCreateInput): Promise<DispatchAdapterRunStatus> {
    return { runId: 'http-webhook-managed', status: 'queued' };
  }

  async status(runId: string): Promise<DispatchAdapterRunStatus> {
    return { runId, status: 'running' };
  }

  async followup(runId: string, _actor: string, _input: string): Promise<DispatchAdapterRunStatus> {
    return { runId, status: 'running' };
  }

  async stop(runId: string, _actor: string): Promise<DispatchAdapterRunStatus> {
    return { runId, status: 'cancelled' };
  }

  async logs(_runId: string): Promise<DispatchAdapterLogEntry[]> {
    return [];
  }

  async execute(input: DispatchAdapterExecutionInput): Promise<DispatchAdapterExecutionResult> {
    const logs: DispatchAdapterLogEntry[] = [];
    const webhookUrl = resolveUrl(input.context?.webhook_url, process.env.WORKGRAPH_DISPATCH_WEBHOOK_URL);
    if (!webhookUrl) {
      return {
        status: 'failed',
        error: 'http-webhook adapter requires context.webhook_url or WORKGRAPH_DISPATCH_WEBHOOK_URL.',
        logs,
      };
    }

    const token = readString(input.context?.webhook_token) ?? process.env.WORKGRAPH_DISPATCH_WEBHOOK_TOKEN;
    const headers = {
      'content-type': 'application/json',
      ...extractHeaders(input.context?.webhook_headers),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };

    const payload = {
      runId: input.runId,
      actor: input.actor,
      objective: input.objective,
      workspacePath: input.workspacePath,
      context: input.context ?? {},
      ts: new Date().toISOString(),
    };

    pushLog(logs, 'info', `http-webhook posting run ${input.runId} to ${webhookUrl}`);
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const rawText = await response.text();
    const parsed = safeParseJson(rawText);
    pushLog(logs, response.ok ? 'info' : 'error', `http-webhook response status: ${response.status}`);

    if (!response.ok) {
      return {
        status: 'failed',
        error: `http-webhook request failed (${response.status}): ${rawText || response.statusText}`,
        logs,
      };
    }

    const immediateStatus = normalizeRunStatus(parsed?.status);
    if (immediateStatus && isTerminalStatus(immediateStatus)) {
      return {
        status: immediateStatus,
        output: typeof parsed?.output === 'string' ? parsed.output : rawText,
        error: typeof parsed?.error === 'string' ? parsed.error : undefined,
        logs,
        metrics: {
          adapter: 'http-webhook',
          httpStatus: response.status,
        },
      };
    }

    const pollUrl = resolveUrl(parsed?.pollUrl, input.context?.webhook_status_url, process.env.WORKGRAPH_DISPATCH_WEBHOOK_STATUS_URL);
    if (!pollUrl) {
      // Treat successful non-terminal response as succeeded for synchronous handlers.
      return {
        status: 'succeeded',
        output: rawText || 'http-webhook acknowledged run successfully.',
        logs,
        metrics: {
          adapter: 'http-webhook',
          httpStatus: response.status,
        },
      };
    }

    const pollMs = clampInt(readNumber(input.context?.webhook_poll_ms), DEFAULT_POLL_MS, 200, 30_000);
    const maxWaitMs = clampInt(readNumber(input.context?.webhook_max_wait_ms), DEFAULT_MAX_WAIT_MS, 1000, 15 * 60_000);
    const startedAt = Date.now();
    pushLog(logs, 'info', `http-webhook polling status from ${pollUrl}`);

    while (Date.now() - startedAt < maxWaitMs) {
      if (input.isCancelled?.()) {
        pushLog(logs, 'warn', 'http-webhook run cancelled while polling');
        return {
          status: 'cancelled',
          output: 'http-webhook polling cancelled by dispatcher.',
          logs,
        };
      }

      const pollResponse = await fetch(pollUrl, {
        method: 'GET',
        headers: {
          ...headers,
        },
      });
      const pollText = await pollResponse.text();
      const pollJson = safeParseJson(pollText);
      const pollStatus = normalizeRunStatus(pollJson?.status);
      pushLog(logs, 'info', `poll status=${pollResponse.status} run_status=${pollStatus ?? 'unknown'}`);

      if (pollStatus && isTerminalStatus(pollStatus)) {
        return {
          status: pollStatus,
          output: typeof pollJson?.output === 'string' ? pollJson.output : pollText,
          error: typeof pollJson?.error === 'string' ? pollJson.error : undefined,
          logs,
          metrics: {
            adapter: 'http-webhook',
            pollUrl,
            pollHttpStatus: pollResponse.status,
            elapsedMs: Date.now() - startedAt,
          },
        };
      }

      await sleep(pollMs);
    }

    return {
      status: 'failed',
      error: `http-webhook polling exceeded timeout (${maxWaitMs}ms) for run ${input.runId}.`,
      logs,
    };
  }
}

function pushLog(target: DispatchAdapterLogEntry[], level: DispatchAdapterLogEntry['level'], message: string): void {
  target.push({
    ts: new Date().toISOString(),
    level,
    message,
  });
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveUrl(...values: unknown[]): string | undefined {
  for (const value of values) {
    const parsed = readString(value);
    if (!parsed) continue;
    try {
      const url = new URL(parsed);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return url.toString();
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function extractHeaders(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const record = input as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!key || value === undefined || value === null) continue;
    out[key.toLowerCase()] = String(value);
  }
  return out;
}

function safeParseJson(value: string): Record<string, unknown> | null {
  if (!value || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeRunStatus(value: unknown): DispatchAdapterRunStatus['status'] | undefined {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized === 'queued' || normalized === 'running' || normalized === 'succeeded' || normalized === 'failed' || normalized === 'cancelled') {
    return normalized;
  }
  return undefined;
}

function isTerminalStatus(status: DispatchAdapterRunStatus['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const raw = typeof value === 'number' ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, raw));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
