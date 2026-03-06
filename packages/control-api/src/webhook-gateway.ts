import crypto from 'node:crypto';
import { trigger as triggerModule } from '@versatly/workgraph-kernel';

const trigger = triggerModule;

const WEBHOOK_SOURCE_SET = new Set(['github', 'linear', 'slack', 'generic']);
const DEFAULT_GATEWAY_ACTOR = 'webhook-gateway';
const DEFAULT_SLACK_MAX_AGE_SECONDS = 5 * 60;

export type WebhookSource = 'github' | 'linear' | 'slack' | 'generic';

export interface WebhookGatewayOptions {
  workspacePath: string;
  defaultActor?: string;
  now?: () => Date;
}

export interface WebhookGatewayRequest {
  source: string;
  id: string;
  headers: Record<string, unknown>;
  body: unknown;
  rawBody?: unknown;
}

export interface WebhookGatewayEvent {
  source: WebhookSource;
  endpointId: string;
  eventType: string;
  eventId: string;
  actor?: string;
  resource?: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export type WebhookGatewayResult =
  | {
    ok: true;
    status: number;
    source: WebhookSource;
    endpointId: string;
    triggerPath?: string;
    runId?: string;
    runStatus?: string;
    idempotencyKey?: string;
    event?: WebhookGatewayEvent;
    challenge?: string;
  }
  | {
    ok: false;
    status: number;
    error: string;
  };

interface SignatureConfig {
  source: WebhookSource;
  secret?: string;
  apiKey?: string;
  slackMaxAgeSeconds: number;
}

export function registerWebhookGatewayRoute(app: any, options: WebhookGatewayOptions): void {
  app.post('/webhooks/:source/:id', async (req: any, res: any) => {
    const result = await handleWebhookGatewayRequest(options, {
      source: String(req.params?.source ?? ''),
      id: String(req.params?.id ?? ''),
      headers: toRecord(req.headers),
      body: req.body,
      rawBody: req.rawBody,
    });
    res.status(result.status).json(result);
  });
}

export async function handleWebhookGatewayRequest(
  options: WebhookGatewayOptions,
  request: WebhookGatewayRequest,
): Promise<WebhookGatewayResult> {
  try {
    const source = normalizeSource(request.source);
    const endpointId = normalizeId(request.id);
    if (!source) {
      return {
        ok: false,
        status: 400,
        error: `Unsupported webhook source "${request.source}". Expected github|linear|slack|generic.`,
      };
    }
    if (!endpointId) {
      return {
        ok: false,
        status: 400,
        error: 'Webhook endpoint id is required.',
      };
    }

    const headers = normalizeHeaders(request.headers);
    const rawBody = readRawBody(request.rawBody, request.body);
    const payload = readJsonPayload(request.body, rawBody);
    const webhookTrigger = resolveWebhookTrigger(options.workspacePath, source, endpointId);
    if (String(webhookTrigger.fields.type ?? '').toLowerCase() !== 'webhook') {
      return {
        ok: false,
        status: 400,
        error: `Trigger is not a webhook trigger: ${webhookTrigger.path}`,
      };
    }

    const condition = toRecord(webhookTrigger.fields.condition);
    const signatureConfig = readSignatureConfig(source, condition, process.env);
    const verification = verifyWebhookSignature({
      source,
      headers,
      rawBody,
      config: signatureConfig,
      now: options.now ?? (() => new Date()),
    });
    if (!verification.ok) {
      return {
        ok: false,
        status: verification.status,
        error: verification.error,
      };
    }

    const event = adaptWebhookEvent({
      source,
      endpointId,
      headers,
      payload,
      rawBody,
      now: options.now ?? (() => new Date()),
    });

    if (
      source === 'slack'
      && payload.type === 'url_verification'
      && typeof payload.challenge === 'string'
    ) {
      return {
        ok: true,
        status: 200,
        source,
        endpointId,
        triggerPath: webhookTrigger.path,
        challenge: payload.challenge,
      };
    }

    const actor = readNonEmptyString(condition.actor)
      ?? readNonEmptyString(options.defaultActor)
      ?? DEFAULT_GATEWAY_ACTOR;
    const objective = readNonEmptyString(condition.objective);
    const fired = trigger.fireTrigger(options.workspacePath, webhookTrigger.path, {
      actor,
      eventKey: event.eventId,
      ...(objective ? { objective } : {}),
      context: {
        webhook: {
          source: event.source,
          endpoint_id: event.endpointId,
          event_type: event.eventType,
          event_id: event.eventId,
          actor: event.actor,
          resource: event.resource,
          occurred_at: event.occurredAt,
          headers: redactSensitiveHeaders(headers),
          payload: event.payload,
        },
      },
    });

    return {
      ok: true,
      status: 202,
      source,
      endpointId,
      triggerPath: fired.triggerPath,
      runId: fired.run.id,
      runStatus: fired.run.status,
      idempotencyKey: fired.idempotencyKey,
      event,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: inferGatewayStatus(message),
      error: message,
    };
  }
}

export function webhookTriggerPath(source: string, endpointId: string): string {
  const safeSource = slugify(String(source));
  const safeId = slugify(String(endpointId));
  if (!safeSource || !safeId) {
    throw new Error('Cannot derive webhook trigger path from empty source/id.');
  }
  return `triggers/webhook-${safeSource}-${safeId}.md`;
}

function resolveWebhookTrigger(workspacePath: string, source: WebhookSource, endpointId: string): any {
  const preferredRef = webhookTriggerPath(source, endpointId);
  try {
    return trigger.showTrigger(workspacePath, preferredRef);
  } catch {
    return trigger.showTrigger(workspacePath, endpointId);
  }
}

function normalizeSource(value: string): WebhookSource | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!WEBHOOK_SOURCE_SET.has(normalized)) return null;
  return normalized as WebhookSource;
}

