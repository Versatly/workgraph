import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ledger as ledgerModule,
  store as storeModule,
  type LedgerEntry,
} from '@versatly/workgraph-kernel';

const ledger = ledgerModule;
const store = storeModule;

const WEBHOOK_GATEWAY_PATH = '.workgraph/webhook-gateway.json';
const WEBHOOK_GATEWAY_VERSION = 1;
const WEBHOOK_LEDGER_TARGET_PREFIX = '.workgraph/webhooks/inbound';
const WEBHOOK_LEDGER_TYPE = 'webhook-event';
const SOURCE_WILDCARD = '*';

interface WebhookGatewayStoreFile {
  version: number;
  routes: StoredWebhookRoute[];
  sources: Record<string, StoredWebhookSourceAuth>;
}

interface StoredWebhookRoute {
  id: string;
  source: string;
  event: string;
  triggerPath: string;
  createdAt: string;
}

interface StoredWebhookSourceAuth {
  signingSecret?: string;
  apiKey?: string;
}

export interface WebhookSourceAuth {
  signingSecret?: string;
  apiKey?: string;
}

export interface RegisterWebhookRouteInput {
  source: string;
  event: string;
  trigger: string;
  signingSecret?: string;
  apiKey?: string;
}

export interface RegisterWebhookRouteResult {
  route: WebhookRouteView;
  created: boolean;
}

export interface WebhookRouteView {
  id: string;
  source: string;
  event: string;
  triggerPath: string;
  createdAt: string;
  hasSigningSecret: boolean;
  hasApiKey: boolean;
}

export interface ListWebhookRoutesInput {
  source?: string;
}

export interface ListWebhookLogsInput {
  source?: string;
  since?: string;
  limit?: number;
}

export interface WebhookLogView {
  ts: string;
  source: string;
  endpointId: string;
  eventType: string;
  deliveryId: string;
  accepted: boolean;
  matchedRoutes: number;
  triggeredRoutes: number;
  statusCode: number;
  errors: string[];
}

export interface AppendWebhookLedgerLogInput {
  source: string;
  endpointId: string;
  actor: string;
  accepted: boolean;
  statusCode: number;
  eventType: string;
  deliveryId: string;
  matchedRoutes: number;
  triggeredRoutes: number;
  errors?: string[];
}

