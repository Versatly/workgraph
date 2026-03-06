import type {
  DispatchAdapter,
  DispatchAdapterCreateInput,
  DispatchAdapterExecutionInput,
  DispatchAdapterExecutionResult,
  DispatchAdapterLogEntry,
  DispatchAdapterRunStatus,
} from './runtime-adapter-contracts.js';
import {
  buildCursorAutomationDispatchPayload,
  loadCursorAutomationConfig,
  resolveCursorAutomationDispatchToken,
  resolveCursorAutomationDispatchUrl,
} from './cursor-bridge.js';

export class CursorAutomationAdapter implements DispatchAdapter {
  name = 'cursor-bridge';
  supportsDeferredCompletion = true;

  async create(_input: DispatchAdapterCreateInput): Promise<DispatchAdapterRunStatus> {
    return {
      runId: 'cursor-automation-managed',
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

  async execute(input: DispatchAdapterExecutionInput): Promise<DispatchAdapterExecutionResult> {
    const logs: DispatchAdapterLogEntry[] = [];
    const webhookUrl = resolveCursorAutomationDispatchUrl(input.workspacePath, input.context);
    if (!webhookUrl) {
      return {
        status: 'failed',
        error: 'cursor-bridge adapter requires --webhook-url, context.cursor_webhook_url, or configured cursor setup.',
        logs,
      };
    }
    const config = loadCursorAutomationConfig(input.workspacePath);
    const token = resolveCursorAutomationDispatchToken(input.workspacePath, input.context);
    const promptTemplate = readNonEmptyString(input.context?.cursor_prompt_template)
      ?? config.promptTemplate;
    const payload = buildCursorAutomationDispatchPayload({
      workspacePath: input.workspacePath,
      runId: input.runId,
      actor: input.actor,
      objective: input.objective,
      context: input.context,
      promptTemplate,
    });

    pushLog(logs, 'info', `cursor-bridge dispatching run ${input.runId} to ${webhookUrl}`);
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-workgraph-source': 'workgraph-dispatch',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    const rawText = await response.text();
    const body = safeParseJson(rawText);
    pushLog(logs, response.ok ? 'info' : 'error', `cursor-bridge response status=${response.status}`);
    if (!response.ok) {
      return {
        status: 'failed',
        error: `cursor-bridge dispatch failed (${response.status}): ${rawText || response.statusText}`,
        logs,
      };
    }

    const immediateStatus = normalizeImmediateStatus(
      readNonEmptyString(body?.status)
      ?? readNonEmptyString(body?.state)
      ?? readNonEmptyString(body?.conclusion),
    );
    if (immediateStatus && immediateStatus !== 'running') {
      return {
        status: immediateStatus,
        output: readNonEmptyString(body?.output) ?? rawText,
        error: readNonEmptyString(body?.error),
        logs,
        metrics: {
          adapter: this.name,
          httpStatus: response.status,
          webhookUrl,
          ...(readNonEmptyString(body?.automationRunId)
            ? { automationRunId: readNonEmptyString(body?.automationRunId) }
            : {}),
        },
      };
    }

    const acknowledgment = [
      'Cursor automation request accepted.',
      ...(readNonEmptyString(body?.automationRunId) ? [`automationRunId=${String(body?.automationRunId)}`] : []),
      ...(readNonEmptyString(body?.message) ? [String(body?.message)] : []),
    ].join(' ');

    return {
      status: 'running',
      output: acknowledgment,
      logs,
      metrics: {
        adapter: this.name,
        httpStatus: response.status,
        webhookUrl,
        ...(readNonEmptyString(body?.automationRunId)
          ? { automationRunId: readNonEmptyString(body?.automationRunId) }
          : {}),
      },
    };
  }
}

function normalizeImmediateStatus(
  status: string | undefined,
): DispatchAdapterExecutionResult['status'] | undefined {
  const normalized = String(status ?? '').trim().toLowerCase();
  if (normalized === 'succeeded' || normalized === 'success' || normalized === 'completed') {
    return 'succeeded';
  }
  if (normalized === 'failed' || normalized === 'failure' || normalized === 'error') {
    return 'failed';
  }
  if (normalized === 'cancelled' || normalized === 'canceled') {
    return 'cancelled';
  }
  if (normalized === 'running' || normalized === 'pending' || normalized === 'queued') {
    return 'running';
  }
  return undefined;
}

function pushLog(target: DispatchAdapterLogEntry[], level: DispatchAdapterLogEntry['level'], message: string): void {
  target.push({
    ts: new Date().toISOString(),
    level,
    message,
  });
}

function safeParseJson(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
