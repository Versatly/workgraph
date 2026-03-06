import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  registry as registryModule,
} from '@versatly/workgraph-kernel';
import {
  createWebhookTestRequest,
  ingestWebhookRequest,
  listWebhookLogs,
  registerWebhookRoute,
} from './server-webhook-gateway.js';

const registry = registryModule;

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-webhook-gateway-'));
  registry.saveRegistry(workspacePath, registry.loadRegistry(workspacePath));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('server webhook gateway', () => {
  it('ingests signed sample payloads and routes all supported sources', () => {
    const cases: Array<{
      source: string;
      event: string;
      signingSecret?: string;
      apiKey?: string;
    }> = [
      {
        source: 'github',
        event: 'pr.merged',
        signingSecret: 'github-secret',
      },
      {
        source: 'linear',
        event: 'issue.created',
        apiKey: 'linear-key',
      },
      {
        source: 'slack',
        event: 'message',
        signingSecret: 'slack-secret',
      },
      {
        source: 'generic',
        event: 'generic.received',
        apiKey: 'generic-key',
      },
    ];

    for (const testCase of cases) {
      const triggerPath = createActiveTrigger(workspacePath, `${testCase.source} trigger`, testCase.event);
      const registration = registerWebhookRoute(workspacePath, {
        source: testCase.source,
        event: testCase.event,
        trigger: triggerPath,
        signingSecret: testCase.signingSecret,
        apiKey: testCase.apiKey,
      });
      expect(registration.route.triggerPath).toBe(triggerPath);

      const request = createWebhookTestRequest(workspacePath, {
        source: testCase.source,
        endpointId: `${testCase.source}-endpoint`,
      });
      const result = ingestWebhookRequest(workspacePath, {
        source: testCase.source,
        endpointId: request.endpointId,
        headers: request.headers,
        payload: request.body,
        rawBody: request.rawBody,
      });
      expect(result.ok).toBe(true);
      expect(result.statusCode).toBe(202);
      expect(result.eventType).toBe(testCase.event);
      expect(result.triggeredRoutes).toBe(1);
      expect(result.runIds.length).toBe(1);
    }

    const logs = listWebhookLogs(workspacePath, { limit: 10 });
    expect(logs.length).toBe(4);
    expect(new Set(logs.map((entry) => entry.source))).toEqual(
      new Set(['github', 'linear', 'slack', 'generic']),
    );
  });

  it('rejects invalid signatures and appends rejected logs', () => {
    const triggerPath = createActiveTrigger(workspacePath, 'GitHub trigger', 'pr.merged');
    registerWebhookRoute(workspacePath, {
      source: 'github',
      event: 'pr.merged',
      trigger: triggerPath,
      signingSecret: 'correct-secret',
    });
    const request = createWebhookTestRequest(workspacePath, {
      source: 'github',
      endpointId: 'repo-one',
    });
    request.headers['x-hub-signature-256'] = 'sha256=bad';

    const result = ingestWebhookRequest(workspacePath, {
      source: 'github',
      endpointId: request.endpointId,
      headers: request.headers,
      payload: request.body,
      rawBody: request.rawBody,
    });
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(result.errors[0]).toContain('Invalid GitHub signature');

    const logs = listWebhookLogs(workspacePath, { source: 'github', limit: 5 });
    expect(logs.length).toBe(1);
    expect(logs[0]?.accepted).toBe(false);
    expect(logs[0]?.statusCode).toBe(401);
  });
});

function createActiveTrigger(workspacePathValue: string, title: string, event: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const relativePath = `triggers/${slug || 'webhook-trigger'}.md`;
  const absolutePath = path.join(workspacePathValue, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(
    absolutePath,
    [
      '---',
      `title: ${title}`,
      'status: active',
      `event: ${event}`,
      'action:',
      '  type: dispatch-run',
      '---',
      '',
      '# Trigger',
      '',
      'Auto-created test trigger.',
      '',
    ].join('\n'),
    'utf-8',
  );
  return relativePath;
}
