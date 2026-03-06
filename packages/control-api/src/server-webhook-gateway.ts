import crypto, { randomUUID } from 'node:crypto';
import { trigger as triggerModule } from '@versatly/workgraph-kernel';
import {
  parseWebhookEvent,
  webhookSamplePayload,
} from './server-webhook-gateway-adapters.js';
import {
  appendWebhookLedgerLog,
  deleteWebhookRoute,
  listWebhookLogs,
  listWebhookRoutes,
  registerWebhookRoute,
  resolveWebhookRoutesForEvent,
  resolveWebhookSourceAuth,
  resolveTriggerPath,
  type ListWebhookLogsInput,
  type ListWebhookRoutesInput,
  type RegisterWebhookRouteInput,
  type RegisterWebhookRouteResult,
  type WebhookLogView,
  type WebhookRouteView,
} from './server-webhook-gateway-store.js';

const trigger = triggerModule;

const SLACK_SIGNATURE_WINDOW_SECONDS = 5 * 60;

export type {
  ListWebhookLogsInput,
  ListWebhookRoutesInput,
  RegisterWebhookRouteInput,
  RegisterWebhookRouteResult,
  WebhookLogView,
  WebhookRouteView,
};

export {
  registerWebhookRoute,
  listWebhookRoutes,
  deleteWebhookRoute,
  listWebhookLogs,
  resolveTriggerPath,
};

export interface IngestWebhookRequestInput {
  source: string;
  endpointId: string;
  headers: Record<string, unknown>;
  payload: Record<string, unknown>;
  rawBody?: string;
  actor?: string;
  now?: Date;
}

export interface IngestWebhookRequestResult {
  ok: boolean;
  statusCode: number;
  source: string;
  endpointId: string;
  eventType: string;
  deliveryId: string;
  matchedRoutes: number;
  triggeredRoutes: number;
  runIds: string[];
  challenge?: string;
  errors: string[];
}

export interface CreateWebhookTestRequestInput {
  source: string;
  endpointId?: string;
  eventType?: string;
}

export interface CreateWebhookTestRequestResult {
  source: string;
  endpointId: string;
  eventType: string;
  body: Record<string, unknown>;
  rawBody: string;
  headers: Record<string, string>;
}

