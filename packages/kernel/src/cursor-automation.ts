import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as dispatch from './dispatch.js';
import * as store from './store.js';
import * as thread from './thread.js';
import { appendDispatchRunAuditEvent } from './dispatch-run-audit.js';
import type { DispatchRun, DispatchRunEvidenceItem } from './types.js';

export const CURSOR_AUTOMATION_CONFIG_FILE = '.workgraph/cursor-automation.json';
export const CURSOR_AUTOMATION_SECRET_HEADER = 'x-workgraph-cursor-secret';

const DEFAULT_PROMPT_TEMPLATE = [
  'You are running inside Cursor Automations for WorkGraph.',
  '',
  '## Objective',
  '{{objective}}',
  '',
  '## Thread',
  '- Path: {{thread_path}}',
  '- Description: {{thread_description}}',
  '',
  '## Requirements',
  '{{requirements}}',
  '',
  '## Related Files',
  '{{related_files}}',
  '',
  '## Execution Contract',
  '- WorkGraph run id: {{run_id}}',
  '- Actor: {{actor}}',
  '- Apply code changes and run relevant tests.',
  '- Include PR URL and relevant logs in your completion callback.',
].join('\n');

const PR_URL_PATTERN = /\bhttps?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\b/gi;
const MAX_LOG_EVIDENCE_ITEMS = 50;
const MAX_LOG_VALUE_CHARS = 1200;

export interface CursorAutomationConfig {
  webhookUrl?: string;
  webhookToken?: string;
  inboundWebhookSecret?: string;
  resultWebhookUrl?: string;
  promptTemplate: string;
  updatedAt: string;
}

export interface CursorAutomationConfigPatch {
  webhookUrl?: string;
  webhookToken?: string;
  inboundWebhookSecret?: string;
  resultWebhookUrl?: string;
  promptTemplate?: string;
}

export interface CursorAutomationDispatchThreadContext {
  threadPath?: string;
  description: string;
  requirements: string[];
  relatedFiles: string[];
}

export interface CursorAutomationDispatchPayload {
  source: 'workgraph';
  event: 'workgraph.dispatch.requested';
  runId: string;
  actor: string;
  objective: string;
  prompt: string;
  thread: CursorAutomationDispatchThreadContext;
  context: Record<string, unknown>;
  callback?: {
    webhookUrl: string;
  };
  ts: string;
}

export interface CursorAutomationDispatchPayloadInput {
  workspacePath: string;
  runId: string;
  actor: string;
  objective: string;
  context?: Record<string, unknown>;
  promptTemplate?: string;
}

export interface CursorAutomationWebhookResult {
  runId: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  output?: string;
  error?: string;
  prUrl?: string;
  threadPath?: string;
  logs: string[];
  raw: Record<string, unknown>;
}

export interface IngestCursorAutomationWebhookOptions {
  actor?: string;
}

export interface CursorAutomationThreadSyncResult {
  attempted: boolean;
  updated: boolean;
  warning?: string;
}

export interface IngestCursorAutomationWebhookResult {
  runId: string;
  previousStatus: DispatchRun['status'];
  status: DispatchRun['status'];
  threadPath?: string;
  threadSync?: CursorAutomationThreadSyncResult;
  evidenceCount: number;
  prUrl?: string;
  warnings: string[];
}

export interface CursorAutomationConnectionStatus {
  configured: boolean;
  webhookUrl?: string;
  reachable: boolean;
  ok: boolean;
  statusCode?: number;
  latencyMs?: number;
  error?: string;
}

export interface CursorAutomationConnectionOptions {
  webhookUrl?: string;
  timeoutMs?: number;
}

export function cursorAutomationConfigPath(workspacePath: string): string {
  return path.join(workspacePath, CURSOR_AUTOMATION_CONFIG_FILE);
}

export function loadCursorAutomationConfig(workspacePath: string): CursorAutomationConfig {
  const targetPath = cursorAutomationConfigPath(workspacePath);
  if (!fs.existsSync(targetPath)) {
    return {
      promptTemplate: DEFAULT_PROMPT_TEMPLATE,
      updatedAt: new Date(0).toISOString(),
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(targetPath, 'utf-8')) as Record<string, unknown>;
    return normalizeCursorAutomationConfig(raw);
  } catch {
    return {
      promptTemplate: DEFAULT_PROMPT_TEMPLATE,
      updatedAt: new Date(0).toISOString(),
    };
  }
}

