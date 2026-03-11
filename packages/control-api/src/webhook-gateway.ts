import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ledger as ledgerModule } from '@versatly/workgraph-kernel';

const ledger = ledgerModule;

const WEBHOOK_GATEWAY_STORE_PATH = '.workgraph/webhook-gateway-sources.json';
const WEBHOOK_GATEWAY_LOG_PATH = '.workgraph/webhook-gateway.log.jsonl';
const WEBHOOK_GATEWAY_STORE_VERSION = 1;
const DEFAULT_LOG_LIMIT = 50;
const MAX_LOG_LIMIT = 1_000;
const MAX_WEBHOOK_BODY_BYTES = 2 * 1024 * 1024;
const SLACK_SIGNATURE_MAX_AGE_SECONDS = 60 * 5;
const WEBHOOK_DEDUP_TTL_MS = 5 * 60_000;
const WEBHOOK_DEDUP_MAX_ENTRIES = 1_000;

const recentWebhookDedup = new Map<string, number>();

export type WebhookGatewayProvider = 'github' | 'linear' | 'slack' | 'generic';
type LogStatus = 'accepted' | 'rejected';

interface WebhookGatewayStoreFile {
  version: number;
  sources: StoredWebhookGatewaySource[];
}

interface StoredWebhookGatewaySource {
  id: string;
  key: string;
  provider: WebhookGatewayProvider;
  createdAt: string;
  enabled: boolean;
  secret?: string;
  actor?: string;
  eventPrefix?: string;
}

interface SignatureVerificationResult {
  ok: boolean;
  verified: boolean;
  message: string;
}

export interface RegisterWebhookGatewaySourceInput {
  key: string;
  provider: WebhookGatewayProvider;
  secret?: string;
  actor?: string;
  eventPrefix?: string;
  enabled?: boolean;
}

export interface WebhookGatewaySourceView {
  id: string;
  key: string;
  provider: WebhookGatewayProvider;
  createdAt: string;
  enabled: boolean;
  hasSecret: boolean;
  actor?: string;
  eventPrefix?: string;
}

export interface WebhookGatewayLogEntry {
  id: string;
  ts: string;
  sourceKey: string;
  provider: WebhookGatewayProvider;
  eventType: string;
  actor: string;
  status: LogStatus;
  statusCode: number;
  signatureVerified: boolean;
  message: string;
  deliveryId?: string;
  payloadDigest: string;
}

export interface TestWebhookGatewaySourceInput {
  sourceKey: string;
  eventType?: string;
  payload?: unknown;
  deliveryId?: string;
}

export interface TestWebhookGatewaySourceResult {
  eventType: string;
  deliveryId: string;
  source: WebhookGatewaySourceView;
  log: WebhookGatewayLogEntry;
}

interface AdaptedWebhookPayload {
  eventType: string;
  deliveryId: string;
  payload: unknown;
}

export function registerWebhookGatewaySource(
  workspacePath: string,
  input: RegisterWebhookGatewaySourceInput,
): WebhookGatewaySourceView {
  const key = normalizeSourceKey(input.key);
  const provider = normalizeProvider(input.provider);
  if (!provider) {
    throw new Error(`Invalid webhook gateway provider "${String(input.provider)}". Expected github|linear|slack|generic.`);
  }
  const secret = readOptionalString(input.secret);
  const actor = readOptionalString(input.actor);
  const eventPrefix = readOptionalString(input.eventPrefix);
  const enabled = input.enabled !== false;

  const store = readWebhookGatewayStore(workspacePath);
  const existing = store.sources.find((source) => source.key === key);
  if (existing) {
    throw new Error(`Webhook gateway source already exists: ${key}`);
  }

  const source: StoredWebhookGatewaySource = {
    id: randomUUID(),
    key,
    provider,
    createdAt: new Date().toISOString(),
    enabled,
    ...(secret ? { secret } : {}),
    ...(actor ? { actor } : {}),
    ...(eventPrefix ? { eventPrefix } : {}),
  };
  store.sources.push(source);
  writeWebhookGatewayStore(workspacePath, store);
  return toWebhookGatewaySourceView(source);
}