export function ingestWebhookRequest(
  workspacePath: string,
  input: IngestWebhookRequestInput,
): IngestWebhookRequestResult {
  const source = normalizeSource(input.source);
  const endpointId = normalizeEndpointId(input.endpointId);
  const headers = normalizeHeaders(input.headers);
  const payload = toRecord(input.payload);
  const rawBody = readRawBody(input.rawBody, payload);
  const actor = readOptionalString(input.actor) ?? 'system';
  const now = input.now ?? new Date();

  const failedSignature = verifyWebhookSignature(workspacePath, {
    source,
    headers,
    rawBody,
    now,
  });
  if (failedSignature) {
    const rejected: IngestWebhookRequestResult = {
      ok: false,
      statusCode: 401,
      source,
      endpointId,
      eventType: 'unknown',
      deliveryId: headers['x-request-id'] ?? randomUUID(),
      matchedRoutes: 0,
      triggeredRoutes: 0,
      runIds: [],
      errors: [failedSignature],
    };
    appendWebhookLedgerLog(workspacePath, {
      source,
      endpointId,
      actor,
      accepted: false,
      statusCode: rejected.statusCode,
      eventType: rejected.eventType,
      deliveryId: rejected.deliveryId,
      matchedRoutes: rejected.matchedRoutes,
      triggeredRoutes: rejected.triggeredRoutes,
      errors: rejected.errors,
    });
    return rejected;
  }

  const parsed = parseWebhookEvent(source, headers, payload);
  if (parsed.challenge) {
    const challengeResult: IngestWebhookRequestResult = {
      ok: true,
      statusCode: 200,
      source,
      endpointId,
      eventType: parsed.eventType,
      deliveryId: parsed.deliveryId,
      matchedRoutes: 0,
      triggeredRoutes: 0,
      runIds: [],
      challenge: parsed.challenge,
      errors: [],
    };
    appendWebhookLedgerLog(workspacePath, {
      source,
      endpointId,
      actor,
      accepted: true,
      statusCode: challengeResult.statusCode,
      eventType: challengeResult.eventType,
      deliveryId: challengeResult.deliveryId,
      matchedRoutes: challengeResult.matchedRoutes,
      triggeredRoutes: challengeResult.triggeredRoutes,
    });
    return challengeResult;
  }

  const routes = resolveWebhookRoutesForEvent(workspacePath, source, parsed.eventType);
  const errors: string[] = [];
  const runIds: string[] = [];

  for (const route of routes) {
    try {
      const fired = trigger.fireTrigger(workspacePath, route.triggerPath, {
        actor,
        eventKey: buildEventKey(parsed.deliveryId, parsed.eventType, route.id),
        context: {
          webhook_source: source,
          webhook_event_type: parsed.eventType,
          webhook_delivery_id: parsed.deliveryId,
          webhook_endpoint_id: endpointId,
          webhook_payload: parsed.payload,
        },
      });
      runIds.push(fired.run.id);
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }

  const result: IngestWebhookRequestResult = {
    ok: errors.length === 0,
    statusCode: errors.length === 0 ? 202 : 500,
    source,
    endpointId,
    eventType: parsed.eventType,
    deliveryId: parsed.deliveryId,
    matchedRoutes: routes.length,
    triggeredRoutes: runIds.length,
    runIds,
    errors,
  };

  appendWebhookLedgerLog(workspacePath, {
    source,
    endpointId,
    actor,
    accepted: result.ok,
    statusCode: result.statusCode,
    eventType: result.eventType,
    deliveryId: result.deliveryId,
    matchedRoutes: result.matchedRoutes,
    triggeredRoutes: result.triggeredRoutes,
    errors: result.errors,
  });

  return result;
}

export function createWebhookTestRequest(
  workspacePath: string,
  input: CreateWebhookTestRequestInput,
): CreateWebhookTestRequestResult {
  const source = normalizeSource(input.source);
  const endpointId = normalizeEndpointId(input.endpointId ?? 'test');
  const sample = webhookSamplePayload(source, input.eventType);
  const payload = sample.payload;
  const rawBody = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-request-id': randomUUID(),
  };
  const auth = resolveWebhookSourceAuth(workspacePath, source);

  if (source === 'github') {
    if (!auth.signingSecret) {
      throw new Error('GitHub webhook signing secret is required. Set via register --secret or env.');
    }
    headers['x-github-event'] = 'pull_request';
    headers['x-github-delivery'] = randomUUID();
    headers['x-hub-signature-256'] = signGitHubPayload(rawBody, auth.signingSecret);
  } else if (source === 'slack') {
    if (!auth.signingSecret) {
      throw new Error('Slack webhook signing secret is required. Set via register --secret or env.');
    }
    const timestamp = String(Math.floor(Date.now() / 1000));
    headers['x-slack-request-timestamp'] = timestamp;
    headers['x-slack-signature'] = signSlackPayload(rawBody, timestamp, auth.signingSecret);
  } else if (source === 'linear' || source === 'generic') {
    if (!auth.apiKey) {
      throw new Error(`${source} webhook API key is required. Set via register --api-key or env.`);
    }
    headers['x-api-key'] = auth.apiKey;
    if (source === 'linear') {
      headers['linear-delivery'] = randomUUID();
    }
    if (source === 'generic') {
      headers['x-webhook-event'] = sample.defaultEventType;
    }
  } else {
    if (!auth.apiKey) {
      throw new Error(`Webhook API key is required for source "${source}".`);
    }
    headers['x-api-key'] = auth.apiKey;
    headers['x-webhook-event'] = sample.defaultEventType;
  }

  return {
    source,
    endpointId,
    eventType: sample.defaultEventType,
    body: payload,
    rawBody,
    headers,
  };
}

