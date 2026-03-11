import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ledger as ledgerModule, workspace as workspaceModule } from '@versatly/workgraph-kernel';
import { startWorkgraphServer } from './server.js';
import {
  deleteWebhookGatewaySource,
  listWebhookGatewayLogs,
  listWebhookGatewaySources,
  registerWebhookGatewaySource,
  testWebhookGatewaySource,
} from './webhook-gateway.js';

const ledger = ledgerModule;
const workspace = workspaceModule;

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-webhook-gateway-'));
  workspace.initWorkspace(workspacePath, {
    createBases: false,
    createReadme: false,
  });
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('webhook gateway source lifecycle', () => {
  it('registers, lists, tests, and deletes sources', () => {
    const created = registerWebhookGatewaySource(workspacePath, {
      key: 'github-main',
      provider: 'github',
      secret: 'github-secret',
      actor: 'bot-github',
    });
    expect(created.key).toBe('github-main');
    expect(created.provider).toBe('github');
    expect(created.hasSecret).toBe(true);

    const listed = listWebhookGatewaySources(workspacePath);
    expect(listed).toHaveLength(1);
    expect(listed[0].key).toBe('github-main');

    const tested = testWebhookGatewaySource(workspacePath, {
      sourceKey: 'github-main',
      eventType: 'webhook.github.test.ping',
      payload: {
        ping: true,
      },
    });
    expect(tested.eventType).toBe('webhook.github.test.ping');
    expect(tested.log.status).toBe('accepted');

    const recent = ledger.recent(workspacePath, 5);
    const gatewayLedgerEntry = recent.find((entry) => entry.target.includes('.workgraph/webhook-gateway/github-main/'));
    expect(gatewayLedgerEntry).toBeDefined();
    expect(gatewayLedgerEntry?.type).toBe('event');

    const logs = listWebhookGatewayLogs(workspacePath, { limit: 10 });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]?.sourceKey).toBe('github-main');

    const deleted = deleteWebhookGatewaySource(workspacePath, 'github-main');
    expect(deleted).toBe(true);
    expect(listWebhookGatewaySources(workspacePath)).toHaveLength(0);
  });
});

