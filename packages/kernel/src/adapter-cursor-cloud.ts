import * as orientation from './orientation.js';
import * as store from './store.js';
import * as thread from './thread.js';
import type {
  DispatchAdapter,
  DispatchAdapterCancelInput,
  DispatchAdapterCreateInput,
  DispatchAdapterDispatchInput,
  DispatchAdapterExecutionInput,
  DispatchAdapterExecutionResult,
  DispatchAdapterExternalUpdate,
  DispatchAdapterLogEntry,
  DispatchAdapterPollInput,
  DispatchAdapterRunStatus,
} from './runtime-adapter-contracts.js';
import type { RunStatus } from './types.js';

const DEFAULT_MAX_STEPS = 200;
const DEFAULT_STEP_DELAY_MS = 25;
const DEFAULT_AGENT_COUNT = 3;
const DEFAULT_EXTERNAL_TIMEOUT_MS = 30_000;

export class CursorCloudAdapter implements DispatchAdapter {
  name = 'cursor-cloud';

  async create(_input: DispatchAdapterCreateInput): Promise<DispatchAdapterRunStatus> {
    return {
      runId: 'adapter-managed',
      status: 'queued',
    };
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

  async dispatch(input: DispatchAdapterDispatchInput): Promise<DispatchAdapterExternalUpdate> {
    const config = resolveCursorBrokerConfig(input.context);
    if (!config) {
      throw new Error('cursor-cloud external broker requires cursor_cloud_api_base_url or cursor_cloud_dispatch_url.');
    }
    const now = new Date().toISOString();
    const payload = {
      runId: input.runId,
      actor: input.actor,
      objective: input.objective,
      workspacePath: input.workspacePath,
      context: input.context ?? {},
      followups: input.followups ?? [],
      external: input.external ?? null,
      ts: now,
    };
    const response = await fetchJson(config.dispatchUrl, {
      method: 'POST',
      headers: buildCursorHeaders(config),
      body: JSON.stringify(payload),
      signal: input.abortSignal,
    }, config.timeoutMs);
    const externalRunId = readExternalRunId(response.json);
    if (!response.ok || !externalRunId) {
      throw new Error(`cursor-cloud dispatch failed (${response.status}): ${response.text || 'missing external run id'}`);
    }
    return {
      acknowledged: true,
      acknowledgedAt: now,
      status: normalizeRunStatus(response.json?.status) ?? 'queued',
      external: {
        provider: 'cursor-cloud',
        externalRunId,
        externalAgentId: readString(response.json?.agentId) ?? readString(response.json?.agent_id),
        externalThreadId: readString(response.json?.threadId) ?? readString(response.json?.thread_id),
        correlationKeys: compactStrings([
          input.runId,
          readString(input.context?.cursor_correlation_key),
          readString(response.json?.correlationKey),
        ]),
        metadata: {
          response: response.json ?? response.text,
        },
      },
      lastKnownAt: now,
      logs: [
        {
          ts: now,
          level: 'info',
          message: `cursor-cloud dispatched external run ${externalRunId}.`,
        },
      ],
      metrics: {
        adapter: 'cursor-cloud',
        httpStatus: response.status,
      },
      metadata: {
        httpStatus: response.status,
      },
    };
  }

  async poll(input: DispatchAdapterPollInput): Promise<DispatchAdapterExternalUpdate | null> {
    const config = resolveCursorBrokerConfig(input.context);
    if (!config) return null;
    const response = await fetchJson(resolveTemplate(config.statusUrlTemplate, input.external.externalRunId), {
      method: 'GET',
      headers: buildCursorHeaders(config),
      signal: input.abortSignal,
    }, config.timeoutMs);
    if (!response.ok) {
      throw new Error(`cursor-cloud poll failed (${response.status}): ${response.text || response.statusText}`);
    }
    return {
      status: normalizeRunStatus(response.json?.status),
      output: readString(response.json?.output),
      error: readString(response.json?.error),
      external: {
        provider: 'cursor-cloud',
        externalRunId: input.external.externalRunId,
        externalAgentId: readString(response.json?.agentId) ?? readString(response.json?.agent_id) ?? input.external.externalAgentId,
        externalThreadId: readString(response.json?.threadId) ?? readString(response.json?.thread_id) ?? input.external.externalThreadId,
        correlationKeys: compactStrings([
          ...(input.external.correlationKeys ?? []),
          readString(response.json?.correlationKey),
        ]),
        metadata: {
          response: response.json ?? response.text,
        },
      },
      lastKnownAt: readString(response.json?.updatedAt) ?? readString(response.json?.updated_at) ?? new Date().toISOString(),
      logs: [],
      metadata: {
        httpStatus: response.status,
      },
    };
  }

  async cancel(input: DispatchAdapterCancelInput): Promise<DispatchAdapterExternalUpdate> {
    const config = resolveCursorBrokerConfig(input.context);
    if (!config || !input.external?.externalRunId) {
      return {
        status: 'cancelled',
        acknowledged: true,
        acknowledgedAt: new Date().toISOString(),
        external: input.external,
      };
    }
    const now = new Date().toISOString();
    const response = await fetchJson(resolveTemplate(config.cancelUrlTemplate, input.external.externalRunId), {
      method: 'POST',
      headers: buildCursorHeaders(config),
      body: JSON.stringify({
        runId: input.runId,
        actor: input.actor,
        objective: input.objective,
        externalRunId: input.external.externalRunId,
        ts: now,
      }),
      signal: input.abortSignal,
    }, config.timeoutMs);
    if (!response.ok) {
      throw new Error(`cursor-cloud cancel failed (${response.status}): ${response.text || response.statusText}`);
    }
    return {
      status: normalizeRunStatus(response.json?.status),
      acknowledged: true,
      acknowledgedAt: now,
      external: {
        provider: 'cursor-cloud',
        externalRunId: input.external.externalRunId,
        externalAgentId: input.external.externalAgentId,
        externalThreadId: input.external.externalThreadId,
        correlationKeys: input.external.correlationKeys,
        metadata: {
          response: response.json ?? response.text,
        },
      },
      lastKnownAt: now,
      metadata: {
        httpStatus: response.status,
      },
    };
  }

  async health(): Promise<Record<string, unknown>> {
    return {
      adapter: this.name,
      mode: 'dual',
    };
  }

  async execute(input: DispatchAdapterExecutionInput): Promise<DispatchAdapterExecutionResult> {
    const start = Date.now();
    const logs: DispatchAdapterLogEntry[] = [];
    const agentPool = normalizeAgents(input.agents, input.actor);
    const maxSteps = normalizeInt(input.maxSteps, DEFAULT_MAX_STEPS, 1, 5000);
    const stepDelayMs = normalizeInt(input.stepDelayMs, DEFAULT_STEP_DELAY_MS, 0, 5000);
    const claimedByAgent: Record<string, number> = {};
    const completedByAgent: Record<string, number> = {};
    let stepsExecuted = 0;
    let completionCount = 0;
    let failureCount = 0;
    let cancelled = false;

    for (const agent of agentPool) {
      claimedByAgent[agent] = 0;
      completedByAgent[agent] = 0;
    }

    pushLog(logs, 'info', `Run ${input.runId} started with agents: ${agentPool.join(', ')}`);
    pushLog(logs, 'info', `Objective: ${input.objective}`);

    while (stepsExecuted < maxSteps) {
      if (input.isCancelled?.()) {
        cancelled = true;
        pushLog(logs, 'warn', `Run ${input.runId} received cancellation signal.`);
        break;
      }

      const claimedThisRound: Array<{ agent: string; threadPath: string; goal: string }> = [];
      for (const agent of agentPool) {
        try {
          const claimed = input.space
            ? thread.claimNextReadyInSpace(input.workspacePath, agent, input.space)
            : thread.claimNextReady(input.workspacePath, agent);
          if (!claimed) {
            continue;
          }
          const path = claimed.path;
          const goal = String(claimed.fields.goal ?? claimed.fields.title ?? path);
          claimedThisRound.push({ agent, threadPath: path, goal });
          claimedByAgent[agent] += 1;
          pushLog(logs, 'info', `${agent} claimed ${path}`);
        } catch (error) {
          // Races are expected in multi-agent scheduling; recover and keep moving.
          pushLog(logs, 'warn', `${agent} claim skipped: ${errorMessage(error)}`);
        }
      }

      if (claimedThisRound.length === 0) {
        const readyRemaining = listReady(input.workspacePath, input.space).length;
        if (readyRemaining === 0) {
          pushLog(logs, 'info', 'No ready threads remaining; autonomous loop complete.');
          break;
        }
        if (stepDelayMs > 0) {
          await sleep(stepDelayMs);
        }
        continue;
      }

      await Promise.all(claimedThisRound.map(async (claimed) => {
        if (input.isCancelled?.()) {
          cancelled = true;
          return;
        }
        if (stepDelayMs > 0) {
          await sleep(stepDelayMs);
        }
        try {
          thread.done(
            input.workspacePath,
            claimed.threadPath,
            claimed.agent,
            `Completed by ${claimed.agent} during dispatch run ${input.runId}. Goal: ${claimed.goal}`,
            {
              evidence: [
                { type: 'thread-ref', value: claimed.threadPath },
                { type: 'reply-ref', value: `thread:${input.runId}` },
              ],
            },
          );
          completionCount += 1;
          completedByAgent[claimed.agent] += 1;
          pushLog(logs, 'info', `${claimed.agent} completed ${claimed.threadPath}`);
        } catch (error) {
          failureCount += 1;
          pushLog(logs, 'error', `${claimed.agent} failed to complete ${claimed.threadPath}: ${errorMessage(error)}`);
        }
      }));

      stepsExecuted += claimedThisRound.length;
      if (cancelled) break;
    }

    const readyAfter = listReady(input.workspacePath, input.space);
    const activeAfter = input.space
      ? store.threadsInSpace(input.workspacePath, input.space).filter((candidate) => candidate.fields.status === 'active')
      : store.activeThreads(input.workspacePath);
    const openAfter = input.space
      ? store.threadsInSpace(input.workspacePath, input.space).filter((candidate) => candidate.fields.status === 'open')
      : store.openThreads(input.workspacePath);
    const blockedAfter = input.space
      ? store.threadsInSpace(input.workspacePath, input.space).filter((candidate) => candidate.fields.status === 'blocked')
      : store.blockedThreads(input.workspacePath);

    const elapsedMs = Date.now() - start;
    const summary = renderSummary({
      objective: input.objective,
      runId: input.runId,
      completed: completionCount,
      failed: failureCount,
      stepsExecuted,
      readyRemaining: readyAfter.length,
      openRemaining: openAfter.length,
      blockedRemaining: blockedAfter.length,
      activeRemaining: activeAfter.length,
      elapsedMs,
      claimedByAgent,
      completedByAgent,
      cancelled,
    });

    if (input.createCheckpoint !== false) {
      try {
        orientation.checkpoint(
          input.workspacePath,
          input.actor,
          `Dispatch run ${input.runId} completed autonomous execution.`,
          {
            next: readyAfter.slice(0, 10).map((entry) => entry.path),
            blocked: blockedAfter.slice(0, 10).map((entry) => entry.path),
            tags: ['dispatch', 'autonomous-run'],
          },
        );
        pushLog(logs, 'info', `Checkpoint recorded for run ${input.runId}.`);
      } catch (error) {
        // Checkpoint creation is helpful but should not fail a completed run.
        pushLog(logs, 'warn', `Checkpoint creation skipped: ${errorMessage(error)}`);
      }
    }

    if (cancelled) {
      return {
        status: 'cancelled',
        output: summary,
        logs,
        metrics: {
          completed: completionCount,
          failed: failureCount,
          readyRemaining: readyAfter.length,
          openRemaining: openAfter.length,
          blockedRemaining: blockedAfter.length,
          elapsedMs,
          claimedByAgent,
          completedByAgent,
        },
      };
    }

    if (failureCount > 0) {
      return {
        status: 'failed',
        error: summary,
        logs,
        metrics: {
          completed: completionCount,
          failed: failureCount,
          readyRemaining: readyAfter.length,
          openRemaining: openAfter.length,
          blockedRemaining: blockedAfter.length,
          elapsedMs,
          claimedByAgent,
          completedByAgent,
        },
      };
    }

    const status = readyAfter.length === 0 && activeAfter.length === 0 ? 'succeeded' : 'failed';
    if (status === 'failed') {
      pushLog(logs, 'warn', 'Execution stopped with actionable work still remaining.');
    }

    return {
      status,
      output: summary,
      logs,
      metrics: {
        completed: completionCount,
        failed: failureCount,
        readyRemaining: readyAfter.length,
        openRemaining: openAfter.length,
        blockedRemaining: blockedAfter.length,
        elapsedMs,
        claimedByAgent,
        completedByAgent,
      },
    };
  }
}

function normalizeAgents(agents: string[] | undefined, actor: string): string[] {
  const fromInput = (agents ?? []).map((entry) => String(entry).trim()).filter(Boolean);
  if (fromInput.length > 0) return [...new Set(fromInput)];
  return Array.from({ length: DEFAULT_AGENT_COUNT }, (_, idx) => `${actor}-worker-${idx + 1}`);
}

function normalizeInt(
  rawValue: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number.isFinite(rawValue) ? Number(rawValue) : fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function pushLog(target: DispatchAdapterLogEntry[], level: DispatchAdapterLogEntry['level'], message: string): void {
  target.push({
    ts: new Date().toISOString(),
    level,
    message,
  });
}

function listReady(workspacePath: string, space: string | undefined) {
  return space
    ? thread.listReadyThreadsInSpace(workspacePath, space)
    : thread.listReadyThreads(workspacePath);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface CursorBrokerConfig {
  dispatchUrl: string;
  statusUrlTemplate: string;
  cancelUrlTemplate: string;
  token?: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
  json: Record<string, unknown> | null;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: init.signal ?? controller.signal,
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      text,
      json: safeParseJson(text),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function resolveCursorBrokerConfig(context: Record<string, unknown> | undefined): CursorBrokerConfig | null {
  const baseUrl = resolveUrl(
    context?.cursor_cloud_api_base_url,
    process.env.WORKGRAPH_CURSOR_CLOUD_API_BASE_URL,
  );
  const dispatchUrl = resolveUrl(
    context?.cursor_cloud_dispatch_url,
    baseUrl ? `${baseUrl}/runs` : undefined,
  );
  if (!dispatchUrl) return null;
  const statusUrlTemplate = readString(context?.cursor_cloud_status_url_template)
    ?? (baseUrl ? `${baseUrl}/runs/{externalRunId}` : undefined)
    ?? `${dispatchUrl.replace(/\/+$/, '')}/{externalRunId}`;
  const cancelUrlTemplate = readString(context?.cursor_cloud_cancel_url_template)
    ?? (baseUrl ? `${baseUrl}/runs/{externalRunId}/cancel` : undefined)
    ?? `${dispatchUrl.replace(/\/+$/, '')}/{externalRunId}/cancel`;
  return {
    dispatchUrl,
    statusUrlTemplate,
    cancelUrlTemplate,
    token: readString(context?.cursor_cloud_api_token) ?? readString(process.env.WORKGRAPH_CURSOR_CLOUD_API_TOKEN),
    headers: readHeaders(context?.cursor_cloud_headers),
    timeoutMs: normalizeInt(readNumber(context?.cursor_cloud_timeout_ms), DEFAULT_EXTERNAL_TIMEOUT_MS, 1_000, 120_000),
  };
}

function buildCursorHeaders(config: CursorBrokerConfig): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...config.headers,
    ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
  };
}

function resolveTemplate(template: string, externalRunId: string): string {
  return template.replaceAll('{externalRunId}', externalRunId);
}

function readHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (!key) continue;
    if (raw === undefined || raw === null) continue;
    headers[key.toLowerCase()] = String(raw);
  }
  return headers;
}