function normalizeId(value: string): string {
  return String(value ?? '').trim();
}

function normalizeHeaders(headers: Record<string, unknown>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = String(key).trim().toLowerCase();
    if (!normalizedKey) continue;
    if (Array.isArray(value)) {
      const selected = value.map((item) => String(item)).find((item) => item.trim().length > 0);
      if (selected !== undefined) output[normalizedKey] = selected;
      continue;
    }
    if (value === undefined || value === null) continue;
    output[normalizedKey] = String(value);
  }
  return output;
}

function readRawBody(rawBody: unknown, parsedBody: unknown): string {
  if (typeof rawBody === 'string') return rawBody;
  if (rawBody instanceof Uint8Array) return Buffer.from(rawBody).toString('utf-8');
  if (Buffer.isBuffer(rawBody)) return rawBody.toString('utf-8');
  if (typeof parsedBody === 'string') return parsedBody;
  if (parsedBody === undefined || parsedBody === null) return '';
  if (typeof parsedBody === 'object') {
    return JSON.stringify(parsedBody);
  }
  return String(parsedBody);
}

function readJsonPayload(parsedBody: unknown, rawBody: string): Record<string, unknown> {
  if (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
    return parsedBody as Record<string, unknown>;
  }
  if (typeof parsedBody === 'string') {
    const fromBody = safeParseJson(parsedBody);
    if (fromBody) return fromBody;
  }
  const fromRaw = safeParseJson(rawBody);
  if (fromRaw) return fromRaw;
  return {};
}

function readSignatureConfig(
  source: WebhookSource,
  condition: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): SignatureConfig {
  const fallbackSecret = readNonEmptyString(condition.secret)
    ?? readNonEmptyString(env.WORKGRAPH_WEBHOOK_SECRET);
  if (source === 'github') {
    return {
      source,
      secret: readNonEmptyString(condition.githubSecret)
        ?? fallbackSecret
        ?? readNonEmptyString(env.WORKGRAPH_WEBHOOK_GITHUB_SECRET),
      slackMaxAgeSeconds: DEFAULT_SLACK_MAX_AGE_SECONDS,
    };
  }
  if (source === 'linear') {
    return {
      source,
      secret: readNonEmptyString(condition.linearSecret)
        ?? fallbackSecret
        ?? readNonEmptyString(env.WORKGRAPH_WEBHOOK_LINEAR_SECRET),
      slackMaxAgeSeconds: DEFAULT_SLACK_MAX_AGE_SECONDS,
    };
  }
  if (source === 'slack') {
    const maxAgeSeconds = readPositiveInt(
      condition.signatureToleranceSeconds ?? condition.maxAgeSeconds,
      DEFAULT_SLACK_MAX_AGE_SECONDS,
    );
    return {
      source,
      secret: readNonEmptyString(condition.signingSecret)
        ?? fallbackSecret
        ?? readNonEmptyString(env.WORKGRAPH_WEBHOOK_SLACK_SIGNING_SECRET),
      slackMaxAgeSeconds: maxAgeSeconds,
    };
  }
  return {
    source,
    apiKey: readNonEmptyString(condition.apiKey)
      ?? readNonEmptyString(condition.token)
      ?? readNonEmptyString(env.WORKGRAPH_WEBHOOK_GENERIC_API_KEY),
    slackMaxAgeSeconds: DEFAULT_SLACK_MAX_AGE_SECONDS,
  };
}