export function saveCursorAutomationConfig(
  workspacePath: string,
  patch: CursorAutomationConfigPatch,
): CursorAutomationConfig {
  const existing = loadCursorAutomationConfig(workspacePath);
  const next: CursorAutomationConfig = normalizeCursorAutomationConfig({
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
  const targetPath = cursorAutomationConfigPath(workspacePath);
  const directory = path.dirname(targetPath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(targetPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  return next;
}

export function resolveCursorAutomationDispatchUrl(
  workspacePath: string,
  context?: Record<string, unknown>,
): string | undefined {
  const config = loadCursorAutomationConfig(workspacePath);
  return firstValidHttpUrl(
    context?.cursor_webhook_url,
    context?.webhook_url,
    context?.automation_webhook_url,
    config.webhookUrl,
    process.env.WORKGRAPH_CURSOR_AUTOMATION_WEBHOOK_URL,
  );
}

export function resolveCursorAutomationDispatchToken(
  workspacePath: string,
  context?: Record<string, unknown>,
): string | undefined {
  const config = loadCursorAutomationConfig(workspacePath);
  return firstNonEmptyString(
    context?.cursor_webhook_token,
    context?.webhook_token,
    context?.automation_webhook_token,
    config.webhookToken,
    process.env.WORKGRAPH_CURSOR_AUTOMATION_WEBHOOK_TOKEN,
  );
}

export function resolveCursorAutomationResultWebhookUrl(
  workspacePath: string,
  context?: Record<string, unknown>,
): string | undefined {
  const config = loadCursorAutomationConfig(workspacePath);
  return firstValidHttpUrl(
    context?.workgraph_webhook_url,
    context?.result_webhook_url,
    config.resultWebhookUrl,
    process.env.WORKGRAPH_CURSOR_AUTOMATION_RESULT_WEBHOOK_URL,
  );
}

export function isCursorAutomationWebhookAuthorized(
  workspacePath: string,
  providedSecret: unknown,
): boolean {
  const config = loadCursorAutomationConfig(workspacePath);
  if (!config.inboundWebhookSecret) return true;
  return config.inboundWebhookSecret === readNonEmptyString(providedSecret);
}

export function buildCursorAutomationThreadContext(
  workspacePath: string,
  objective: string,
  context?: Record<string, unknown>,
): CursorAutomationDispatchThreadContext {
  const threadPath = resolveThreadPathFromContext(context);
  const threadInstance = threadPath ? store.read(workspacePath, threadPath) : null;
  const contextRequirements = toStringList(
    context?.requirements ?? context?.requirement_list ?? context?.acceptance_criteria,
  );
  const threadGoal = readNonEmptyString(threadInstance?.fields.goal);
  const description = firstNonEmptyString(
    context?.description,
    context?.thread_description,
    threadGoal,
    objective,
  ) ?? objective;
  const threadRelatedFiles = toStringList(threadInstance?.fields.context_refs);
  const relatedFiles = uniqueStrings([
    ...toStringList(context?.related_files ?? context?.relatedFiles),
    ...threadRelatedFiles,
    ...(threadPath ? [threadPath] : []),
  ]);
  return {
    ...(threadPath ? { threadPath } : {}),
    description,
    requirements: contextRequirements,
    relatedFiles,
  };
}

export function renderCursorAutomationPrompt(
  template: string | undefined,
  input: {
    runId: string;
    actor: string;
    objective: string;
    thread: CursorAutomationDispatchThreadContext;
  },
): string {
  const safeTemplate = readNonEmptyString(template) ?? DEFAULT_PROMPT_TEMPLATE;
  const replacements: Record<string, string> = {
    run_id: input.runId,
    actor: input.actor,
    objective: input.objective,
    thread_path: input.thread.threadPath ?? '(not provided)',
    thread_description: input.thread.description,
    requirements: renderBulletList(input.thread.requirements, '(none provided)'),
    related_files: renderBulletList(input.thread.relatedFiles, '(none provided)'),
  };
  return safeTemplate.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_full, token: string) => {
    const key = token.trim().toLowerCase();
    return replacements[key] ?? '';
  });
}

export function buildCursorAutomationDispatchPayload(
  input: CursorAutomationDispatchPayloadInput,
): CursorAutomationDispatchPayload {
  const threadContext = buildCursorAutomationThreadContext(
    input.workspacePath,
    input.objective,
    input.context,
  );
  const prompt = renderCursorAutomationPrompt(input.promptTemplate, {
    runId: input.runId,
    actor: input.actor,
    objective: input.objective,
    thread: threadContext,
  });
  const callbackUrl = resolveCursorAutomationResultWebhookUrl(input.workspacePath, input.context);
  return {
    source: 'workgraph',
    event: 'workgraph.dispatch.requested',
    runId: input.runId,
    actor: input.actor,
    objective: input.objective,
    prompt,
    thread: threadContext,
    context: {
      ...(input.context ?? {}),
      thread_path: threadContext.threadPath,
      related_files: threadContext.relatedFiles,
      requirements: threadContext.requirements,
    },
    ...(callbackUrl ? { callback: { webhookUrl: callbackUrl } } : {}),
    ts: new Date().toISOString(),
  };
}

export function normalizeCursorAutomationWebhookPayload(payload: unknown): CursorAutomationWebhookResult {
  const root = asRecord(payload);
  const result = asRecord(root.result);
  const metadata = asRecord(root.metadata);
  const context = asRecord(root.context);
  const run = asRecord(root.run);
  const runContext = asRecord(run.context);
  const logs = normalizeWebhookLogs(
    root.logs,
    result.logs,
    root.log,
    result.log,
    root.output,
    result.output,
  );
  const output = firstNonEmptyString(
    root.output,
    result.output,
    root.summary,
    result.summary,
    root.message,
  );
  const error = firstNonEmptyString(
    root.error,
    result.error,
    root.failure,
    result.failure,
    root.exception,
  );
  const status = normalizeWebhookStatus(
    firstNonEmptyString(
      root.status,
      result.status,
      run.status,
      root.conclusion,
      result.conclusion,
      root.state,
      result.state,
    ),
    firstBoolean(root.success, result.success, root.ok, result.ok),
  );
  const prUrl = firstValidHttpUrl(
    root.pr_url,
    root.prUrl,
    root.pull_request_url,
    root.pullRequestUrl,
    result.pr_url,
    result.prUrl,
    result.pull_request_url,
    result.pullRequestUrl,
    extractPrUrl([output, error, ...logs].filter((value): value is string => Boolean(value))),
  );
  const runId = firstNonEmptyString(
    root.run_id,
    root.runId,
    result.run_id,
    result.runId,
    metadata.run_id,
    metadata.runId,
    context.run_id,
    context.runId,
    run.id,
    run.run_id,
  );
  if (!runId) {
    throw new Error('Cursor automation webhook payload is missing runId.');
  }
  const threadPath = normalizeThreadPathRef(
    firstNonEmptyString(
      root.thread_path,
      root.threadPath,
      result.thread_path,
      result.threadPath,
      metadata.thread_path,
      metadata.threadPath,
      context.thread_path,
      context.threadPath,
      runContext.thread_path,
      runContext.threadPath,
    ),
  );
  return {
    runId,
    status,
    ...(output ? { output } : {}),
    ...(error ? { error } : {}),
    ...(prUrl ? { prUrl } : {}),
    ...(threadPath ? { threadPath } : {}),
    logs,
    raw: root,
  };
}

export function ingestCursorAutomationWebhook(
  workspacePath: string,
  payload: unknown,
  options: IngestCursorAutomationWebhookOptions = {},
): IngestCursorAutomationWebhookResult {
  const normalized = normalizeCursorAutomationWebhookPayload(payload);
  const initialRun = dispatch.status(workspacePath, normalized.runId);
  const actor = readNonEmptyString(options.actor) ?? initialRun.actor;
  const warnings: string[] = [];
  const now = new Date().toISOString();

  let current = initialRun;
  if (
    current.status === 'queued'
    && normalized.status !== 'running'
    && normalized.status !== 'cancelled'
  ) {
    current = dispatch.markRun(workspacePath, current.id, actor, 'running', {
      contextPatch: {
        cursor_automation_pending: true,
        cursor_automation_updated_at: now,
      },
    });
  }

  const desiredStatus = normalized.status;
  let updatedRun = current;
  if (isTerminalRunStatus(current.status) && current.status !== desiredStatus) {
    warnings.push(`Run ${current.id} is already terminal (${current.status}); ignoring webhook status ${desiredStatus}.`);
  } else {
    const output = composeWebhookOutput(normalized);
    const error = desiredStatus === 'failed' ? (normalized.error ?? output) : normalized.error;
    updatedRun = dispatch.markRun(workspacePath, current.id, actor, desiredStatus, {
      ...(output ? { output } : {}),
      ...(error ? { error } : {}),
      contextPatch: {
        cursor_automation_status: desiredStatus,
        cursor_automation_updated_at: now,
        ...(normalized.prUrl ? { cursor_automation_pr_url: normalized.prUrl } : {}),
        ...(normalized.threadPath ? { thread_path: normalized.threadPath } : {}),
      },
    });
  }

  const evidenceItems = buildWebhookEvidenceItems(updatedRun.id, normalized, now);
  if (evidenceItems.length > 0) {
    appendDispatchRunAuditEvent(workspacePath, {
      runId: updatedRun.id,
      actor,
      kind: 'run-evidence-collected',
      data: {
        items: evidenceItems,
        summary: {
          count: evidenceItems.length,
          byType: countEvidenceByType(evidenceItems),
          lastCollectedAt: now,
        },
      },
    });
  }

  const resolvedThreadPath = normalized.threadPath
    ?? normalizeThreadPathRef(readNonEmptyString(updatedRun.context?.thread_path))
    ?? normalizeThreadPathRef(readNonEmptyString(updatedRun.context?.threadPath));
  const threadSync = resolvedThreadPath
    ? syncThreadWithCursorResult(workspacePath, resolvedThreadPath, normalized, actor)
    : undefined;
  if (threadSync?.warning) {
    warnings.push(threadSync.warning);
  }

  const latest = dispatch.status(workspacePath, updatedRun.id);
  return {
    runId: latest.id,
    previousStatus: initialRun.status,
    status: latest.status,
    ...(resolvedThreadPath ? { threadPath: resolvedThreadPath } : {}),
    ...(threadSync ? { threadSync } : {}),
    evidenceCount: evidenceItems.length,
    ...(normalized.prUrl ? { prUrl: normalized.prUrl } : {}),
    warnings,
  };
}

export async function checkCursorAutomationConnection(
  workspacePath: string,
  options: CursorAutomationConnectionOptions = {},
): Promise<CursorAutomationConnectionStatus> {
  const webhookUrl = firstValidHttpUrl(
    options.webhookUrl,
    resolveCursorAutomationDispatchUrl(workspacePath),
  );
  if (!webhookUrl) {
    return {
      configured: false,
      reachable: false,
      ok: false,
      error: 'Cursor automation webhook URL is not configured.',
    };
  }
  const startedAt = Date.now();
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(webhookUrl, {
      method: 'HEAD',
      signal: controller.signal,
    });
    return {
      configured: true,
      webhookUrl,
      reachable: true,
      ok: response.ok,
      statusCode: response.status,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      configured: true,
      webhookUrl,
      reachable: false,
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function syncThreadWithCursorResult(
  workspacePath: string,
  threadPath: string,
  result: CursorAutomationWebhookResult,
  actor: string,
): CursorAutomationThreadSyncResult {
  const instance = store.read(workspacePath, threadPath);
  if (!instance) {
    return {
      attempted: true,
      updated: false,
      warning: `Thread not found for cursor webhook: ${threadPath}`,
    };
  }
  if (instance.type !== 'thread') {
    return {
      attempted: true,
      updated: false,
      warning: `Cursor webhook thread target is not a thread primitive: ${threadPath}`,
    };
  }
  if (result.status === 'running') {
    return {
      attempted: false,
      updated: false,
    };
  }
  try {
    if (result.status === 'succeeded') {
      ensureActiveThread(workspacePath, threadPath, actor);
      const refreshed = store.read(workspacePath, threadPath);
      if (String(refreshed?.fields.status ?? '') !== 'active') {
        return {
          attempted: true,
          updated: false,
          warning: `Thread ${threadPath} could not be moved to active before completion.`,
        };
      }
      thread.done(
        workspacePath,
        threadPath,
        actor,
        composeWebhookOutput(result),
        {
          evidence: [
            ...(result.prUrl ? [{ type: 'url' as const, value: result.prUrl }] : []),
            { type: 'reply-ref' as const, value: `thread:${result.runId}` },
          ],
        },
      );
      return {
        attempted: true,
        updated: true,
      };
    }
    if (result.status === 'failed') {
      ensureActiveThread(workspacePath, threadPath, actor);
      const refreshed = store.read(workspacePath, threadPath);
      if (String(refreshed?.fields.status ?? '') !== 'active') {
        return {
          attempted: true,
          updated: false,
          warning: `Thread ${threadPath} could not be moved to active before blocking.`,
        };
      }
      thread.block(
        workspacePath,
        threadPath,
        actor,
        'external/cursor-automation',
        result.error ?? 'Cursor automation reported a failure.',
      );
      return {
        attempted: true,
        updated: true,
      };
    }
    if (result.status === 'cancelled') {
      thread.cancel(
        workspacePath,
        threadPath,
        actor,
        result.error ?? 'Cursor automation run was cancelled.',
      );
      return {
        attempted: true,
        updated: true,
      };
    }
    return {
      attempted: false,
      updated: false,
    };
  } catch (error) {
    return {
      attempted: true,
      updated: false,
      warning: `Thread sync failed for ${threadPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function ensureActiveThread(workspacePath: string, threadPath: string, actor: string): void {
  const current = store.read(workspacePath, threadPath);
  if (!current || current.type !== 'thread') return;
  const status = String(current.fields.status ?? '');
  if (status === 'active') return;
  if (status === 'open') {
    thread.claim(workspacePath, threadPath, actor);
    return;
  }
  if (status === 'blocked') {
    thread.unblock(workspacePath, threadPath, actor);
    return;
  }
}

function buildWebhookEvidenceItems(
  runId: string,
  result: CursorAutomationWebhookResult,
  ts: string,
): DispatchRunEvidenceItem[] {
  const items: DispatchRunEvidenceItem[] = [];
  if (result.output) {
    items.push(makeEvidenceItem(runId, ts, 'stdout', 'adapter-output', clampValue(result.output)));
  }
  if (result.error) {
    items.push(makeEvidenceItem(runId, ts, 'error', 'adapter-error', clampValue(result.error)));
  }
  if (result.prUrl) {
    items.push(makeEvidenceItem(runId, ts, 'pr-url', 'derived', result.prUrl));
  }
  for (const logLine of result.logs.slice(0, MAX_LOG_EVIDENCE_ITEMS)) {
    items.push(makeEvidenceItem(runId, ts, 'log', 'adapter-log', clampValue(logLine)));
  }
  return dedupeEvidenceItems(items);
}

function makeEvidenceItem(
  runId: string,
  ts: string,
  type: DispatchRunEvidenceItem['type'],
  source: DispatchRunEvidenceItem['source'],
  value: string,
): DispatchRunEvidenceItem {
  return {
    id: `runev_${randomUUID()}`,
    runId,
    ts,
    type,
    source,
    value,
  };
}

function dedupeEvidenceItems(items: DispatchRunEvidenceItem[]): DispatchRunEvidenceItem[] {
  const seen = new Set<string>();
  const deduped: DispatchRunEvidenceItem[] = [];
  for (const item of items) {
    const key = `${item.type}:${item.source}:${item.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function countEvidenceByType(items: DispatchRunEvidenceItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item.type] = (counts[item.type] ?? 0) + 1;
  }
  return counts;
}

function normalizeWebhookLogs(...inputs: unknown[]): string[] {
  const lines: string[] = [];
  for (const input of inputs) {
    if (input === undefined || input === null) continue;
    if (typeof input === 'string') {
      for (const line of input.split('\n')) {
        const normalized = line.trim();
        if (normalized) lines.push(normalized);
      }
      continue;
    }
    if (Array.isArray(input)) {
      for (const item of input) {
        if (typeof item === 'string') {
          const normalized = item.trim();
          if (normalized) lines.push(normalized);
          continue;
        }
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          const message = readNonEmptyString(record.message) ?? readNonEmptyString(record.log);
          if (!message) continue;
          const level = readNonEmptyString(record.level);
          lines.push(level ? `[${level}] ${message}` : message);
        }
      }
    }
  }
  return uniqueStrings(lines);
}

function composeWebhookOutput(result: CursorAutomationWebhookResult): string | undefined {
  const output = readNonEmptyString(result.output);
  const lines = output ? [output] : [];
  if (result.prUrl) {
    lines.push(`PR: ${result.prUrl}`);
  }
  if (!output && result.logs.length > 0) {
    lines.push(...result.logs.slice(0, 20));
  }
  if (lines.length === 0) return undefined;
  return lines.join('\n');
}

function normalizeCursorAutomationConfig(input: Record<string, unknown>): CursorAutomationConfig {
  return {
    ...(firstValidHttpUrl(input.webhookUrl) ? { webhookUrl: firstValidHttpUrl(input.webhookUrl) } : {}),
    ...(readNonEmptyString(input.webhookToken) ? { webhookToken: readNonEmptyString(input.webhookToken) } : {}),
    ...(readNonEmptyString(input.inboundWebhookSecret)
      ? { inboundWebhookSecret: readNonEmptyString(input.inboundWebhookSecret) }
      : {}),
    ...(firstValidHttpUrl(input.resultWebhookUrl)
      ? { resultWebhookUrl: firstValidHttpUrl(input.resultWebhookUrl) }
      : {}),
    promptTemplate: readNonEmptyString(input.promptTemplate) ?? DEFAULT_PROMPT_TEMPLATE,
    updatedAt: readNonEmptyString(input.updatedAt) ?? new Date().toISOString(),
  };
}

function normalizeWebhookStatus(
  rawStatus: string | undefined,
  successFlag: boolean | undefined,
): CursorAutomationWebhookResult['status'] {
  const normalized = String(rawStatus ?? '').trim().toLowerCase();
  if (normalized === 'succeeded' || normalized === 'success' || normalized === 'completed' || normalized === 'complete' || normalized === 'passed' || normalized === 'ok') {
    return 'succeeded';
  }
  if (normalized === 'failed' || normalized === 'failure' || normalized === 'error' || normalized === 'errored') {
    return 'failed';
  }
  if (normalized === 'cancelled' || normalized === 'canceled' || normalized === 'aborted') {
    return 'cancelled';
  }
  if (normalized === 'running' || normalized === 'pending' || normalized === 'queued' || normalized === 'in_progress') {
    return 'running';
  }
  if (successFlag === true) return 'succeeded';
  if (successFlag === false) return 'failed';
  return 'running';
}

function isTerminalRunStatus(status: DispatchRun['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function resolveThreadPathFromContext(context: Record<string, unknown> | undefined): string | undefined {
  return normalizeThreadPathRef(
    firstNonEmptyString(
      context?.thread_path,
      context?.threadPath,
      context?.thread_ref,
      context?.threadRef,
    ),
  );
}

function normalizeThreadPathRef(value: string | undefined): string | undefined {
  const raw = readNonEmptyString(value);
  if (!raw) return undefined;
  const cleaned = raw.startsWith('[[') && raw.endsWith(']]')
    ? raw.slice(2, -2)
    : raw;
  if (cleaned.includes('/')) {
    return cleaned.endsWith('.md') ? cleaned : `${cleaned}.md`;
  }
  return `threads/${cleaned.endsWith('.md') ? cleaned : `${cleaned}.md`}`;
}

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniqueStrings(value.map((entry) => String(entry).trim()).filter(Boolean));
  }
  if (typeof value === 'string') {
    return uniqueStrings(
      value
        .split('\n')
        .flatMap((line) => line.split(','))
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
  }
  return [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function renderBulletList(values: string[], fallback: string): string {
  if (values.length === 0) return fallback;
  return values.map((value) => `- ${value}`).join('\n');
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const parsed = readNonEmptyString(value);
    if (parsed) return parsed;
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') continue;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return undefined;
}

function firstValidHttpUrl(...values: unknown[]): string | undefined {
  for (const value of values) {
    const candidate = readNonEmptyString(value);
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.toString();
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function extractPrUrl(lines: string[]): string | undefined {
  const blob = lines.join('\n');
  const matches = blob.match(PR_URL_PATTERN);
  if (!matches || matches.length === 0) return undefined;
  return matches[0];
}

function clampValue(value: string): string {
  if (value.length <= MAX_LOG_VALUE_CHARS) return value;
  return `${value.slice(0, MAX_LOG_VALUE_CHARS)}...[truncated]`;
}

function normalizeTimeoutMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.min(60_000, Math.max(250, Math.trunc(value)));
  }
  return 5_000;
}
