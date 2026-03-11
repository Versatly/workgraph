import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as dispatch from './dispatch.js';
import * as transport from './transport/index.js';
import type { DispatchRun, RunStatus } from './types.js';

const CURSOR_BRIDGE_CONFIG_FILE = '.workgraph/cursor-bridge.json';
const CURSOR_BRIDGE_EVENTS_FILE = '.workgraph/cursor-bridge-events.jsonl';
const CURSOR_BRIDGE_VERSION = 1;
const DEFAULT_ALLOWED_EVENT_TYPES = ['*'];
const DEFAULT_DISPATCH_ADAPTER = 'cursor-cloud';
const DEFAULT_DISPATCH_ACTOR = 'cursor-bridge';

export interface CursorBridgeConfig {
  version: number;
  enabled: boolean;
  provider: 'cursor-automations';
  createdAt: string;
  updatedAt: string;
  webhook: {
    secret?: string;
    allowedEventTypes: string[];
  };
  dispatch: {
    actor: string;
    adapter: string;
    execute: boolean;
    agents?: string[];
    maxSteps?: number;
    stepDelayMs?: number;
    space?: string;
    createCheckpoint: boolean;
    timeoutMs?: number;
    dispatchMode?: 'direct' | 'self-assembly';
  };
}

export interface CursorBridgeStatus {
  configured: boolean;
  enabled: boolean;
  provider: CursorBridgeConfig['provider'];
  configPath: string;
  eventsPath: string;
  webhook: {
    hasSecret: boolean;
    allowedEventTypes: string[];
  };
  dispatch: CursorBridgeConfig['dispatch'];
  recentEvents: CursorBridgeEventRecord[];
}

export interface CursorBridgeSetupInput {
  actor?: string;
  enabled?: boolean;
  secret?: string;
  allowedEventTypes?: string[];
  dispatch?: Partial<CursorBridgeConfig['dispatch']>;
}

export interface CursorBridgeDispatchInput {
  source?: CursorBridgeEventSource;
  eventId?: string;
  eventType?: string;
  objective?: string;
  actor?: string;
  adapter?: string;
  execute?: boolean;
  context?: Record<string, unknown>;
  idempotencyKey?: string;
  agents?: string[];
  maxSteps?: number;
  stepDelayMs?: number;
  space?: string;
  createCheckpoint?: boolean;
  timeoutMs?: number;
  dispatchMode?: 'direct' | 'self-assembly';
}

export interface CursorAutomationWebhookInput {
  body: string;
  headers?: Record<string, string | string[] | undefined>;
  signature?: string;
  timestamp?: string;
}

export interface CursorBridgeDispatchResult {
  run: DispatchRun;
  event: CursorBridgeEventRecord;
}

export type CursorBridgeEventSource = 'webhook' | 'cli-dispatch';

export interface CursorBridgeEventRecord {
  id: string;
  ts: string;
  source: CursorBridgeEventSource;
  eventId?: string;
  eventType: string;
  objective: string;
  runId?: string;
  runStatus?: RunStatus;
  adapter?: string;
  actor?: string;
  error?: string;
}

interface CursorAutomationEventPayload {
  id?: unknown;
  type?: unknown;
  event_type?: unknown;
  objective?: unknown;
  actor?: unknown;
  adapter?: unknown;
  execute?: unknown;
  context?: unknown;
  metadata?: unknown;
}

interface CursorBridgeEventRecordFile extends CursorBridgeEventRecord {
  runStatus?: RunStatus;
}

export function cursorBridgeConfigPath(workspacePath: string): string {
  return path.join(workspacePath, CURSOR_BRIDGE_CONFIG_FILE);
}

export function cursorBridgeEventsPath(workspacePath: string): string {
  return path.join(workspacePath, CURSOR_BRIDGE_EVENTS_FILE);
}