function verifyWebhookSignature(input: {
  source: WebhookSource;
  headers: Record<string, string>;
  rawBody: string;
  config: SignatureConfig;
  now: () => Date;
}): { ok: true } | { ok: false; status: number; error: string } {
  if (input.source === 'github') {
    if (!input.config.secret) {
      return {
        ok: false,
        status: 400,
        error: 'Missing GitHub webhook secret configuration.',
      };
    }
    const provided = readNonEmptyString(input.headers['x-hub-signature-256']);
    if (!provided) {
      return {
        ok: false,
        status: 401,
        error: 'Missing X-Hub-Signature-256 header.',
      };
    }
    const expected = `sha256=${crypto.createHmac('sha256', input.config.secret).update(input.rawBody).digest('hex')}`;
    if (!secureEquals(expected, provided)) {
      return {
        ok: false,
        status: 401,
        error: 'Invalid GitHub webhook signature.',
      };
    }
    return { ok: true };
  }

  if (input.source === 'linear') {
    if (!input.config.secret) {
      return {
        ok: false,
        status: 400,
        error: 'Missing Linear webhook secret configuration.',
      };
    }
    const provided = readNonEmptyString(input.headers['linear-signature']);
    if (!provided) {
      return {
        ok: false,
        status: 401,
        error: 'Missing Linear-Signature header.',
      };
    }
    const expectedHex = crypto.createHmac('sha256', input.config.secret).update(input.rawBody).digest('hex');
    const expected = provided.startsWith('sha256=') ? `sha256=${expectedHex}` : expectedHex;
    if (!secureEquals(expected, provided)) {
      return {
        ok: false,
        status: 401,
        error: 'Invalid Linear webhook signature.',
      };
    }
    return { ok: true };
  }

  if (input.source === 'slack') {
    if (!input.config.secret) {
      return {
        ok: false,
        status: 400,
        error: 'Missing Slack signing secret configuration.',
      };
    }
    const timestamp = readNonEmptyString(input.headers['x-slack-request-timestamp']);
    const signature = readNonEmptyString(input.headers['x-slack-signature']);
    if (!timestamp || !signature) {
      return {
        ok: false,
        status: 401,
        error: 'Missing Slack signature headers.',
      };
    }
    const timestampSeconds = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(timestampSeconds)) {
      return {
        ok: false,
        status: 401,
        error: 'Invalid Slack request timestamp.',
      };
    }
    const ageSeconds = Math.abs(Math.floor(input.now().getTime() / 1000) - timestampSeconds);
    if (ageSeconds > input.config.slackMaxAgeSeconds) {
      return {
        ok: false,
        status: 401,
        error: `Slack request timestamp is outside allowed skew (${input.config.slackMaxAgeSeconds}s).`,
      };
    }
    const base = `v0:${timestamp}:${input.rawBody}`;
    const expected = `v0=${crypto.createHmac('sha256', input.config.secret).update(base).digest('hex')}`;
    if (!secureEquals(expected, signature)) {
      return {
        ok: false,
        status: 401,
        error: 'Invalid Slack webhook signature.',
      };
    }
    return { ok: true };
  }

  if (!input.config.apiKey) {
    return {
      ok: false,
      status: 400,
      error: 'Missing generic webhook API key configuration.',
    };
  }
  const provided = readNonEmptyString(input.headers['x-api-key'])
    ?? readBearerToken(input.headers.authorization);
  if (!provided || !secureEquals(input.config.apiKey, provided)) {
    return {
      ok: false,
      status: 401,
      error: 'Invalid generic webhook API key.',
    };
  }
  return { ok: true };
}

