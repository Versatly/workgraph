import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ledger as ledgerModule,
  workspace as workspaceModule,
} from '@versatly/workgraph-kernel';
import {
  listWebhookGatewayLogs,
  registerWebhookGatewaySource,
  startWorkgraphServer,
} from '@versatly/workgraph-control-api';

const ledger = ledgerModule;
const workspace = workspaceModule;

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-stress-webhook-flood-'));
  workspace.initWorkspace(workspacePath, {
    createReadme: false,
    createBases: false,
  });
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('stress: webhook gateway flood', () => {
  it('processes 500 mixed webhook requests without dropping events', { timeout: 30_000 }, async () => {
    const sourceKey = 'github-flood';
    const sharedSecret = 'flood-secret';
    const totalRequests = 500;
    const malformedEvery = 10;

    registerWebhookGatewaySource(workspacePath, {
      key: sourceKey,
      provider: 'github',
      secret: sharedSecret,
      actor: 'github-flood-bot',
    });

    const server = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
    });

    try {
      const validCount = totalRequests - Math.floor(totalRequests / malformedEvery);
      const responses: number[] = [];

      const tasks = Array.from({ length: totalRequests }, (_value, idx) => async () => {
        const malformed = idx % malformedEvery === 0;
        const payload = JSON.stringify({
          index: idx,
          action: malformed ? 'broken' : 'opened',
          pull_request: { number: idx },
        });
        const signature = signGithubPayload(
          payload,
          malformed ? `${sharedSecret}-invalid` : sharedSecret,
        );
        const response = await fetch(`${server.baseUrl}/webhook-gateway/${sourceKey}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-github-event': 'pull_request',
            'x-github-delivery': `flood-${idx}`,
            'x-hub-signature-256': signature,
          },
          body: payload,
        });
        responses.push(response.status);
      });

      await runBatched(tasks, 50);

      const accepted = responses.filter((statusCode) => statusCode === 202).length;
      const rejected = responses.filter((statusCode) => statusCode === 401).length;
      expect(accepted).toBe(validCount);
      expect(rejected).toBe(totalRequests - validCount);

      const logs = listWebhookGatewayLogs(workspacePath, { limit: 1_000, sourceKey });
      expect(logs.length).toBe(totalRequests);
      expect(logs.filter((entry) => entry.status === 'accepted').length).toBe(validCount);
      expect(logs.filter((entry) => entry.status === 'rejected').length).toBe(totalRequests - validCount);
      expect(logs.filter((entry) => entry.signatureVerified).length).toBe(validCount);

      const eventEntries = ledger.query(workspacePath, {
        type: 'event',
        targetIncludes: `.workgraph/webhook-gateway/${sourceKey}/`,
      });
      expect(eventEntries.length).toBe(validCount);

      const uniqueDeliveries = new Set(
        eventEntries.map((entry) => String(entry.data?.delivery_id ?? '')),
      );
      expect(uniqueDeliveries.size).toBe(validCount);
    } finally {
      await server.close();
    }
  });
});

function signGithubPayload(rawBody: string, secret: string): string {
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return `sha256=${digest}`;
}

async function runBatched(tasks: Array<() => Promise<void>>, batchSize: number): Promise<void> {
  for (let idx = 0; idx < tasks.length; idx += batchSize) {
    const batch = tasks.slice(idx, idx + batchSize).map((task) => task());
    await Promise.all(batch);
  }
}