export function setupCursorBridge(workspacePath: string, input: CursorBridgeSetupInput = {}): CursorBridgeConfig {
  const now = new Date().toISOString();
  const existing = loadCursorBridgeConfig(workspacePath);
  const actor = readNonEmptyString(input.actor) ?? existing.dispatch.actor ?? DEFAULT_DISPATCH_ACTOR;
  const dispatchDefaults = {
    ...(existing.dispatch ?? defaultCursorBridgeConfig().dispatch),
    ...(normalizeDispatchDefaults(input.dispatch) ?? {}),
  };
  const allowedEventTypes = input.allowedEventTypes
    ? normalizeAllowedEventTypes(input.allowedEventTypes)
    : existing.webhook.allowedEventTypes;
  const secret = input.secret !== undefined
    ? readNonEmptyString(input.secret)
    : existing.webhook.secret;

  const next: CursorBridgeConfig = {
    ...existing,
    enabled: input.enabled ?? existing.enabled,
    updatedAt: now,
    webhook: {
      secret,
      allowedEventTypes,
    },
    dispatch: {
      ...dispatchDefaults,
      actor,
    },
  };
  writeCursorBridgeConfig(workspacePath, next);
  return next;
}

export function loadCursorBridgeConfig(workspacePath: string): CursorBridgeConfig {
  const cfgPath = cursorBridgeConfigPath(workspacePath);
  if (!fs.existsSync(cfgPath)) {
    return defaultCursorBridgeConfig();
  }
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as unknown;
    return normalizeCursorBridgeConfig(raw);
  } catch {
    return defaultCursorBridgeConfig();
  }
}

export function getCursorBridgeStatus(
  workspacePath: string,
  options: { recentEventsLimit?: number } = {},
): CursorBridgeStatus {
  const configPath = cursorBridgeConfigPath(workspacePath);
  const configured = fs.existsSync(configPath);
  const config = loadCursorBridgeConfig(workspacePath);
  return {
    configured,
    enabled: config.enabled,
    provider: config.provider,
    configPath,
    eventsPath: cursorBridgeEventsPath(workspacePath),
    webhook: {
      hasSecret: typeof config.webhook.secret === 'string' && config.webhook.secret.length > 0,
      allowedEventTypes: [...config.webhook.allowedEventTypes],
    },
    dispatch: {
      ...config.dispatch,
      ...(config.dispatch.agents ? { agents: [...config.dispatch.agents] } : {}),
    },
    recentEvents: listCursorBridgeEvents(workspacePath, {
      limit: options.recentEventsLimit ?? 5,
    }),
  };
}

export async function receiveCursorAutomationWebhook(
  workspacePath: string,
  input: CursorAutomationWebhookInput,
): Promise<CursorBridgeDispatchResult> {
  const config = loadCursorBridgeConfig(workspacePath);
  if (!config.enabled) {
    throw new Error('Cursor bridge is disabled. Run `workgraph cursor setup --enabled true` to enable it.');
  }
  const payload = parseCursorAutomationWebhookBody(input.body);
  const eventType = readNonEmptyString(payload.type) ?? readNonEmptyString(payload.event_type);
  if (!eventType) {
    throw new Error('Cursor webhook payload is missing required "type".');
  }
  if (!eventTypeMatches(config.webhook.allowedEventTypes, eventType)) {
    throw new Error(`Cursor webhook event type "${eventType}" is not allowed by bridge configuration.`);
  }
  const webhookSecret = readNonEmptyString(config.webhook.secret);
  if (webhookSecret) {
    const headers = normalizeHeaderMap(input.headers);
    const signature = readNonEmptyString(input.signature)
      ?? readHeader(headers, 'x-cursor-signature')
      ?? readHeader(headers, 'x-workgraph-signature');
    if (!signature) {
      throw new Error('Cursor webhook is missing required signature header.');
    }
    const timestamp = readNonEmptyString(input.timestamp)
      ?? readHeader(headers, 'x-cursor-timestamp')
      ?? readHeader(headers, 'x-workgraph-timestamp');
    const verified = verifyCursorBridgeWebhookSignature({
      secret: webhookSecret,
      body: input.body,
      signature,
      timestamp,
    });
    if (!verified) {
      throw new Error('Invalid Cursor webhook signature.');
    }
  }
  const context = asRecord(payload.context);
  const metadata = asRecord(payload.metadata);
  return dispatchCursorAutomationEvent(workspacePath, {
    source: 'webhook',
    eventId: readNonEmptyString(payload.id),
    eventType,
    objective: readNonEmptyString(payload.objective),
    actor: readNonEmptyString(payload.actor),
    adapter: readNonEmptyString(payload.adapter),
    execute: normalizeOptionalBoolean(payload.execute),
    context: {
      ...context,
      ...(Object.keys(metadata).length > 0 ? { cursor_metadata: metadata } : {}),
    },
  });
}

