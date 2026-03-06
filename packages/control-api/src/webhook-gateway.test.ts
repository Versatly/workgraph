import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agent as agentModule,
  dispatch as dispatchModule,
  trigger as triggerModule,
  workspace as workspaceModule,
} from '@versatly/workgraph-kernel';
import { startWorkgraphServer } from './server.js';
import { webhookTriggerPath } from './webhook-gateway.js';

const agent = agentModule;
const dispatch = dispatchModule;
const trigger = triggerModule;
const workspace = workspaceModule;
const WEBHOOK_ACTOR = 'webhook-admin';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-webhook-gateway-'));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('webhook gateway', () => {
  it('ingests signed GitHub webhook payloads and dispatches runs', async () => {
    const endpointId = 'repo-events';
    const secret = 'github-secret';
    await withServer(async (baseUrl) => {
      createWebhookTrigger('github', endpointId, {
        secret,
      });

      const payload = {
        action: 'opened',
        issue: { id: 42, title: 'Regression detected' },
        repository: { full_name: 'versatly/workgraph' },
        sender: { login: 'octocat' },
      };
      const rawBody = JSON.stringify(payload);
      const signature = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;

      const response = await fetch(`${baseUrl}/webhooks/github/${endpointId}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues',
          'x-github-delivery': 'gh-delivery-1',
          'x-hub-signature-256': signature,
        },
        body: rawBody,
      });
      const body = await response.json() as {
        ok: boolean;
        runStatus?: string;
        event?: {
          source: string;
          eventType: string;
          eventId: string;
          actor?: string;
          resource?: string;
        };
      };

      expect(response.status).toBe(202);
      expect(body.ok).toBe(true);
      expect(body.runStatus).toBe('queued');
      expect(body.event?.source).toBe('github');
      expect(body.event?.eventType).toBe('webhook.github.issues');
      expect(body.event?.eventId).toBe('gh-delivery-1');
      expect(body.event?.actor).toBe('octocat');
      expect(body.event?.resource).toBe('versatly/workgraph');

      const runs = dispatch.listRuns(workspacePath);
      expect(runs.length).toBe(1);
      expect(runs[0].context?.webhook).toMatchObject({
        source: 'github',
        endpoint_id: endpointId,
        event_type: 'webhook.github.issues',
      });
    });
  });

  it('handles Slack url_verification challenge without dispatching runs', async () => {
    const endpointId = 'team-events';
    const secret = 'slack-secret';
    await withServer(async (baseUrl) => {
      createWebhookTrigger('slack', endpointId, {
        signingSecret: secret,
      });

      const payload = {
        type: 'url_verification',
        challenge: 'challenge-token-123',
      };
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = `v0=${crypto.createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;

      const response = await fetch(`${baseUrl}/webhooks/slack/${endpointId}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
      });
      const body = await response.json() as {
        ok: boolean;
        challenge?: string;
      };

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.challenge).toBe('challenge-token-123');
      expect(dispatch.listRuns(workspacePath).length).toBe(0);
    });
  });

  it('ingests signed Slack event callbacks and dispatches runs', async () => {
    const endpointId = 'events';
    const secret = 'slack-signing-secret';
    await withServer(async (baseUrl) => {
      createWebhookTrigger('slack', endpointId, {
        signingSecret: secret,
      });

      const payload = {
        type: 'event_callback',
        event_id: 'Ev123',
        team_id: 'T123',
        event: {
          type: 'app_mention',
          user: 'U123',
          channel: 'C123',
        },
      };
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = `v0=${crypto.createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;

      const response = await fetch(`${baseUrl}/webhooks/slack/${endpointId}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': signature,
        },
        body: rawBody,
      });
      const body = await response.json() as {
        ok: boolean;
        event?: { eventType: string; eventId: string };
      };

      expect(response.status).toBe(202);
      expect(body.ok).toBe(true);
      expect(body.event?.eventType).toBe('webhook.slack.app_mention');
      expect(body.event?.eventId).toBe('Ev123');
      expect(dispatch.listRuns(workspacePath).length).toBe(1);
    });
  });

  it('ingests signed Linear webhook payloads and dispatches runs', async () => {
    const endpointId = 'issue-updates';
    const secret = 'linear-secret';
    await withServer(async (baseUrl) => {
      createWebhookTrigger('linear', endpointId, {
        linearSecret: secret,
      });

      const payload = {
        type: 'Issue',
        action: 'create',
        actor: {
          id: 'actor-1',
          name: 'Ada',
        },
        data: {
          id: 'lin_123',
          identifier: 'ENG-100',
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

      const response = await fetch(`${baseUrl}/webhooks/linear/${endpointId}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'linear-signature': signature,
        },
        body: rawBody,
      });
      const body = await response.json() as {
        ok: boolean;
        event?: { eventType: string; actor?: string; resource?: string };
      };

      expect(response.status).toBe(202);
      expect(body.ok).toBe(true);
      expect(body.event?.eventType).toBe('webhook.linear.Issue');
      expect(body.event?.actor).toBe('Ada');
      expect(body.event?.resource).toBe('ENG-100');
      expect(dispatch.listRuns(workspacePath).length).toBe(1);
    });
  });

  it('ingests generic API key webhook payloads and dispatches runs', async () => {
    const endpointId = 'generic-events';
    const apiKey = 'generic-api-key';
    await withServer(async (baseUrl) => {
      createWebhookTrigger('generic', endpointId, {
        apiKey,
      });

      const payload = {
        id: 'evt-001',
        type: 'incident.created',
        actor: 'monitoring-bot',
        resource: 'incident/42',
      };
      const rawBody = JSON.stringify(payload);
      const response = await fetch(`${baseUrl}/webhooks/generic/${endpointId}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'x-event-type': 'incident.created',
        },
        body: rawBody,
      });
      const body = await response.json() as {
        ok: boolean;
        event?: { eventType: string; eventId: string };
      };

      expect(response.status).toBe(202);
      expect(body.ok).toBe(true);
      expect(body.event?.eventType).toBe('webhook.generic.incident.created');
      expect(body.event?.eventId).toBe('evt-001');
      expect(dispatch.listRuns(workspacePath).length).toBe(1);
    });
  });
});

function createWebhookTrigger(
  source: 'github' | 'linear' | 'slack' | 'generic',
  endpointId: string,
  conditionExtension: Record<string, unknown>,
): void {
  const targetPath = webhookTriggerPath(source, endpointId);
  trigger.createTrigger(workspacePath, {
    actor: WEBHOOK_ACTOR,
    name: `Webhook ${source}/${endpointId}`,
    type: 'webhook',
    condition: {
      type: 'event',
      pattern: `webhook.${source}.*`,
      source,
      endpointId,
      ...conditionExtension,
    },
    action: {
      type: 'dispatch-run',
      objective: 'Handle {{webhook.event_type}}',
    },
    path: targetPath,
  });
}

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const init = workspace.initWorkspace(workspacePath, {
    createReadme: false,
    createBases: false,
  });
  agent.registerAgent(workspacePath, WEBHOOK_ACTOR, {
    token: init.bootstrapTrustToken,
    capabilities: [
      'dispatch:run',
      'thread:create',
      'thread:update',
      'policy:manage',
    ],
  });
  const handle = await startWorkgraphServer({
    workspacePath,
    host: '127.0.0.1',
    port: 0,
    defaultActor: WEBHOOK_ACTOR,
  });
  try {
    await run(handle.baseUrl);
  } finally {
    await handle.close();
  }
}
