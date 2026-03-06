import { randomUUID } from 'node:crypto';

export type WebhookAdapterSource = 'github' | 'linear' | 'slack' | 'generic';

export interface ParsedWebhookEvent {
  source: string;
  eventType: string;
  deliveryId: string;
  payload: Record<string, unknown>;
  challenge?: string;
}

export interface WebhookSamplePayload {
  source: WebhookAdapterSource;
  defaultEventType: string;
  payload: Record<string, unknown>;
}

export function parseWebhookEvent(
  source: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
): ParsedWebhookEvent {
  const normalizedSource = normalizeSource(source);
  if (normalizedSource === 'github') {
    return parseGitHubWebhook(headers, payload);
  }
  if (normalizedSource === 'linear') {
    return parseLinearWebhook(headers, payload);
  }
  if (normalizedSource === 'slack') {
    return parseSlackWebhook(headers, payload);
  }
  return parseGenericWebhook(normalizedSource, headers, payload);
}

export function webhookSamplePayload(source: string, eventOverride?: string): WebhookSamplePayload {
  const normalizedSource = normalizeSource(source);
  if (normalizedSource === 'github') {
    return {
      source: 'github',
      defaultEventType: 'pr.merged',
      payload: {
        action: 'closed',
        pull_request: {
          id: 123,
          number: 42,
          merged: true,
          title: 'Add webhook gateway support',
        },
        repository: {
          full_name: 'versatly/workgraph',
        },
      },
    };
  }
  if (normalizedSource === 'linear') {
    return {
      source: 'linear',
      defaultEventType: 'issue.created',
      payload: {
        action: 'create',
        type: 'Issue',
        data: {
          id: 'lin_123',
          identifier: 'WG-19',
          title: 'Webhook gateway integration',
        },
      },
    };
  }
  if (normalizedSource === 'slack') {
    return {
      source: 'slack',
      defaultEventType: 'message',
      payload: {
        type: 'event_callback',
        event_id: 'EvTEST123',
        event: {
          type: 'message',
          channel: 'C123',
          text: 'Test webhook gateway message',
          user: 'U123',
        },
      },
    };
  }
  return {
    source: 'generic',
    defaultEventType: normalizeEventType(eventOverride ?? 'generic.received'),
    payload: {
      type: normalizeEventType(eventOverride ?? 'generic.received'),
      id: 'evt_generic_test',
      message: 'Generic webhook test payload',
      metadata: {
        source: normalizedSource,
      },
    },
  };
}

function parseGitHubWebhook(headers: Record<string, string>, payload: Record<string, unknown>): ParsedWebhookEvent {
  const githubEvent = normalizeEventType(headers['x-github-event'] ?? readString(payload.event) ?? 'unknown');
  const action = normalizeEventType(readString(payload.action) ?? 'updated');
  let eventType = githubEvent;

  if (githubEvent === 'pull_request') {
    if (action === 'closed' && readBoolean((payload.pull_request as Record<string, unknown> | undefined)?.merged)) {
      eventType = 'pr.merged';
    } else if (action === 'opened') {
      eventType = 'pr.opened';
    } else {
      eventType = 'pr.updated';
    }
  } else if (githubEvent === 'issues') {
    if (action === 'opened') {
      eventType = 'issue.created';
    } else if (action === 'edited' || action === 'closed' || action === 'reopened') {
      eventType = action === 'edited' ? 'issue.updated' : `issue.${action}`;
    } else {
      eventType = 'issue.updated';
    }
  } else if (githubEvent === 'push') {
    eventType = 'push';
  }

  return {
    source: 'github',
    eventType,
    deliveryId: headers['x-github-delivery'] ?? randomUUID(),
    payload,
  };
}

function parseLinearWebhook(headers: Record<string, string>, payload: Record<string, unknown>): ParsedWebhookEvent {
  const action = normalizeEventType(readString(payload.action) ?? 'update');
  const entity = normalizeEventType(readString(payload.type) ?? 'event');
  let eventType = `${entity}.${action}`;
  if (entity === 'issue') {
    if (action === 'create') {
      eventType = 'issue.created';
    } else if (action === 'update') {
      eventType = 'issue.updated';
    }
  }
  return {
    source: 'linear',
    eventType,
    deliveryId: headers['linear-delivery'] ?? headers['x-request-id'] ?? randomUUID(),
    payload,
  };
}

function parseSlackWebhook(headers: Record<string, string>, payload: Record<string, unknown>): ParsedWebhookEvent {
  const payloadType = normalizeEventType(readString(payload.type) ?? 'unknown');
  if (payloadType === 'url_verification') {
    const challenge = readString(payload.challenge) ?? '';
    return {
      source: 'slack',
      eventType: 'slack.url_verification',
      deliveryId: headers['x-slack-request-timestamp'] ?? randomUUID(),
      payload,
      challenge,
    };
  }

  if (payloadType === 'event_callback') {
    const event = toRecord(payload.event);
    const eventType = normalizeEventType(readString(event.type) ?? 'unknown');
    if (eventType === 'message') {
      return {
        source: 'slack',
        eventType: 'message',
        deliveryId: readString(payload.event_id) ?? headers['x-slack-request-timestamp'] ?? randomUUID(),
        payload,
      };
    }
    return {
      source: 'slack',
      eventType: `slack.${eventType}`,
      deliveryId: readString(payload.event_id) ?? headers['x-slack-request-timestamp'] ?? randomUUID(),
      payload,
    };
  }

  return {
    source: 'slack',
    eventType: `slack.${payloadType}`,
    deliveryId: readString(payload.event_id) ?? headers['x-slack-request-timestamp'] ?? randomUUID(),
    payload,
  };
}

function parseGenericWebhook(
  normalizedSource: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
): ParsedWebhookEvent {
  const eventType = normalizeEventType(
    headers['x-workgraph-event']
      ?? headers['x-webhook-event']
      ?? readString(payload.event_type)
      ?? readString(payload.type)
      ?? `${normalizedSource}.received`,
  );

  return {
    source: normalizedSource,
    eventType,
    deliveryId: headers['x-request-id'] ?? readString(payload.id) ?? randomUUID(),
    payload,
  };
}

function normalizeSource(value: string): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) {
    throw new Error('Webhook source is required.');
  }
  return normalized;
}

function normalizeEventType(value: string): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized || 'unknown';
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}
