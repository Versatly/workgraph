import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  transport as transportModule,
} from '@versatly/workgraph-kernel';
import type { DashboardEvent } from './server-events.js';

const WEBHOOKS_PATH = '.workgraph/webhooks.json';
const WEBHOOKS_VERSION = 1;
const transport = transportModule;

interface WebhookStoreFile {
  version: number;
  webhooks: StoredWebhook[];
}

interface StoredWebhook {
  id: string;
  url: string;
  events: string[];
  secret?: string;
  createdAt: string;
}

export interface WebhookView {
  id: string;
  url: string;
  events: string[];
  createdAt: string;
  hasSecret: boolean;
}

export interface RegisterWebhookInput {
  url: string;
  events: string[];
  secret?: string;
}

export function listWebhooks(workspacePath: string): WebhookView[] {
  const store = readWebhookStore(workspacePath);
  return store.webhooks.map(toWebhookView);
}

export function registerWebhook(workspacePath: string, input: RegisterWebhookInput): WebhookView {
  const url = normalizeWebhookUrl(input.url);
  const events = normalizeEventPatterns(input.events);
  const secret = readOptionalString(input.secret);

  const store = readWebhookStore(workspacePath);
  const record: StoredWebhook = {
    id: randomUUID(),
    url,
    events,
    createdAt: new Date().toISOString(),
    ...(secret ? { secret } : {}),
  };
  store.webhooks.push(record);
  writeWebhookStore(workspacePath, store);
  return toWebhookView(record);
}

export function deleteWebhook(workspacePath: string, id: string): boolean {
  const normalizedId = String(id ?? '').trim();
  if (!normalizedId) return false;
  const store = readWebhookStore(workspacePath);
  const before = store.webhooks.length;
  store.webhooks = store.webhooks.filter((item) => item.id !== normalizedId);
  if (store.webhooks.length === before) return false;
  writeWebhookStore(workspacePath, store);
  return true;
}

export async function dispatchWebhookEvent(workspacePath: string, event: DashboardEvent): Promise<void> {
  const store = readWebhookStore(workspacePath);
  const matching = store.webhooks.filter((webhook) =>
    webhook.events.some((pattern) => eventPatternMatches(pattern, event.type))
  );
  if (matching.length === 0) return;

  const payload = JSON.stringify({
    id: event.id,
    type: event.type,
    path: event.path,
    actor: event.actor,
    fields: event.fields,
    ts: event.ts,
  });
  await Promise.allSettled(
    matching.map(async (webhook) => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (webhook.secret) {
        headers['X-WorkGraph-Signature'] = signPayload(payload, webhook.secret);
      }
      const envelope = transport.createTransportEnvelope({
        direction: 'outbound',
        channel: 'dashboard-webhook',
        topic: event.type,
        source: 'control-api.server-events',
        target: webhook.url,
        dedupKeys: [`dashboard-event:${event.id}`, `webhook:${webhook.id}:${event.id}`],
        correlationId: event.id,
        payload: {
          event,
          webhookId: webhook.id,
          request: {
            url: webhook.url,
            method: 'POST',
            headers,
            body: payload,
          },
        },
      });
      const outbox = transport.createTransportOutboxRecord(workspacePath, {
        envelope,
        deliveryHandler: 'dashboard-webhook',
        deliveryTarget: webhook.url,
        message: `Dispatching dashboard event ${event.id} to webhook ${webhook.id}.`,
      });
      try {
        const response = await fetch(webhook.url, {
          method: 'POST',
          headers,
          body: payload,
        });
        if (!response.ok) {
          throw new Error(`Webhook ${webhook.id} responded with status ${response.status}.`);
        }
        transport.markTransportOutboxDelivered(workspacePath, outbox.id, `Delivered dashboard event ${event.id}.`);
      } catch (error) {
        transport.markTransportOutboxFailed(workspacePath, outbox.id, {
          message: error instanceof Error ? error.message : String(error),
          context: {
            webhookId: webhook.id,
            eventId: event.id,
            url: webhook.url,
          },
        });
        throw error;
      }
    }),
  );
}

function readWebhookStore(workspacePath: string): WebhookStoreFile {
  const filePath = webhookFilePath(workspacePath);
  if (!fs.existsSync(filePath)) {
    return {
      version: WEBHOOKS_VERSION,
      webhooks: [],
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as WebhookStoreFile;
    if (!Array.isArray(parsed.webhooks)) {
      throw new Error('Invalid webhook store shape.');
    }
    return {
      version: WEBHOOKS_VERSION,
      webhooks: parsed.webhooks
        .map((webhook) => sanitizeStoredWebhook(webhook))
        .filter((entry): entry is StoredWebhook => entry !== null),
    };
  } catch {
    return {
      version: WEBHOOKS_VERSION,
      webhooks: [],
    };
  }
}

function writeWebhookStore(workspacePath: string, store: WebhookStoreFile): void {
  const filePath = webhookFilePath(workspacePath);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const serialized: WebhookStoreFile = {
    version: WEBHOOKS_VERSION,
    webhooks: store.webhooks.map((webhook) => ({
      id: webhook.id,
      url: webhook.url,
      events: webhook.events,
      ...(webhook.secret ? { secret: webhook.secret } : {}),
      createdAt: webhook.createdAt,
    })),
  };
  fs.writeFileSync(filePath, JSON.stringify(serialized, null, 2) + '\n', 'utf-8');
}

function webhookFilePath(workspacePath: string): string {
  return path.join(workspacePath, WEBHOOKS_PATH);
}

function normalizeWebhookUrl(value: string): string {
  const raw = String(value ?? '').trim();
  if (!raw) {
    throw new Error('Missing webhook url.');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid webhook url "${raw}".`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid webhook url "${raw}". Expected http(s).`);
  }
  return parsed.toString();
}

function normalizeEventPatterns(value: string[]): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Missing webhook events. Provide at least one event pattern.');
  }
  const normalized = value
    .map((item) => String(item).trim())
    .filter(Boolean);
  if (normalized.length === 0) {
    throw new Error('Missing webhook events. Provide at least one event pattern.');
  }
  return [...new Set(normalized)];
}

function signPayload(payload: string, secret: string): string {
  const digest = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `sha256=${digest}`;
}

function eventPatternMatches(pattern: string, eventType: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) {
    return eventType.startsWith(pattern.slice(0, -1));
  }
  return pattern === eventType;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeStoredWebhook(raw: unknown): StoredWebhook | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<StoredWebhook>;
  const id = readOptionalString(candidate.id);
  const url = readOptionalString(candidate.url);
  const createdAt = readOptionalString(candidate.createdAt) ?? new Date(0).toISOString();
  if (!id || !url) return null;
  const events = normalizeStoredEvents(candidate.events);
  if (events.length === 0) return null;
  return {
    id,
    url,
    events,
    createdAt,
    ...(readOptionalString(candidate.secret) ? { secret: readOptionalString(candidate.secret)! } : {}),
  };
}

function normalizeStoredEvents(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item).trim())
    .filter(Boolean);
}

function toWebhookView(webhook: StoredWebhook): WebhookView {
  return {
    id: webhook.id,
    url: webhook.url,
    events: [...webhook.events],
    createdAt: webhook.createdAt,
    hasSecret: typeof webhook.secret === 'string' && webhook.secret.length > 0,
  };
}