export function listWebhookGatewaySources(workspacePath: string): WebhookGatewaySourceView[] {
  const store = readWebhookGatewayStore(workspacePath);
  return store.sources
    .slice()
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(toWebhookGatewaySourceView);
}

export function deleteWebhookGatewaySource(workspacePath: string, keyOrId: string): boolean {
  const normalized = String(keyOrId ?? '').trim();
  if (!normalized) return false;

  const store = readWebhookGatewayStore(workspacePath);
  const before = store.sources.length;
  store.sources = store.sources.filter((source) => source.key !== normalized && source.id !== normalized);
  if (before === store.sources.length) return false;
  writeWebhookGatewayStore(workspacePath, store);
  return true;
}

export function listWebhookGatewayLogs(
  workspacePath: string,
  options: {
    limit?: number;
    sourceKey?: string;
  } = {},
): WebhookGatewayLogEntry[] {
  const filePath = webhookGatewayLogPath(workspacePath);
  if (!fs.existsSync(filePath)) return [];
  const limit = normalizeLogLimit(options.limit);
  const sourceKey = readOptionalString(options.sourceKey);

  const lines = fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed: WebhookGatewayLogEntry[] = [];
  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    const line = lines[idx];
    let candidate: unknown;
    try {
      candidate = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const log = sanitizeWebhookGatewayLogEntry(candidate);
    if (!log) continue;
    if (sourceKey && log.sourceKey !== sourceKey) continue;
    parsed.push(log);
    if (parsed.length >= limit) break;
  }
  return parsed;
}

export function testWebhookGatewaySource(
  workspacePath: string,
  input: TestWebhookGatewaySourceInput,
): TestWebhookGatewaySourceResult {
  const source = resolveSourceByKeyOrId(workspacePath, input.sourceKey);
  if (!source) {
    throw new Error(`Webhook gateway source not found: ${input.sourceKey}`);
  }
  const now = new Date().toISOString();
  const deliveryId = normalizeDeliveryId(input.deliveryId) ?? `test-${Date.now()}`;
  const eventType = normalizeEventType(
    input.eventType
      ?? `webhook.${source.eventPrefix ?? source.provider}.test`,
  );
  const payload = input.payload ?? {
    source: source.key,
    provider: source.provider,
    mode: 'test',
    ts: now,
  };
  const payloadText = stringifyPayload(payload);
  const payloadDigest = sha256Hex(payloadText);
  const actor = source.actor ?? `webhook:${source.key}`;
  appendWebhookGatewayLedgerEvent(workspacePath, source, {
    eventType,
    deliveryId,
    payload,
    payloadDigest,
    actor,
  });

  const log: WebhookGatewayLogEntry = {
    id: randomUUID(),
    ts: now,
    sourceKey: source.key,
    provider: source.provider,
    eventType,
    actor,
    status: 'accepted',
    statusCode: 202,
    signatureVerified: false,
    message: 'Synthetic webhook gateway test event accepted.',
    deliveryId,
    payloadDigest,
  };
  appendWebhookGatewayLog(workspacePath, log);
  return {
    eventType,
    deliveryId,
    source: toWebhookGatewaySourceView(source),
    log,
  };
}