export async function dispatchCursorAutomationEvent(
  workspacePath: string,
  input: CursorBridgeDispatchInput,
): Promise<CursorBridgeDispatchResult> {
  const config = loadCursorBridgeConfig(workspacePath);
  if (!config.enabled) {
    throw new Error('Cursor bridge is disabled. Run `workgraph cursor setup --enabled true` to enable it.');
  }

  const source = input.source ?? 'cli-dispatch';
  const eventType = readNonEmptyString(input.eventType) ?? 'cursor.automation.manual';
  if (!eventTypeMatches(config.webhook.allowedEventTypes, eventType)) {
    throw new Error(`Cursor event type "${eventType}" is not allowed by bridge configuration.`);
  }
  const eventId = readNonEmptyString(input.eventId);
  const objective = readNonEmptyString(input.objective) ?? defaultObjectiveForEvent(eventType, eventId);
  const actor = readNonEmptyString(input.actor) ?? config.dispatch.actor;
  const adapter = readNonEmptyString(input.adapter) ?? config.dispatch.adapter;
  const execute = input.execute ?? config.dispatch.execute;
  const bridgeContext = buildBridgeDispatchContext({
    eventType,
    eventId,
    source,
    objective,
    context: input.context,
  });
  const idempotencyKey = readNonEmptyString(input.idempotencyKey)
    ?? (eventId ? `cursor-bridge:${eventType}:${eventId}` : undefined);
  const envelope = transport.createTransportEnvelope({
    direction: 'outbound',
    channel: 'runtime-bridge',
    topic: eventType,
    source: `cursor-bridge:${source}`,
    target: adapter,
    provider: 'cursor-automations',
    correlationId: eventId,
    dedupKeys: [
      ...(eventId ? [`cursor-event:${eventId}`] : []),
      `cursor-topic:${eventType}:${objective}`,
    ],
    payload: {
      source,
      eventId,
      eventType,
      objective,
      actor,
      adapter,
      execute,
      context: bridgeContext,
    },
  });
  const outbox = transport.createTransportOutboxRecord(workspacePath, {
    envelope,
    deliveryHandler: 'runtime-bridge',
    deliveryTarget: adapter,
    message: `Dispatching cursor bridge event ${eventType} to adapter ${adapter}.`,
  });

  let run: DispatchRun | undefined;
  try {
    run = dispatch.createRun(workspacePath, {
      actor,
      adapter,
      objective,
      idempotencyKey,
      context: bridgeContext,
    });
    if (execute) {
      run = await dispatch.executeRun(workspacePath, run.id, {
        actor,
        agents: input.agents ?? config.dispatch.agents,
        maxSteps: input.maxSteps ?? config.dispatch.maxSteps,
        stepDelayMs: input.stepDelayMs ?? config.dispatch.stepDelayMs,
        space: input.space ?? config.dispatch.space,
        createCheckpoint: input.createCheckpoint ?? config.dispatch.createCheckpoint,
        timeoutMs: input.timeoutMs ?? config.dispatch.timeoutMs,
        dispatchMode: input.dispatchMode ?? config.dispatch.dispatchMode,
      });
    }
    const record: CursorBridgeEventRecord = {
      id: `cbe_${randomUUID()}`,
      ts: new Date().toISOString(),
      source,
      eventId,
      eventType,
      objective,
      runId: run.id,
      runStatus: run.status,
      adapter,
      actor,
    };
    appendCursorBridgeEvent(workspacePath, record);
    transport.markTransportOutboxDelivered(workspacePath, outbox.id, `Cursor bridge event ${eventType} dispatched successfully.`);
    return { run, event: record };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendCursorBridgeEvent(workspacePath, {
      id: `cbe_${randomUUID()}`,
      ts: new Date().toISOString(),
      source,
      eventId,
      eventType,
      objective,
      runId: run?.id,
      runStatus: run?.status,
      adapter,
      actor,
      error: message,
    });
    transport.markTransportOutboxFailed(workspacePath, outbox.id, {
      message,
      context: {
        eventType,
        eventId,
        adapter,
        runId: run?.id,
      },
    });
    throw error;
  }
}