export function registerWebhookRoute(
  workspacePath: string,
  input: RegisterWebhookRouteInput,
): RegisterWebhookRouteResult {
  const source = normalizeSource(input.source);
  const event = normalizeEventType(input.event);
  const triggerPath = resolveTriggerPath(workspacePath, input.trigger);
  const signingSecret = readOptionalString(input.signingSecret);
  const apiKey = readOptionalString(input.apiKey);

  const storeFile = readWebhookGatewayStore(workspacePath);
  const existing = storeFile.routes.find((route) =>
    route.source === source
    && route.event === event
    && route.triggerPath === triggerPath
  );

  if (signingSecret || apiKey) {
    const auth = storeFile.sources[source] ?? {};
    storeFile.sources[source] = {
      ...auth,
      ...(signingSecret ? { signingSecret } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
  }

  if (existing) {
    writeWebhookGatewayStore(workspacePath, storeFile);
    return {
      route: toWebhookRouteView(workspacePath, existing),
      created: false,
    };
  }

  const route: StoredWebhookRoute = {
    id: randomUUID(),
    source,
    event,
    triggerPath,
    createdAt: new Date().toISOString(),
  };
  storeFile.routes.push(route);
  writeWebhookGatewayStore(workspacePath, storeFile);
  return {
    route: toWebhookRouteView(workspacePath, route),
    created: true,
  };
}

export function listWebhookRoutes(
  workspacePath: string,
  input: ListWebhookRoutesInput = {},
): WebhookRouteView[] {
  const sourceFilter = input.source ? normalizeSource(input.source) : undefined;
  return readWebhookGatewayStore(workspacePath).routes
    .filter((route) => {
      if (!sourceFilter) return true;
      return route.source === sourceFilter;
    })
    .map((route) => toWebhookRouteView(workspacePath, route))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function deleteWebhookRoute(workspacePath: string, routeId: string): WebhookRouteView | null {
  const normalizedRouteId = readOptionalString(routeId);
  if (!normalizedRouteId) return null;

  const storeFile = readWebhookGatewayStore(workspacePath);
  const index = storeFile.routes.findIndex((route) => route.id === normalizedRouteId);
  if (index < 0) return null;
  const deleted = storeFile.routes[index]!;
  storeFile.routes.splice(index, 1);
  writeWebhookGatewayStore(workspacePath, storeFile);
  return toWebhookRouteView(workspacePath, deleted);
}

export function listWebhookLogs(workspacePath: string, input: ListWebhookLogsInput = {}): WebhookLogView[] {
  const sourceFilter = input.source ? normalizeSource(input.source) : undefined;
  const since = readOptionalString(input.since);
  const limit = normalizeLimit(input.limit);
  const entries = ledger.readAll(workspacePath);

  const filtered = entries
    .filter((entry) => isWebhookLedgerEntry(entry))
    .filter((entry) => !since || entry.ts >= since)
    .filter((entry) => {
      if (!sourceFilter) return true;
      return entry.target.startsWith(`${WEBHOOK_LEDGER_TARGET_PREFIX}/${sourceFilter}/`);
    })
    .map(toWebhookLogView);

  const bounded = filtered.slice(-limit);
  return bounded.reverse();
}

export function resolveWebhookRoutesForEvent(
  workspacePath: string,
  source: string,
  eventType: string,
): WebhookRouteView[] {
  const normalizedSource = normalizeSource(source);
  const normalizedEventType = normalizeEventType(eventType);
  return readWebhookGatewayStore(workspacePath).routes
    .filter((route) =>
      route.source === normalizedSource
      && (route.event === normalizedEventType || route.event === SOURCE_WILDCARD)
    )
    .map((route) => toWebhookRouteView(workspacePath, route));
}

export function resolveWebhookSourceAuth(workspacePath: string, source: string): WebhookSourceAuth {
  const normalizedSource = normalizeSource(source);
  const fromStore = readWebhookGatewayStore(workspacePath).sources[normalizedSource] ?? {};
  const fromEnv = readWebhookSourceAuthFromEnv(normalizedSource);
  return {
    ...(fromStore.signingSecret ? { signingSecret: fromStore.signingSecret } : {}),
    ...(fromStore.apiKey ? { apiKey: fromStore.apiKey } : {}),
    ...(fromEnv.signingSecret ? { signingSecret: fromEnv.signingSecret } : {}),
    ...(fromEnv.apiKey ? { apiKey: fromEnv.apiKey } : {}),
  };
}

export function appendWebhookLedgerLog(
  workspacePath: string,
  input: AppendWebhookLedgerLogInput,
): void {
  const source = normalizeSource(input.source);
  const endpointId = normalizePathSegment(input.endpointId, 'endpoint id');
  const eventType = normalizeEventType(input.eventType);
  const deliveryId = normalizePathSegment(input.deliveryId, 'delivery id');
  const actor = readOptionalString(input.actor) ?? `webhook:${source}`;
  const target = `${WEBHOOK_LEDGER_TARGET_PREFIX}/${source}/${endpointId}`;
  const errors = Array.isArray(input.errors) ? input.errors.map((item) => String(item)) : [];

  ledger.append(workspacePath, actor, 'update', target, WEBHOOK_LEDGER_TYPE, {
    gateway: 'webhook',
    source,
    endpoint_id: endpointId,
    event_type: eventType,
    delivery_id: deliveryId,
    accepted: input.accepted,
    status_code: input.statusCode,
    matched_routes: Math.max(0, Math.trunc(input.matchedRoutes)),
    triggered_routes: Math.max(0, Math.trunc(input.triggeredRoutes)),
    errors,
  });
}

export function resolveTriggerPath(workspacePath: string, triggerRef: string): string {
  const normalizedRef = normalizePathSegment(triggerRef, 'trigger');
  const candidates = triggerPathCandidates(normalizedRef);
  for (const candidate of candidates) {
    const instance = store.read(workspacePath, candidate);
    if (instance && instance.type === 'trigger') {
      return instance.path;
    }
  }

  const byName = store.list(workspacePath, 'trigger')
    .filter((instance) => slugFromPath(instance.path) === slugFromPath(normalizedRef));
  if (byName.length === 1) {
    return byName[0]!.path;
  }
  if (byName.length > 1) {
    throw new Error(`Trigger reference "${triggerRef}" is ambiguous. Use full trigger path.`);
  }
  throw new Error(`Trigger not found: ${triggerRef}`);
}

function readWebhookGatewayStore(workspacePath: string): WebhookGatewayStoreFile {
  const filePath = webhookGatewayStorePath(workspacePath);
  if (!fs.existsSync(filePath)) {
    return {
      version: WEBHOOK_GATEWAY_VERSION,
      routes: [],
      sources: {},
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<WebhookGatewayStoreFile>;
    const routes = Array.isArray(parsed.routes) ? parsed.routes.map(sanitizeRoute).filter(Boolean) as StoredWebhookRoute[] : [];
    const sources = sanitizeSources(parsed.sources);
    return {
      version: WEBHOOK_GATEWAY_VERSION,
      routes,
      sources,
    };
  } catch {
    return {
      version: WEBHOOK_GATEWAY_VERSION,
      routes: [],
      sources: {},
    };
  }
}

function writeWebhookGatewayStore(workspacePath: string, file: WebhookGatewayStoreFile): void {
  const filePath = webhookGatewayStorePath(workspacePath);
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const serialized: WebhookGatewayStoreFile = {
    version: WEBHOOK_GATEWAY_VERSION,
    routes: file.routes
      .map(sanitizeRoute)
      .filter((route): route is StoredWebhookRoute => route !== null),
    sources: sanitizeSources(file.sources),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(serialized, null, 2)}\n`, 'utf-8');
}

function webhookGatewayStorePath(workspacePath: string): string {
  return path.join(workspacePath, WEBHOOK_GATEWAY_PATH);
}

function sanitizeRoute(value: unknown): StoredWebhookRoute | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<StoredWebhookRoute>;
  const id = readOptionalString(candidate.id);
  const source = readOptionalString(candidate.source);
  const event = readOptionalString(candidate.event);
  const triggerPath = readOptionalString(candidate.triggerPath);
  const createdAt = readOptionalString(candidate.createdAt) ?? new Date(0).toISOString();
  if (!id || !source || !event || !triggerPath) return null;
  return {
    id,
    source: normalizeSource(source),
    event: normalizeEventType(event),
    triggerPath,
    createdAt,
  };
}

function sanitizeSources(value: unknown): Record<string, StoredWebhookSourceAuth> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: Record<string, StoredWebhookSourceAuth> = {};
  for (const [rawSource, rawAuth] of Object.entries(value as Record<string, unknown>)) {
    if (!rawAuth || typeof rawAuth !== 'object' || Array.isArray(rawAuth)) continue;
    const authRecord = rawAuth as Record<string, unknown>;
    const signingSecret = readOptionalString(authRecord.signingSecret);
    const apiKey = readOptionalString(authRecord.apiKey);
    if (!signingSecret && !apiKey) continue;
    output[normalizeSource(rawSource)] = {
      ...(signingSecret ? { signingSecret } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
  }
  return output;
}

function toWebhookRouteView(workspacePath: string, route: StoredWebhookRoute): WebhookRouteView {
  const auth = resolveWebhookSourceAuth(workspacePath, route.source);
  return {
    id: route.id,
    source: route.source,
    event: route.event,
    triggerPath: route.triggerPath,
    createdAt: route.createdAt,
    hasSigningSecret: Boolean(auth.signingSecret),
    hasApiKey: Boolean(auth.apiKey),
  };
}

function isWebhookLedgerEntry(entry: LedgerEntry): boolean {
  return entry.type === WEBHOOK_LEDGER_TYPE
    && entry.target.startsWith(`${WEBHOOK_LEDGER_TARGET_PREFIX}/`);
}

function toWebhookLogView(entry: LedgerEntry): WebhookLogView {
  const data = entry.data ?? {};
  return {
    ts: entry.ts,
    source: readOptionalString(data.source) ?? 'unknown',
    endpointId: readOptionalString(data.endpoint_id) ?? 'unknown',
    eventType: readOptionalString(data.event_type) ?? 'unknown',
    deliveryId: readOptionalString(data.delivery_id) ?? '',
    accepted: data.accepted === true,
    matchedRoutes: readSafeNumber(data.matched_routes),
    triggeredRoutes: readSafeNumber(data.triggered_routes),
    statusCode: readSafeNumber(data.status_code),
    errors: Array.isArray(data.errors) ? data.errors.map((item) => String(item)) : [],
  };
}

function readWebhookSourceAuthFromEnv(source: string): WebhookSourceAuth {
  const normalizedSource = normalizeSource(source).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const signingSecret = readEnvValue([
    `WORKGRAPH_WEBHOOK_${normalizedSource}_SIGNING_SECRET`,
    `WORKGRAPH_WEBHOOK_${normalizedSource}_SECRET`,
  ]);
  const apiKey = readEnvValue([
    `WORKGRAPH_WEBHOOK_${normalizedSource}_API_KEY`,
    ...(source === 'generic' ? ['WORKGRAPH_WEBHOOK_API_KEY'] : []),
  ]);
  return {
    ...(signingSecret ? { signingSecret } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

function readEnvValue(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readOptionalString(process.env[key]);
    if (value) return value;
  }
  return undefined;
}

function triggerPathCandidates(rawRef: string): string[] {
  const normalized = rawRef.replace(/\\/g, '/').replace(/^\.\//, '');
  const withExtension = normalized.endsWith('.md') ? normalized : `${normalized}.md`;
  const candidates = new Set<string>([withExtension]);
  if (!withExtension.startsWith('triggers/')) {
    candidates.add(`triggers/${withExtension}`);
  }
  return [...candidates];
}

function slugFromPath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const fileName = normalized.split('/').pop() ?? normalized;
  return fileName.replace(/\.md$/i, '').toLowerCase();
}

function normalizeSource(value: string): string {
  const normalized = normalizePathSegment(value, 'source').toLowerCase();
  return normalized;
}

function normalizeEventType(value: string): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) {
    throw new Error('Webhook event is required.');
  }
  return normalized;
}

function normalizePathSegment(value: string, label: string): string {
  const normalized = String(value ?? '').trim().replace(/\\/g, '/').replace(/\s+/g, '-');
  if (!normalized) {
    throw new Error(`Webhook ${label} is required.`);
  }
  return normalized;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeLimit(value: unknown): number {
  if (value === undefined || value === null) return 100;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.min(parsed, 1_000);
}

function readSafeNumber(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.trunc(parsed);
}