function safeParseJson(value: string): Record<string, unknown> | null {
  if (!value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readExternalRunId(value: Record<string, unknown> | null): string | undefined {
  return readString(value?.externalRunId)
    ?? readString(value?.external_run_id)
    ?? readString(value?.runId)
    ?? readString(value?.run_id)
    ?? readString(value?.id)
    ?? readString(value?.agentId)
    ?? readString(value?.agent_id);
}

function resolveUrl(...values: unknown[]): string | undefined {
  for (const value of values) {
    const candidate = readString(value);
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return url.toString();
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function normalizeRunStatus(value: unknown): RunStatus | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (
    normalized === 'queued'
    || normalized === 'running'
    || normalized === 'succeeded'
    || normalized === 'failed'
    || normalized === 'cancelled'
  ) {
    return normalized;
  }
  return undefined;
}

function compactStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((entry): entry is string => Boolean(entry && entry.trim())).map((entry) => entry.trim()))];
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function renderSummary(data: {
  objective: string;
  runId: string;
  completed: number;
  failed: number;
  stepsExecuted: number;
  readyRemaining: number;
  openRemaining: number;
  blockedRemaining: number;
  activeRemaining: number;
  elapsedMs: number;
  claimedByAgent: Record<string, number>;
  completedByAgent: Record<string, number>;
  cancelled: boolean;
}): string {
  const lines = [
    `Autonomous dispatch summary for ${data.runId}`,
    `Objective: ${data.objective}`,
    `Completed threads: ${data.completed}`,
    `Failed completions: ${data.failed}`,
    `Scheduler steps executed: ${data.stepsExecuted}`,
    `Ready remaining: ${data.readyRemaining}`,
    `Open remaining: ${data.openRemaining}`,
    `Blocked remaining: ${data.blockedRemaining}`,
    `Active remaining: ${data.activeRemaining}`,
    `Elapsed ms: ${data.elapsedMs}`,
    `Cancelled: ${data.cancelled ? 'yes' : 'no'}`,
    '',
    'Claims by agent:',
    ...Object.entries(data.claimedByAgent).map(([agent, count]) => `- ${agent}: ${count}`),
    '',
    'Completions by agent:',
    ...Object.entries(data.completedByAgent).map(([agent, count]) => `- ${agent}: ${count}`),
  ];
  return lines.join('\n');
}