export function listCursorBridgeEvents(
  workspacePath: string,
  options: { limit?: number } = {},
): CursorBridgeEventRecord[] {
  const eventsPath = cursorBridgeEventsPath(workspacePath);
  if (!fs.existsSync(eventsPath)) return [];
  const lines = fs.readFileSync(eventsPath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed = lines
    .map((line) => {
      try {
        return normalizeCursorBridgeEventRecord(JSON.parse(line) as unknown);
      } catch {
        return null;
      }
    })
    .filter((entry): entry is CursorBridgeEventRecord => entry !== null);
  parsed.sort((a, b) => b.ts.localeCompare(a.ts));
  const limit = clampPositiveInt(options.limit, parsed.length);
  return parsed.slice(0, limit);
}

export function createCursorBridgeWebhookSignature(input: {
  secret: string;
  body: string;
  timestamp?: string;
}): string {
  const payload = signaturePayload(input.body, input.timestamp);
  const digest = crypto.createHmac('sha256', input.secret).update(payload).digest('hex');
  return `sha256=${digest}`;
}

export function verifyCursorBridgeWebhookSignature(input: {
  secret: string;
  body: string;
  signature: string;
  timestamp?: string;
}): boolean {
  const provided = normalizeSignature(input.signature);
  if (!provided) return false;
  const expected = createCursorBridgeWebhookSignature({
    secret: input.secret,
    body: input.body,
    timestamp: input.timestamp,
  });
  return timingSafeEqual(provided, expected);
}

function defaultCursorBridgeConfig(now: string = new Date().toISOString()): CursorBridgeConfig {
  return {
    version: CURSOR_BRIDGE_VERSION,
    enabled: false,
    provider: 'cursor-automations',
    createdAt: now,
    updatedAt: now,
    webhook: {
      allowedEventTypes: [...DEFAULT_ALLOWED_EVENT_TYPES],
    },
    dispatch: {
      actor: DEFAULT_DISPATCH_ACTOR,
      adapter: DEFAULT_DISPATCH_ADAPTER,
      execute: false,
      createCheckpoint: true,
    },
  };
}

function writeCursorBridgeConfig(workspacePath: string, config: CursorBridgeConfig): void {
  const normalized = normalizeCursorBridgeConfig(config);
  const cfgPath = cursorBridgeConfigPath(workspacePath);
  const dir = path.dirname(cfgPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(normalized, null, 2) + '\n', 'utf-8');
}

function appendCursorBridgeEvent(workspacePath: string, event: CursorBridgeEventRecord): void {
  const normalized = normalizeCursorBridgeEventRecord(event);
  if (!normalized) return;
  const filePath = cursorBridgeEventsPath(workspacePath);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify(normalized) + '\n';
  fs.appendFileSync(filePath, payload, 'utf-8');
}

function normalizeCursorBridgeConfig(raw: unknown): CursorBridgeConfig {
  const defaults = defaultCursorBridgeConfig();
  const root = asRecord(raw);
  const createdAt = readNonEmptyString(root.createdAt) ?? defaults.createdAt;
  const updatedAt = readNonEmptyString(root.updatedAt) ?? createdAt;
  const webhookRoot = asRecord(root.webhook);
  const dispatchRoot = asRecord(root.dispatch);
  const dispatchDefaults = normalizeDispatchDefaults(dispatchRoot) ?? {};

  return {
    version: CURSOR_BRIDGE_VERSION,
    enabled: asBoolean(root.enabled, defaults.enabled),
    provider: 'cursor-automations',
    createdAt,
    updatedAt,
    webhook: {
      secret: readNonEmptyString(webhookRoot.secret),
      allowedEventTypes: normalizeAllowedEventTypes(
        asStringArray(webhookRoot.allowedEventTypes).length > 0
          ? asStringArray(webhookRoot.allowedEventTypes)
          : defaults.webhook.allowedEventTypes,
      ),
    },
    dispatch: {
      ...defaults.dispatch,
      ...dispatchDefaults,
      actor: readNonEmptyString(dispatchRoot.actor) ?? dispatchDefaults.actor ?? defaults.dispatch.actor,
      adapter: readNonEmptyString(dispatchRoot.adapter) ?? dispatchDefaults.adapter ?? defaults.dispatch.adapter,
      createCheckpoint: asBoolean(
        dispatchRoot.createCheckpoint,
        dispatchDefaults.createCheckpoint ?? defaults.dispatch.createCheckpoint,
      ),
      execute: asBoolean(dispatchRoot.execute, dispatchDefaults.execute ?? defaults.dispatch.execute),
    },
  };
}

function normalizeDispatchDefaults(
  value: unknown,
): Partial<CursorBridgeConfig['dispatch']> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  const actor = readNonEmptyString(root.actor);
  const adapter = readNonEmptyString(root.adapter);
  const execute = normalizeOptionalBoolean(root.execute);
  const agents = normalizeStringArray(root.agents);
  const maxSteps = normalizePositiveInt(root.maxSteps);
  const stepDelayMs = normalizeNonNegativeInt(root.stepDelayMs);
  const space = readNonEmptyString(root.space);
  const createCheckpoint = normalizeOptionalBoolean(root.createCheckpoint);
  const timeoutMs = normalizePositiveInt(root.timeoutMs);
  const dispatchMode = normalizeDispatchMode(root.dispatchMode);

  return {
    ...(actor ? { actor } : {}),
    ...(adapter ? { adapter } : {}),
    ...(typeof execute === 'boolean' ? { execute } : {}),
    ...(agents ? { agents } : {}),
    ...(typeof maxSteps === 'number' ? { maxSteps } : {}),
    ...(typeof stepDelayMs === 'number' ? { stepDelayMs } : {}),
    ...(space ? { space } : {}),
    ...(typeof createCheckpoint === 'boolean' ? { createCheckpoint } : {}),
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
    ...(dispatchMode ? { dispatchMode } : {}),
  };
}