export function registerWebhookGatewayEndpoint(app: any, workspacePath: string): void {
  app.post('/webhook-gateway/:sourceKey', async (req: any, res: any) => {
    const sourceKey = readOptionalString(req.params?.sourceKey);
    if (!sourceKey) {
      writeWebhookGatewayHttpResponse(res, 400, {
        ok: false,
        error: 'Webhook source key is required.',
      });
      return;
    }

    try {
      const source = resolveSourceByKeyOrId(workspacePath, sourceKey);
      if (!source) {
        const log = createRejectedGatewayLog({
          sourceKey,
          provider: 'generic',
          eventType: 'webhook.unknown',
          actor: `webhook:${sourceKey}`,
          statusCode: 404,
          signatureVerified: false,
          message: `Webhook gateway source not found: ${sourceKey}`,
          payloadDigest: sha256Hex(''),
        });
        appendWebhookGatewayLog(workspacePath, log);
        writeWebhookGatewayHttpResponse(res, 404, {
          ok: false,
          error: `Webhook gateway source not found: ${sourceKey}`,
        });
        return;
      }
      if (!source.enabled) {
        const log = createRejectedGatewayLog({
          sourceKey: source.key,
          provider: source.provider,
          eventType: `webhook.${source.eventPrefix ?? source.provider}.disabled`,
          actor: source.actor ?? `webhook:${source.key}`,
          statusCode: 403,
          signatureVerified: false,
          message: `Webhook gateway source is disabled: ${source.key}`,
          payloadDigest: sha256Hex(''),
        });
        appendWebhookGatewayLog(workspacePath, log);
        writeWebhookGatewayHttpResponse(res, 403, {
          ok: false,
          error: `Webhook gateway source is disabled: ${source.key}`,
        });
        return;
      }

      const body = await resolveWebhookBody(req);
      const verification = verifyWebhookSignature(source, req.headers, body.rawBody);
      if (!verification.ok) {
        const adaptedForReject = adaptWebhookPayload(source, req.headers, body.jsonBody, body.rawBody);
        const log = createRejectedGatewayLog({
          sourceKey: source.key,
          provider: source.provider,
          eventType: adaptedForReject.eventType,
          actor: source.actor ?? `webhook:${source.key}`,
          statusCode: 401,
          signatureVerified: verification.verified,
          message: verification.message,
          deliveryId: adaptedForReject.deliveryId,
          payloadDigest: sha256Hex(body.rawBody),
        });
        appendWebhookGatewayLog(workspacePath, log);
        writeWebhookGatewayHttpResponse(res, 401, {
          ok: false,
          error: verification.message,
        });
        return;
      }

      const adapted = adaptWebhookPayload(source, req.headers, body.jsonBody, body.rawBody);
      const payloadDigest = sha256Hex(body.rawBody);
      const actor = source.actor ?? `webhook:${source.key}`;

      if (source.provider === 'slack' && isSlackChallengePayload(body.jsonBody)) {
        const challenge = String((body.jsonBody as Record<string, unknown>).challenge ?? '');
        const acceptedLog: WebhookGatewayLogEntry = {
          id: randomUUID(),
          ts: new Date().toISOString(),
          sourceKey: source.key,
          provider: source.provider,
          eventType: adapted.eventType,
          actor,
          status: 'accepted',
          statusCode: 200,
          signatureVerified: verification.verified,
          message: 'Slack URL verification challenge accepted.',
          deliveryId: adapted.deliveryId,
          payloadDigest,
        };
        appendWebhookGatewayLog(workspacePath, acceptedLog);
        writeWebhookGatewayHttpResponse(res, 200, {
          ok: true,
          challenge,
          source: source.key,
          eventType: adapted.eventType,
        });
        return;
      }

      const duplicateBy = detectRecentWebhookDuplicate(
        workspacePath,
        source.key,
        adapted.deliveryId,
        payloadDigest,
      );
      if (duplicateBy) {
        const duplicateLog: WebhookGatewayLogEntry = {
          id: randomUUID(),
          ts: new Date().toISOString(),
          sourceKey: source.key,
          provider: source.provider,
          eventType: adapted.eventType,
          actor,
          status: 'accepted',
          statusCode: 200,
          signatureVerified: verification.verified,
          message: `Duplicate webhook ignored (${duplicateBy}).`,
          deliveryId: adapted.deliveryId,
          payloadDigest,
        };
        appendWebhookGatewayLog(workspacePath, duplicateLog);
        writeWebhookGatewayHttpResponse(res, 200, {
          ok: true,
          accepted: false,
          reason: 'duplicate',
          duplicateBy,
          source: source.key,
          provider: source.provider,
          eventType: adapted.eventType,
          deliveryId: adapted.deliveryId,
        });
        return;
      }

      appendWebhookGatewayLedgerEvent(workspacePath, source, {
        eventType: adapted.eventType,
        deliveryId: adapted.deliveryId,
        payload: adapted.payload,
        payloadDigest,
        actor,
      });
      const acceptedLog: WebhookGatewayLogEntry = {
        id: randomUUID(),
        ts: new Date().toISOString(),
        sourceKey: source.key,
        provider: source.provider,
        eventType: adapted.eventType,
        actor,
        status: 'accepted',
        statusCode: 202,
        signatureVerified: verification.verified,
        message: verification.message,
        deliveryId: adapted.deliveryId,
        payloadDigest,
      };
      appendWebhookGatewayLog(workspacePath, acceptedLog);
      writeWebhookGatewayHttpResponse(res, 202, {
        ok: true,
        accepted: true,
        source: source.key,
        provider: source.provider,
        eventType: adapted.eventType,
        deliveryId: adapted.deliveryId,
      });
    } catch (error) {
      writeWebhookGatewayHttpResponse(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function detectRecentWebhookDuplicate(
  workspacePath: string,
  sourceKey: string,
  deliveryId: string,
  payloadDigest: string,
): 'deliveryId' | 'payloadDigest' | null {
  const nowMs = Date.now();
  evictExpiredWebhookDedupEntries(nowMs);
  const deliveryKey = `${workspacePath}|${sourceKey}|delivery|${deliveryId}`;
  if (isWebhookDedupHit(deliveryKey, nowMs)) {
    return 'deliveryId';
  }
  const payloadKey = `${workspacePath}|${sourceKey}|digest|${payloadDigest}`;
  if (isWebhookDedupHit(payloadKey, nowMs)) {
    return 'payloadDigest';
  }
  rememberWebhookDedupKey(deliveryKey, nowMs);
  rememberWebhookDedupKey(payloadKey, nowMs);
  return null;
}

function isWebhookDedupHit(key: string, nowMs: number): boolean {
  const expiresAt = recentWebhookDedup.get(key);
  if (!expiresAt) return false;
  if (expiresAt <= nowMs) {
    recentWebhookDedup.delete(key);
    return false;
  }
  // Re-insert to refresh LRU order while keeping original expiration.
  recentWebhookDedup.delete(key);
  recentWebhookDedup.set(key, expiresAt);
  return true;
}

function rememberWebhookDedupKey(key: string, nowMs: number): void {
  recentWebhookDedup.set(key, nowMs + WEBHOOK_DEDUP_TTL_MS);
  while (recentWebhookDedup.size > WEBHOOK_DEDUP_MAX_ENTRIES) {
    const oldest = recentWebhookDedup.keys().next().value as string | undefined;
    if (!oldest) break;
    recentWebhookDedup.delete(oldest);
  }
}

function evictExpiredWebhookDedupEntries(nowMs: number): void {
  for (const [key, expiresAt] of recentWebhookDedup.entries()) {
    if (expiresAt <= nowMs) {
      recentWebhookDedup.delete(key);
    }
  }
}

function readWebhookGatewayStore(workspacePath: string): WebhookGatewayStoreFile {
  const filePath = webhookGatewayStorePath(workspacePath);
  if (!fs.existsSync(filePath)) {
    return {
      version: WEBHOOK_GATEWAY_STORE_VERSION,
      sources: [],
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<WebhookGatewayStoreFile>;
    const sources = Array.isArray(parsed.sources)
      ? parsed.sources
        .map((entry) => sanitizeStoredSource(entry))
        .filter((entry): entry is StoredWebhookGatewaySource => entry !== null)
      : [];
    return {
      version: WEBHOOK_GATEWAY_STORE_VERSION,
      sources,
    };
  } catch {
    return {
      version: WEBHOOK_GATEWAY_STORE_VERSION,
      sources: [],
    };
  }
}

function writeWebhookGatewayStore(workspacePath: string, store: WebhookGatewayStoreFile): void {
  const filePath = webhookGatewayStorePath(workspacePath);
  ensureParentDirectory(filePath);
  const serialized: WebhookGatewayStoreFile = {
    version: WEBHOOK_GATEWAY_STORE_VERSION,
    sources: store.sources.map((source) => ({
      id: source.id,
      key: source.key,
      provider: source.provider,
      createdAt: source.createdAt,
      enabled: source.enabled,
      ...(source.secret ? { secret: source.secret } : {}),
      ...(source.actor ? { actor: source.actor } : {}),
      ...(source.eventPrefix ? { eventPrefix: source.eventPrefix } : {}),
    })),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(serialized, null, 2)}\n`, 'utf-8');
}

function resolveSourceByKeyOrId(workspacePath: string, keyOrId: string): StoredWebhookGatewaySource | null {
  const normalized = String(keyOrId ?? '').trim();
  if (!normalized) return null;
  const store = readWebhookGatewayStore(workspacePath);
  return store.sources.find((source) => source.key === normalized || source.id === normalized) ?? null;
}

function verifyWebhookSignature(
  source: StoredWebhookGatewaySource,
  headers: Record<string, unknown>,
  rawBody: string,
): SignatureVerificationResult {
  const secret = readOptionalString(source.secret);
  if (!secret) {
    return {
      ok: true,
      verified: false,
      message: 'Accepted unsigned webhook (source has no secret configured).',
    };
  }

  switch (source.provider) {
    case 'github':
      return verifyGithubSignature(headers, rawBody, secret);
    case 'slack':
      return verifySlackSignature(headers, rawBody, secret);
    case 'linear':
      return verifyLinearSignature(headers, rawBody, secret);
    case 'generic':
      return verifyGenericSignature(headers, rawBody, secret);
    default:
      return {
        ok: false,
        verified: false,
        message: `Unsupported webhook gateway provider: ${source.provider}`,
      };
  }
}

function verifyGithubSignature(
  headers: Record<string, unknown>,
  rawBody: string,
  secret: string,
): SignatureVerificationResult {
  const signature = readHeader(headers, 'x-hub-signature-256');
  if (!signature) {
    return {
      ok: false,
      verified: false,
      message: 'Missing GitHub signature header: x-hub-signature-256.',
    };
  }
  const expected = `sha256=${hmacSha256Hex(secret, rawBody)}`;
  if (!safeSignaturesMatch(signature, [expected])) {
    return {
      ok: false,
      verified: false,
      message: 'GitHub signature verification failed.',
    };
  }
  return {
    ok: true,
    verified: true,
    message: 'GitHub signature verified.',
  };
}

function verifySlackSignature(
  headers: Record<string, unknown>,
  rawBody: string,
  secret: string,
): SignatureVerificationResult {
  const signature = readHeader(headers, 'x-slack-signature');
  const timestampRaw = readHeader(headers, 'x-slack-request-timestamp');
  if (!signature || !timestampRaw) {
    return {
      ok: false,
      verified: false,
      message: 'Missing Slack signature headers.',
    };
  }
  const timestampSeconds = Number.parseInt(timestampRaw, 10);
  if (!Number.isFinite(timestampSeconds)) {
    return {
      ok: false,
      verified: false,
      message: 'Invalid Slack signature timestamp.',
    };
  }
  const nowSeconds = Math.floor(Date.now() / 1_000);
  if (Math.abs(nowSeconds - timestampSeconds) > SLACK_SIGNATURE_MAX_AGE_SECONDS) {
    return {
      ok: false,
      verified: false,
      message: 'Slack signature timestamp is outside the accepted time window.',
    };
  }
  const base = `v0:${timestampRaw}:${rawBody}`;
  const expected = `v0=${hmacSha256Hex(secret, base)}`;
  if (!safeSignaturesMatch(signature, [expected])) {
    return {
      ok: false,
      verified: false,
      message: 'Slack signature verification failed.',
    };
  }
  return {
    ok: true,
    verified: true,
    message: 'Slack signature verified.',
  };
}

function verifyLinearSignature(
  headers: Record<string, unknown>,
  rawBody: string,
  secret: string,
): SignatureVerificationResult {
  const signature = readHeader(headers, 'linear-signature') ?? readHeader(headers, 'x-linear-signature');
  if (!signature) {
    return {
      ok: false,
      verified: false,
      message: 'Missing Linear signature header.',
    };
  }
  const expectedHex = hmacSha256Hex(secret, rawBody);
  const expectedBase64 = hmacSha256Base64(secret, rawBody);
  if (!safeSignaturesMatch(signature, [expectedHex, `sha256=${expectedHex}`, expectedBase64])) {
    return {
      ok: false,
      verified: false,
      message: 'Linear signature verification failed.',
    };
  }
  return {
    ok: true,
    verified: true,
    message: 'Linear signature verified.',
  };
}

function verifyGenericSignature(
  headers: Record<string, unknown>,
  rawBody: string,
  secret: string,
): SignatureVerificationResult {
  const signature = readHeader(headers, 'x-workgraph-signature')
    ?? readHeader(headers, 'x-webhook-signature')
    ?? readHeader(headers, 'x-signature');
  if (!signature) {
    return {
      ok: false,
      verified: false,
      message: 'Missing generic webhook signature header.',
    };
  }
  const expectedHex = hmacSha256Hex(secret, rawBody);
  if (!safeSignaturesMatch(signature, [expectedHex, `sha256=${expectedHex}`])) {
    return {
      ok: false,
      verified: false,
      message: 'Generic signature verification failed.',
    };
  }
  return {
    ok: true,
    verified: true,
    message: 'Generic signature verified.',
  };
}

function adaptWebhookPayload(
  source: StoredWebhookGatewaySource,
  headers: Record<string, unknown>,
  jsonBody: unknown,
  rawBody: string,
): AdaptedWebhookPayload {
  const fallbackDeliveryId = deriveFallbackDeliveryId(rawBody);
  const prefix = normalizeEventPrefix(source.eventPrefix ?? source.provider);

  if (source.provider === 'github') {
    const githubEvent = readHeader(headers, 'x-github-event')
      ?? readRecordString(jsonBody, 'action')
      ?? 'unknown';
    const deliveryId = readHeader(headers, 'x-github-delivery') ?? fallbackDeliveryId;
    return {
      eventType: normalizeEventType(`webhook.${prefix}.${normalizeEventToken(githubEvent)}`),
      deliveryId,
      payload: jsonBody,
    };
  }

  if (source.provider === 'linear') {
    const action = readRecordString(jsonBody, 'action') ?? 'unknown';
    const entityType = readRecordString(jsonBody, 'type')
      ?? readRecordString(jsonBody, 'entity')
      ?? 'event';
    const deliveryId = readHeader(headers, 'linear-delivery')
      ?? readHeader(headers, 'x-linear-delivery')
      ?? fallbackDeliveryId;
    return {
      eventType: normalizeEventType(
        `webhook.${prefix}.${normalizeEventToken(entityType)}.${normalizeEventToken(action)}`,
      ),
      deliveryId,
      payload: jsonBody,
    };
  }

  if (source.provider === 'slack') {
    const topLevelType = readRecordString(jsonBody, 'type') ?? 'unknown';
    const event = readRecordValue(jsonBody, 'event');
    const nestedEventType = readRecordString(event, 'type');
    const deliveryId = readRecordString(jsonBody, 'event_id')
      ?? readHeader(headers, 'x-slack-request-timestamp')
      ?? fallbackDeliveryId;
    const suffix = nestedEventType
      ? `${normalizeEventToken(topLevelType)}.${normalizeEventToken(nestedEventType)}`
      : normalizeEventToken(topLevelType);
    return {
      eventType: normalizeEventType(`webhook.${prefix}.${suffix}`),
      deliveryId,
      payload: jsonBody,
    };
  }

  const genericEvent = readHeader(headers, 'x-webhook-event')
    ?? readHeader(headers, 'x-event-type')
    ?? readRecordString(jsonBody, 'event')
    ?? readRecordString(jsonBody, 'type')
    ?? 'received';
  const genericDelivery = readHeader(headers, 'x-webhook-delivery')
    ?? readHeader(headers, 'x-request-id')
    ?? fallbackDeliveryId;
  return {
    eventType: normalizeEventType(`webhook.${prefix}.${normalizeEventToken(genericEvent)}`),
    deliveryId: genericDelivery,
    payload: jsonBody,
  };
}

function appendWebhookGatewayLedgerEvent(
  workspacePath: string,
  source: StoredWebhookGatewaySource,
  input: {
    eventType: string;
    deliveryId: string;
    payload: unknown;
    payloadDigest: string;
    actor: string;
  },
): void {
  const safeDeliveryId = normalizeDeliveryId(input.deliveryId) ?? deriveFallbackDeliveryId(input.payloadDigest);
  const target = `.workgraph/webhook-gateway/${source.key}/${safeDeliveryId}`;
  ledger.append(workspacePath, input.actor, 'update', target, 'event', {
    event_type: input.eventType,
    provider: source.provider,
    source_key: source.key,
    delivery_id: safeDeliveryId,
    payload_digest: input.payloadDigest,
    payload: input.payload,
  });
}

function appendWebhookGatewayLog(workspacePath: string, entry: WebhookGatewayLogEntry): void {
  const filePath = webhookGatewayLogPath(workspacePath);
  ensureParentDirectory(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
}

function createRejectedGatewayLog(input: {
  sourceKey: string;
  provider: WebhookGatewayProvider;
  eventType: string;
  actor: string;
  statusCode: number;
  signatureVerified: boolean;
  message: string;
  payloadDigest: string;
  deliveryId?: string;
}): WebhookGatewayLogEntry {
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    sourceKey: input.sourceKey,
    provider: input.provider,
    eventType: normalizeEventType(input.eventType),
    actor: input.actor,
    status: 'rejected',
    statusCode: input.statusCode,
    signatureVerified: input.signatureVerified,
    message: input.message,
    ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
    payloadDigest: input.payloadDigest,
  };
}

async function resolveWebhookBody(req: any): Promise<{ rawBody: string; jsonBody: unknown }> {
  if (Buffer.isBuffer(req.body)) {
    const rawBody = req.body.toString('utf-8');
    return {
      rawBody,
      jsonBody: safeParseJson(rawBody),
    };
  }
  if (typeof req.body === 'string') {
    return {
      rawBody: req.body,
      jsonBody: safeParseJson(req.body),
    };
  }
  if (req.body && typeof req.body === 'object') {
    return {
      rawBody: stringifyPayload(req.body),
      jsonBody: req.body,
    };
  }
  if (Buffer.isBuffer(req.rawBody)) {
    const rawBody = req.rawBody.toString('utf-8');
    return {
      rawBody,
      jsonBody: safeParseJson(rawBody),
    };
  }
  if (typeof req.rawBody === 'string') {
    return {
      rawBody: req.rawBody,
      jsonBody: safeParseJson(req.rawBody),
    };
  }

  const streamBody = await readRequestBody(req);
  return {
    rawBody: streamBody,
    jsonBody: safeParseJson(streamBody),
  };
}

async function readRequestBody(req: any): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Buffer | string) => {
      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      totalBytes += bufferChunk.byteLength;
      if (totalBytes > MAX_WEBHOOK_BODY_BYTES) {
        reject(new Error(`Webhook payload exceeds ${MAX_WEBHOOK_BODY_BYTES} bytes.`));
        return;
      }
      chunks.push(bufferChunk);
    });
    req.on('end', () => resolve());
    req.on('error', (error: unknown) => reject(error));
  });
  return Buffer.concat(chunks).toString('utf-8');
}

function sanitizeStoredSource(raw: unknown): StoredWebhookGatewaySource | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<StoredWebhookGatewaySource>;
  const id = readOptionalString(candidate.id);
  const key = readOptionalString(candidate.key);
  const provider = normalizeProvider(candidate.provider);
  const createdAt = readOptionalString(candidate.createdAt) ?? new Date(0).toISOString();
  if (!id || !key || !provider) return null;
  return {
    id,
    key,
    provider,
    createdAt,
    enabled: candidate.enabled !== false,
    ...(readOptionalString(candidate.secret) ? { secret: readOptionalString(candidate.secret)! } : {}),
    ...(readOptionalString(candidate.actor) ? { actor: readOptionalString(candidate.actor)! } : {}),
    ...(readOptionalString(candidate.eventPrefix) ? { eventPrefix: readOptionalString(candidate.eventPrefix)! } : {}),
  };
}

function sanitizeWebhookGatewayLogEntry(raw: unknown): WebhookGatewayLogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<WebhookGatewayLogEntry>;
  const id = readOptionalString(candidate.id);
  const ts = readOptionalString(candidate.ts);
  const sourceKey = readOptionalString(candidate.sourceKey);
  const provider = normalizeProvider(candidate.provider);
  const eventType = readOptionalString(candidate.eventType);
  const actor = readOptionalString(candidate.actor);
  const status = candidate.status === 'accepted' || candidate.status === 'rejected'
    ? candidate.status
    : undefined;
  const statusCode = Number.isFinite(Number(candidate.statusCode))
    ? Number(candidate.statusCode)
    : undefined;
  const signatureVerified = Boolean(candidate.signatureVerified);
  const message = readOptionalString(candidate.message);
  const payloadDigest = readOptionalString(candidate.payloadDigest);
  if (!id || !ts || !sourceKey || !provider || !eventType || !actor || !status || statusCode === undefined || !message || !payloadDigest) {
    return null;
  }
  return {
    id,
    ts,
    sourceKey,
    provider,
    eventType,
    actor,
    status,
    statusCode,
    signatureVerified,
    message,
    ...(readOptionalString(candidate.deliveryId) ? { deliveryId: readOptionalString(candidate.deliveryId)! } : {}),
    payloadDigest,
  };
}

function toWebhookGatewaySourceView(source: StoredWebhookGatewaySource): WebhookGatewaySourceView {
  return {
    id: source.id,
    key: source.key,
    provider: source.provider,
    createdAt: source.createdAt,
    enabled: source.enabled,
    hasSecret: typeof source.secret === 'string' && source.secret.length > 0,
    ...(source.actor ? { actor: source.actor } : {}),
    ...(source.eventPrefix ? { eventPrefix: source.eventPrefix } : {}),
  };
}

function safeSignaturesMatch(actual: string, candidates: string[]): boolean {
  const normalizedActual = actual.trim();
  for (const candidate of candidates) {
    const normalizedCandidate = candidate.trim();
    if (!normalizedCandidate) continue;
    if (timingSafeEquals(normalizedActual, normalizedCandidate)) return true;
  }
  return false;
}

function timingSafeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function hmacSha256Hex(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function hmacSha256Base64(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64');
}

function normalizeProvider(value: unknown): WebhookGatewayProvider | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (
    normalized === 'github'
    || normalized === 'linear'
    || normalized === 'slack'
    || normalized === 'generic'
  ) {
    return normalized;
  }
  return null;
}

function normalizeSourceKey(value: unknown): string {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) {
    throw new Error('Webhook gateway source key is required.');
  }
  return normalized;
}

function normalizeEventPrefix(value: unknown): string {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'generic';
}

function normalizeEventToken(value: unknown): string {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.+|\.+$/g, '');
  return normalized || 'unknown';
}

function normalizeEventType(value: unknown): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return 'webhook.unknown';
  return normalized;
}

function normalizeDeliveryId(value: unknown): string | undefined {
  const normalized = String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || undefined;
}

function normalizeLogLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? DEFAULT_LOG_LIMIT), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LOG_LIMIT;
  return Math.min(MAX_LOG_LIMIT, parsed);
}

function readHeader(headers: Record<string, unknown>, key: string): string | undefined {
  const lowercaseKey = key.toLowerCase();
  for (const [headerKey, headerValue] of Object.entries(headers ?? {})) {
    if (headerKey.toLowerCase() !== lowercaseKey) continue;
    if (Array.isArray(headerValue)) {
      return readOptionalString(headerValue[0]);
    }
    return readOptionalString(headerValue);
  }
  return undefined;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRecordString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return readOptionalString((value as Record<string, unknown>)[key]);
}

function readRecordValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function isSlackChallengePayload(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === 'url_verification' && typeof record.challenge === 'string';
}

function safeParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return {
      raw: text,
    };
  }
}

function stringifyPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return '{}';
  }
}

function deriveFallbackDeliveryId(seed: string): string {
  return sha256Hex(seed).slice(0, 16);
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function ensureParentDirectory(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function webhookGatewayStorePath(workspacePath: string): string {
  return path.join(workspacePath, WEBHOOK_GATEWAY_STORE_PATH);
}

function webhookGatewayLogPath(workspacePath: string): string {
  return path.join(workspacePath, WEBHOOK_GATEWAY_LOG_PATH);
}

function writeWebhookGatewayHttpResponse(
  res: any,
  status: number,
  payload: Record<string, unknown>,
): void {
  res.status(status).json(payload);
}
