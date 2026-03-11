import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createTransportEnvelope,
} from './envelope.js';
import {
  createTransportOutboxRecord,
  listTransportOutbox,
  markTransportOutboxDelivered,
  markTransportOutboxFailed,
  replayTransportOutboxRecord,
} from './outbox.js';
import {
  listTransportDeadLetters,
} from './dead-letter.js';
import {
  recordTransportInbox,
} from './inbox.js';

let workspacePath: string;

describe('transport records', () => {
  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-transport-'));
  });

  afterEach(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it('persists outbox delivery state and dead-letter failures', async () => {
    const envelope = createTransportEnvelope({
      direction: 'outbound',
      channel: 'dashboard-webhook',
      topic: 'thread.done',
      source: 'control-api.server-events',
      target: 'https://hooks.example/done',
      dedupKeys: ['event-1'],
      payload: {
        id: 'event-1',
      },
    });
    const outbox = createTransportOutboxRecord(workspacePath, {
      envelope,
      deliveryHandler: 'dashboard-webhook',
      deliveryTarget: 'https://hooks.example/done',
    });

    const delivered = markTransportOutboxDelivered(workspacePath, outbox.id, 'Delivered successfully.');
    expect(delivered?.status).toBe('delivered');
    expect(listTransportOutbox(workspacePath)[0]?.status).toBe('delivered');

    const failedEnvelope = createTransportEnvelope({
      direction: 'outbound',
      channel: 'runtime-bridge',
      topic: 'cursor.automation.run.completed',
      source: 'cursor-bridge',
      target: 'https://runtime.example/runs',
      dedupKeys: ['runtime-event-1'],
      payload: {
        id: 'runtime-event-1',
      },
    });
    const failedOutbox = createTransportOutboxRecord(workspacePath, {
      envelope: failedEnvelope,
      deliveryHandler: 'runtime-bridge',
      deliveryTarget: 'https://runtime.example/runs',
    });
    const failed = markTransportOutboxFailed(workspacePath, failedOutbox.id, {
      message: 'Runtime bridge offline',
      context: {
        attempt: 1,
      },
    });
    expect(failed?.status).toBe('failed');

    const deadLetters = listTransportDeadLetters(workspacePath);
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].sourceRecordId).toBe(failedOutbox.id);
    expect(deadLetters[0].error.message).toContain('Runtime bridge offline');

    const replayed = await replayTransportOutboxRecord(workspacePath, failedOutbox.id, async () => {});
    expect(replayed?.status).toBe('replayed');
  });

  it('persists inbound inbox records with durable deduplication', () => {
    const envelope = createTransportEnvelope({
      direction: 'inbound',
      channel: 'webhook-gateway',
      topic: 'webhook.github.pull_request',
      source: 'webhook-gateway:github-main',
      target: '.workgraph/webhook-gateway',
      dedupKeys: ['github-main:delivery:123', 'github-main:payload:abc'],
      payload: {
        deliveryId: '123',
      },
    });

    const first = recordTransportInbox(workspacePath, {
      envelope,
      dedupKeys: ['github-main:delivery:123', 'github-main:payload:abc'],
      message: 'Accepted inbound webhook event.',
    });
    expect(first.duplicate).toBe(false);

    const second = recordTransportInbox(workspacePath, {
      envelope,
      dedupKeys: ['github-main:delivery:123', 'github-main:payload:abc'],
      message: 'Accepted inbound webhook event.',
    });
    expect(second.duplicate).toBe(true);
    expect(second.record.id).toBe(first.record.id);
  });
});