function normalizeAllowedEventTypes(value: string[]): string[] {
  const normalized = value
    .map((item) => String(item).trim())
    .filter(Boolean);
  if (normalized.length === 0) return [...DEFAULT_ALLOWED_EVENT_TYPES];
  return [...new Set(normalized)];
}

function normalizeStringArray(value: unknown): string[] | undefined {
  const values = asStringArray(value)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (values.length === 0) return undefined;
  return [...new Set(values)];
}

function normalizeCursorBridgeEventRecord(raw: unknown): CursorBridgeEventRecord | null {
  const root = asRecord(raw);
  const id = readNonEmptyString(root.id);
  const ts = readNonEmptyString(root.ts);
  const source = normalizeSource(root.source);
  const eventType = readNonEmptyString(root.eventType);
  const objective = readNonEmptyString(root.objective);
  if (!id || !ts || !source || !eventType || !objective) {
    return null;
  }
  const runStatus = normalizeRunStatus(root.runStatus);
  return {
    id,
    ts,
    source,
    eventType,
    objective,
    ...(readNonEmptyString(root.eventId) ? { eventId: readNonEmptyString(root.eventId) } : {}),
    ...(readNonEmptyString(root.runId) ? { runId: readNonEmptyString(root.runId) } : {}),
    ...(runStatus ? { runStatus } : {}),
    ...(readNonEmptyString(root.adapter) ? { adapter: readNonEmptyString(root.adapter) } : {}),
    ...(readNonEmptyString(root.actor) ? { actor: readNonEmptyString(root.actor) } : {}),
    ...(readNonEmptyString(root.error) ? { error: readNonEmptyString(root.error) } : {}),
  };
}

