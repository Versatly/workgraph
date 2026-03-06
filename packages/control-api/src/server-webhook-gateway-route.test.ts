import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  registry as registryModule,
} from '@versatly/workgraph-kernel';
import {
  createWebhookTestRequest,
  registerWebhookRoute,
} from './server-webhook-gateway.js';
import { startWorkgraphServer } from './server.js';

const registry = registryModule;

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-webhook-server-route-'));
  registry.saveRegistry(workspacePath, registry.loadRegistry(workspacePath));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('webhook route endpoint', () => {
  it('accepts signed github payload via POST /webhooks/:source/:id', async () => {
    const triggerPath = writeActiveTrigger(workspacePath, 'Github merged route', 'pr.merged');

    registerWebhookRoute(workspacePath, {
      source: 'github',
      event: 'pr.merged',
      trigger: triggerPath,
      signingSecret: 'github-secret',
    });

    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const request = createWebhookTestRequest(workspacePath, {
        source: 'github',
        endpointId: 'repo-19',
      });
      const response = await fetch(`${handle.baseUrl}/webhooks/github/repo-19`, {
        method: 'POST',
        headers: request.headers,
        body: request.rawBody,
      });
      const body = await response.json() as {
        ok: boolean;
        eventType: string;
        triggeredRoutes: number;
      };

      expect(response.status).toBe(202);
      expect(body.ok).toBe(true);
      expect(body.eventType).toBe('pr.merged');
      expect(body.triggeredRoutes).toBe(1);
    } finally {
      await handle.close();
    }
  });
});

function writeActiveTrigger(workspacePathValue: string, title: string, event: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const relativePath = `triggers/${slug || 'route-trigger'}.md`;
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
      'Route trigger fixture.',
      '',
    ].join('\n'),
    'utf-8',
  );
  return relativePath;
}