function verifyWebhookSignature(
  workspacePath: string,
  input: {
    source: string;
    headers: Record<string, string>;
    rawBody: string;
    now: Date;
  },
): string | undefined {
  const auth = resolveWebhookSourceAuth(workspacePath, input.source);

  if (input.source === 'github') {
    if (!auth.signingSecret) {
      return 'GitHub signing secret is not configured.';
    }
    const provided = input.headers['x-hub-signature-256'];
    if (!provided) {
      return 'Missing GitHub signature header.';
    }
    const expected = signGitHubPayload(input.rawBody, auth.signingSecret);
    if (!secureEqual(provided, expected)) {
      return 'Invalid GitHub signature.';
    }
    return undefined;
  }

  if (input.source === 'slack') {
    if (!auth.signingSecret) {
      return 'Slack signing secret is not configured.';
    }
    const timestamp = input.headers['x-slack-request-timestamp'];
    const signature = input.headers['x-slack-signature'];
    if (!timestamp || !signature) {
      return 'Missing Slack signing headers.';
    }
    const parsedTs = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(parsedTs)) {
      return 'Invalid Slack timestamp.';
    }
    const ageSeconds = Math.abs(Math.floor(input.now.getTime() / 1000) - parsedTs);
    if (ageSeconds > SLACK_SIGNATURE_WINDOW_SECONDS) {
      return 'Slack signature timestamp is outside the allowed window.';
    }
    const expected = signSlackPayload(input.rawBody, timestamp, auth.signingSecret);
    if (!secureEqual(signature, expected)) {
      return 'Invalid Slack signature.';
    }
    return undefined;
  }

  if (sourceUsesApiKey(input.source)) {
    if (!auth.apiKey) {
      return `Webhook API key is not configured for source "${input.source}".`;
    }
    const provided = readApiKeyFromHeaders(input.headers);
    if (!provided) {
      return 'Missing webhook API key.';
    }
    if (!secureEqual(provided, auth.apiKey)) {
      return 'Invalid webhook API key.';
    }
    return undefined;
  }

  return undefined;
}

function readApiKeyFromHeaders(headers: Record<string, string>): string | undefined {
  const fromHeader = readOptionalString(headers['x-api-key']);
  if (fromHeader) return fromHeader;
  const authorization = readOptionalString(headers.authorization);
  if (!authorization) return undefined;
  if (!authorization.startsWith('Bearer ')) return undefined;
  return readOptionalString(authorization.slice('Bearer '.length));
}

function sourceUsesApiKey(source: string): boolean {
  return source === 'linear' || source === 'generic' || (source !== 'github' && source !== 'slack');
}

function normalizeHeaders(headers: Record<string, unknown>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    if (Array.isArray(rawValue)) {
      const first = readOptionalString(rawValue[0]);
      if (first) output[key] = first;
      continue;
    }
    const value = readOptionalString(String(rawValue ?? ''));
    if (value) output[key] = value;
  }
  return output;
}

function readRawBody(rawBody: string | undefined, payload: Record<string, unknown>): string {
  const provided = readOptionalString(rawBody);
  if (provided) return provided;
  return JSON.stringify(payload);
}

function signGitHubPayload(rawBody: string, secret: string): string {
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return `sha256=${digest}`;
}

function signSlackPayload(rawBody: string, timestamp: string, secret: string): string {
  const baseString = `v0:${timestamp}:${rawBody}`;
  const digest = crypto.createHmac('sha256', secret).update(baseString).digest('hex');
  return `v0=${digest}`;
}

function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function buildEventKey(deliveryId: string, eventType: string, routeId: string): string {
  return `${deliveryId}:${eventType}:${routeId}`;
}

function normalizeSource(value: string): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) {
    throw new Error('Webhook source is required.');
  }
  return normalized;
}

function normalizeEndpointId(value: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error('Webhook endpoint id is required.');
  }
  return normalized;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