function parseCursorAutomationWebhookBody(body: string): CursorAutomationEventPayload {
  const raw = String(body ?? '').trim();
  if (!raw) throw new Error('Cursor webhook body is empty.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Cursor webhook body must be valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Cursor webhook payload must be a JSON object.');
  }
  return parsed as CursorAutomationEventPayload;
}

function normalizeHeaderMap(
  value: Record<string, string | string[] | undefined> | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (!value) return normalized;
  for (const [key, raw] of Object.entries(value)) {
    const normalizedKey = key.trim().toLowerCase();
    if (!normalizedKey) continue;
    if (Array.isArray(raw)) {
      const joined = raw.map((item) => String(item).trim()).filter(Boolean).join(',');
      if (joined) normalized[normalizedKey] = joined;
      continue;
    }
    const text = String(raw ?? '').trim();
    if (text) normalized[normalizedKey] = text;
  }
  return normalized;
}

function readHeader(headers: Record<string, string>, name: string): string | undefined {
  const value = headers[name.trim().toLowerCase()];
  return readNonEmptyString(value);
}

function buildBridgeDispatchContext(input: {
  eventType: string;
  eventId?: string;
  source: CursorBridgeEventSource;
  objective: string;
  context?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    ...(input.context ?? {}),
    cursor_bridge: {
      event_type: input.eventType,
      event_id: input.eventId,
      source: input.source,
      objective: input.objective,
      received_at: new Date().toISOString(),
    },
  };
}

function defaultObjectiveForEvent(eventType: string, eventId?: string): string {
  return eventId
    ? `Cursor automation event ${eventType} (${eventId})`
    : `Cursor automation event ${eventType}`;
}

function signaturePayload(body: string, timestamp?: string): string {
  const normalizedBody = String(body ?? '');
  const normalizedTimestamp = readNonEmptyString(timestamp);
  return normalizedTimestamp ? `${normalizedTimestamp}.${normalizedBody}` : normalizedBody;
}

function normalizeSignature(value: string): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const normalized = raw.toLowerCase().startsWith('sha256=') ? raw : `sha256=${raw}`;
  return normalized;
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function eventTypeMatches(allowedEventTypes: string[], eventType: string): boolean {
  if (allowedEventTypes.length === 0) return true;
  return allowedEventTypes.some((pattern) => {
    if (pattern === '*') return true;
    if (pattern.endsWith('*')) {
      return eventType.startsWith(pattern.slice(0, -1));
    }
    return pattern === eventType;
  });
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

function normalizeDispatchMode(value: unknown): 'direct' | 'self-assembly' | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'direct' || normalized === 'self-assembly') {
    return normalized;
  }
  return undefined;
}

function normalizeSource(value: unknown): CursorBridgeEventSource | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'webhook' || normalized === 'cli-dispatch') {
    return normalized;
  }
  return undefined;
}

function normalizePositiveInt(value: unknown): number | undefined {
  const parsed = normalizeNumber(value);
  if (typeof parsed !== 'number' || parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

function normalizeNonNegativeInt(value: unknown): number | undefined {
  const parsed = normalizeNumber(value);
  if (typeof parsed !== 'number' || parsed < 0) return undefined;
  return Math.trunc(parsed);
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  const normalized = typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : fallback;
  return normalized;
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  const parsed = normalizeOptionalBoolean(value);
  if (typeof parsed === 'boolean') return parsed;
  return fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? ''));
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