describe('webhook gateway HTTP endpoint', () => {
  it('accepts valid GitHub signatures and emits event ledger entries', async () => {
    registerWebhookGatewaySource(workspacePath, {
      key: 'github-main',
      provider: 'github',
      secret: 'github-secret',
      actor: 'github-bot',
    });

    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const payload = JSON.stringify({
        action: 'opened',
        pull_request: {
          number: 42,
        },
      });
      const signature = signGithub(payload, 'github-secret');
      const response = await fetch(`${handle.baseUrl}/webhook-gateway/github-main`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': 'delivery-123',
          'x-hub-signature-256': signature,
        },
        body: payload,
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(202);
      expect(body.accepted).toBe(true);
      expect(body.eventType).toBe('webhook.github.pull_request');

      const recent = ledger.recent(workspacePath, 10);
      const entry = recent.find((item) => item.target.includes('.workgraph/webhook-gateway/github-main/delivery-123'));
      expect(entry).toBeDefined();
      expect(entry?.data?.event_type).toBe('webhook.github.pull_request');

      const logs = listWebhookGatewayLogs(workspacePath, { limit: 1 });
      expect(logs[0]?.status).toBe('accepted');
      expect(logs[0]?.signatureVerified).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('deduplicates GitHub webhook retries by delivery id', async () => {
    registerWebhookGatewaySource(workspacePath, {
      key: 'github-main',
      provider: 'github',
      secret: 'github-secret',
      actor: 'github-bot',
    });

    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const payload = JSON.stringify({
        action: 'synchronize',
        pull_request: {
          number: 42,
        },
      });
      const signature = signGithub(payload, 'github-secret');
      const first = await fetch(`${handle.baseUrl}/webhook-gateway/github-main`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': 'delivery-dup-1',
          'x-hub-signature-256': signature,
        },
        body: payload,
      });
      const firstBody = await first.json() as Record<string, unknown>;
      expect(first.status).toBe(202);
      expect(firstBody.accepted).toBe(true);

      const second = await fetch(`${handle.baseUrl}/webhook-gateway/github-main`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': 'delivery-dup-1',
          'x-hub-signature-256': signature,
        },
        body: payload,
      });
      const secondBody = await second.json() as Record<string, unknown>;
      expect(second.status).toBe(200);
      expect(secondBody.accepted).toBe(false);
      expect(secondBody.reason).toBe('duplicate');
      expect(secondBody.duplicateBy).toBe('deliveryId');

      const recent = ledger.recent(workspacePath, 20);
      const gatewayEntries = recent.filter((entry) => entry.target.includes('.workgraph/webhook-gateway/github-main/delivery-dup-1'));
      expect(gatewayEntries).toHaveLength(1);
    } finally {
      await handle.close();
    }
  });

  it('deduplicates GitHub webhook retries by payload digest', async () => {
    registerWebhookGatewaySource(workspacePath, {
      key: 'github-main',
      provider: 'github',
      secret: 'github-secret',
      actor: 'github-bot',
    });

    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const payload = JSON.stringify({
        action: 'opened',
        issue: {
          number: 77,
        },
      });
      const signature = signGithub(payload, 'github-secret');
      const first = await fetch(`${handle.baseUrl}/webhook-gateway/github-main`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues',
          'x-github-delivery': 'delivery-digest-1',
          'x-hub-signature-256': signature,
        },
        body: payload,
      });
      expect(first.status).toBe(202);

      const second = await fetch(`${handle.baseUrl}/webhook-gateway/github-main`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues',
          'x-github-delivery': 'delivery-digest-2',
          'x-hub-signature-256': signature,
        },
        body: payload,
      });
      const secondBody = await second.json() as Record<string, unknown>;
      expect(second.status).toBe(200);
      expect(secondBody.accepted).toBe(false);
      expect(secondBody.reason).toBe('duplicate');
      expect(secondBody.duplicateBy).toBe('payloadDigest');

      const recent = ledger.recent(workspacePath, 20);
      const gatewayEntries = recent.filter((entry) => entry.target.includes('.workgraph/webhook-gateway/github-main/'));
      expect(gatewayEntries).toHaveLength(1);
    } finally {
      await handle.close();
    }
  });

  it('rejects invalid GitHub signatures', async () => {
    registerWebhookGatewaySource(workspacePath, {
      key: 'github-main',
      provider: 'github',
      secret: 'github-secret',
    });

    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const payload = JSON.stringify({
        action: 'created',
      });
      const response = await fetch(`${handle.baseUrl}/webhook-gateway/github-main`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issue_comment',
          'x-hub-signature-256': 'sha256=deadbeef',
        },
        body: payload,
      });
      const body = await response.json() as Record<string, unknown>;
      expect(response.status).toBe(401);
      expect(String(body.error)).toContain('GitHub signature verification failed');

      const logs = listWebhookGatewayLogs(workspacePath, { limit: 1 });
      expect(logs[0]?.status).toBe('rejected');
      expect(logs[0]?.statusCode).toBe(401);
    } finally {
      await handle.close();
    }
  });

  it('rejects stale Slack timestamps even with valid signature', async () => {
    registerWebhookGatewaySource(workspacePath, {
      key: 'slack-main',
      provider: 'slack',
      secret: 'slack-secret',
    });

    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const payload = JSON.stringify({
        type: 'event_callback',
        event: {
          type: 'message',
        },
      });
      const staleTimestamp = String(Math.floor(Date.now() / 1_000) - 60 * 10);
      const signature = signSlack(payload, 'slack-secret', staleTimestamp);
      const response = await fetch(`${handle.baseUrl}/webhook-gateway/slack-main`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-slack-request-timestamp': staleTimestamp,
          'x-slack-signature': signature,
        },
        body: payload,
      });
      const body = await response.json() as Record<string, unknown>;
      expect(response.status).toBe(401);
      expect(String(body.error)).toContain('outside the accepted time window');
    } finally {
      await handle.close();
    }
  });

  it('accepts unsigned generic source when no secret is configured', async () => {
    registerWebhookGatewaySource(workspacePath, {
      key: 'generic-main',
      provider: 'generic',
    });

    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const payload = JSON.stringify({
        type: 'deploy.completed',
        env: 'prod',
      });
      const response = await fetch(`${handle.baseUrl}/webhook-gateway/generic-main`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-webhook-event': 'deploy.completed',
          'x-request-id': 'req-123',
        },
        body: payload,
      });
      const body = await response.json() as Record<string, unknown>;
      expect(response.status).toBe(202);
      expect(body.eventType).toBe('webhook.generic.deploy.completed');

      const logs = listWebhookGatewayLogs(workspacePath, { limit: 1 });
      expect(logs[0]?.status).toBe('accepted');
      expect(logs[0]?.signatureVerified).toBe(false);
    } finally {
      await handle.close();
    }
  });
});

function signGithub(rawBody: string, secret: string): string {
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return `sha256=${digest}`;
}

function signSlack(rawBody: string, secret: string, timestamp: string): string {
  const base = `v0:${timestamp}:${rawBody}`;
  const digest = crypto.createHmac('sha256', secret).update(base).digest('hex');
  return `v0=${digest}`;
}