function adaptWebhookEvent(input: {
  source: WebhookSource;
  endpointId: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
  rawBody: string;
  now: () => Date;
}): WebhookGatewayEvent {
  const nowIso = input.now().toISOString();
  if (input.source === 'github') {
    const eventName = readNonEmptyString(input.headers['x-github-event'])
      ?? readNonEmptyString(input.payload.action)
      ?? 'event';
    const eventId = readNonEmptyString(input.headers['x-github-delivery'])
      ?? buildSyntheticEventId(input.source, input.endpointId, input.rawBody);
    const actor = readNestedString(input.payload, ['sender', 'login']);
    const resource = readNestedString(input.payload, ['repository', 'full_name'])
      ?? readNestedString(input.payload, ['organization', 'login']);
    return {
      source: input.source,
      endpointId: input.endpointId,
      eventType: `webhook.github.${eventName}`,
      eventId,
      ...(actor ? { actor } : {}),
      ...(resource ? { resource } : {}),
      occurredAt: nowIso,
      payload: input.payload,
    };
  }

  if (input.source === 'linear') {
    const eventName = readNonEmptyString(input.payload.type)
      ?? readNonEmptyString(input.payload.action)
      ?? 'event';
    const eventId = readNestedString(input.payload, ['data', 'id'])
      ?? readNonEmptyString(input.payload.webhookId)
      ?? buildSyntheticEventId(input.source, input.endpointId, input.rawBody);
    const actor = readNestedString(input.payload, ['actor', 'name'])
      ?? readNestedString(input.payload, ['actor', 'id']);
    const resource = readNestedString(input.payload, ['data', 'identifier'])
      ?? readNestedString(input.payload, ['data', 'id']);
    return {
      source: input.source,
      endpointId: input.endpointId,
      eventType: `webhook.linear.${eventName}`,
      eventId,
      ...(actor ? { actor } : {}),
      ...(resource ? { resource } : {}),
      occurredAt: nowIso,
      payload: input.payload,
    };
  }

  if (input.source === 'slack') {
    const rootType = readNonEmptyString(input.payload.type) ?? 'event';
    const eventType = rootType === 'event_callback'
      ? readNestedString(input.payload, ['event', 'type']) ?? 'event'
      : rootType;
    const eventId = readNonEmptyString(input.payload.event_id)
      ?? readNonEmptyString(input.headers['x-slack-request-timestamp'])
      ?? buildSyntheticEventId(input.source, input.endpointId, input.rawBody);
    const actor = readNestedString(input.payload, ['event', 'user'])
      ?? readNonEmptyString(input.payload.user_id)
      ?? readNonEmptyString(input.payload.user);
    const resource = readNestedString(input.payload, ['event', 'channel'])
      ?? readNonEmptyString(input.payload.team_id)
      ?? readNestedString(input.payload, ['event', 'team']);
    return {
      source: input.source,
      endpointId: input.endpointId,
      eventType: `webhook.slack.${eventType}`,
      eventId,
      ...(actor ? { actor } : {}),
      ...(resource ? { resource } : {}),
      occurredAt: nowIso,
      payload: input.payload,
    };
  }

  const genericEvent = readNonEmptyString(input.headers['x-event-type'])
    ?? readNonEmptyString(input.payload.type)
    ?? 'event';
  const genericEventId = readNonEmptyString(input.headers['x-event-id'])
    ?? readNonEmptyString(input.payload.id)
    ?? buildSyntheticEventId(input.source, input.endpointId, input.rawBody);
  const genericActor = readNonEmptyString(input.payload.actor)
    ?? readNestedString(input.payload, ['actor', 'id']);
  const genericResource = readNonEmptyString(input.payload.resource)
    ?? readNestedString(input.payload, ['data', 'id']);
  return {
    source: input.source,
    endpointId: input.endpointId,
    eventType: `webhook.generic.${genericEvent}`,
    eventId: genericEventId,
    ...(genericActor ? { actor: genericActor } : {}),
    ...(genericResource ? { resource: genericResource } : {}),
    occurredAt: nowIso,
    payload: input.payload,
  };
}

function redactSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower.includes('authorization') || lower.includes('signature') || lower.includes('api-key')) {
      output[key] = '[redacted]';
      continue;
    }
    output[key] = value;
  }
  return output;
}

function buildSyntheticEventId(source: WebhookSource, endpointId: string, rawBody: string): string {
  const digest = crypto.createHash('sha256').update(rawBody).digest('hex').slice(0, 16);
  return `${source}:${endpointId}:${digest}`;
}

function readNestedString(value: Record<string, unknown>, pathParts: string[]): string | undefined {
  let current: unknown = value;
  for (const part of pathParts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return readNonEmptyString(current);
}

function readBearerToken(value: unknown): string | undefined {
  const authorization = readNonEmptyString(value);
  if (!authorization || !authorization.startsWith('Bearer ')) return undefined;
  return readNonEmptyString(authorization.slice('Bearer '.length));
}

function secureEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function safeParseJson(value: string): Record<string, unknown> | null {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function inferGatewayStatus(message: string): number {
  if (message.includes('not found')) return 404;
  if (message.includes('Unsupported webhook source')) return 400;
  if (message.includes('Missing')) return 400;
  if (message.includes('Invalid')) return 401;
  if (message.includes('blocked') || message.includes('failed')) return 403;
  return 500;
}

function slugify(value: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
