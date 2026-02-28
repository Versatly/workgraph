/**
 * Gateway-connected worker loop.
 *
 * Workers claim/complete work through the network gateway so multiple machines
 * can coordinate against one authoritative workgraph writer.
 */

export interface GatewayWorkerLoopOptions {
  gatewayUrl: string;
  actor: string;
  authToken?: string;
  space?: string;
  pollIntervalMs?: number;
  maxCycles?: number;
  checkpointEvery?: number;
}

export interface GatewayWorkerLoopResult {
  actor: string;
  gatewayUrl: string;
  startedAt: string;
  finishedAt: string;
  cycles: number;
  claimed: number;
  completed: number;
  idle: number;
  checkpoints: number;
  errors: number;
  lastError?: string;
}

interface GatewayEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

interface GatewayThreadPayload {
  path: string;
  type: string;
  fields: Record<string, unknown>;
  body: string;
}

export async function runGatewayWorkerLoop(options: GatewayWorkerLoopOptions): Promise<GatewayWorkerLoopResult> {
  const startedAt = new Date().toISOString();
  const gatewayUrl = normalizeGatewayUrl(options.gatewayUrl);
  const actor = normalizeNonEmpty(options.actor, 'actor');
  const pollIntervalMs = normalizePositiveInt(options.pollIntervalMs, 500);
  const checkpointEvery = normalizeNonNegativeInt(options.checkpointEvery, 0);
  const maxCycles = options.maxCycles === undefined
    ? Number.POSITIVE_INFINITY
    : normalizePositiveInt(options.maxCycles, 1);

  let cycles = 0;
  let claimed = 0;
  let completed = 0;
  let idle = 0;
  let checkpoints = 0;
  let errors = 0;
  let lastError: string | undefined;

  while (cycles < maxCycles) {
    cycles += 1;
    try {
      const next = await postGateway<{ thread: GatewayThreadPayload | null; claimed: boolean }>(
        gatewayUrl,
        '/v1/threads/next-claim',
        {
          actor,
          space: options.space,
        },
        options.authToken,
      );
      const thread = next.thread;
      if (!thread) {
        idle += 1;
        if (cycles < maxCycles) {
          await sleep(pollIntervalMs);
        }
        continue;
      }

      claimed += 1;
      await postGateway(
        gatewayUrl,
        '/v1/threads/done',
        {
          actor,
          threadPath: thread.path,
          output: `Completed by ${actor} via gateway worker loop.`,
        },
        options.authToken,
      );
      completed += 1;

      if (checkpointEvery > 0 && completed % checkpointEvery === 0) {
        await postGateway(
          gatewayUrl,
          '/v1/checkpoints',
          {
            actor,
            summary: `Worker ${actor} completed ${completed} thread(s) via gateway loop.`,
            next: [],
            blocked: [],
            tags: ['gateway-worker'],
          },
          options.authToken,
        );
        checkpoints += 1;
      }
    } catch (error) {
      errors += 1;
      lastError = error instanceof Error ? error.message : String(error);
      if (cycles < maxCycles) {
        await sleep(pollIntervalMs);
      }
    }
  }

  return {
    actor,
    gatewayUrl,
    startedAt,
    finishedAt: new Date().toISOString(),
    cycles,
    claimed,
    completed,
    idle,
    checkpoints,
    errors,
    ...(lastError ? { lastError } : {}),
  };
}

async function postGateway<T>(
  gatewayUrl: string,
  route: string,
  payload: Record<string, unknown>,
  authToken?: string,
): Promise<T> {
  const response = await fetch(`${gatewayUrl}${route}`, {
    method: 'POST',
    headers: buildHeaders(authToken),
    body: JSON.stringify(payload),
  });
  return parseEnvelope<T>(response, route);
}

function buildHeaders(authToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (authToken) {
    headers.authorization = `Bearer ${authToken}`;
    headers['x-workgraph-token'] = authToken;
  }
  return headers;
}

async function parseEnvelope<T>(response: Response, route: string): Promise<T> {
  let parsed: GatewayEnvelope<T> | null = null;
  try {
    parsed = await response.json() as GatewayEnvelope<T>;
  } catch {
    throw new Error(`Gateway ${route} returned non-JSON response (status ${response.status}).`);
  }
  if (!response.ok || !parsed.ok || parsed.data === undefined) {
    const reason = parsed.error ?? `HTTP ${response.status}`;
    throw new Error(`Gateway ${route} failed: ${reason}`);
  }
  return parsed.data;
}

function normalizeGatewayUrl(input: string): string {
  const normalized = normalizeNonEmpty(input, 'gatewayUrl').replace(/\/+$/, '');
  // Validate URL shape up front for fast failure.
  void new URL(normalized);
  return normalized;
}

function normalizeNonEmpty(value: string, fieldName: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`Missing required ${fieldName}.`);
  }
  return normalized;
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const normalized = Math.trunc(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`Expected positive integer, received "${value}".`);
  }
  return normalized;
}

function normalizeNonNegativeInt(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const normalized = Math.trunc(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`Expected non-negative integer, received "${value}".`);
  }
  return normalized;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
