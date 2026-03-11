import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  transport as transportModule,
  workspace as workspaceModule,
} from '@versatly/workgraph-kernel';
import { dispatchWebhookEvent, registerWebhook } from './server-webhooks.js';
import type { DashboardEvent } from './server-events.js';

const transport = transportModule;
const workspace = workspaceModule;

let workspacePath: string;

function makeEvent(): DashboardEvent {
  return {
    id: 'evt_dashboard_1',
    type: 'thread.done',
    path: 'threads/example.md',
    actor: 'agent-a',
    fields: {
      status: 'done',
    },
    ts: '2026-03-11T10:00:00.000Z',
  };
}

function mockResponse(options: { ok: boolean; status: number; text?: string; statusText?: string }): Response {
  return {
    ok: options.ok,
    status: options.status,
    statusText: options.statusText ?? '',
    text: async () => options.text ?? '',
  } as Response;
}

describe('server webhook transport integration', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-server-webhooks-'));
    workspace.initWorkspace(workspacePath, {
      createReadme: false,
      createBases: false,
    });
    vi.restoreAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it('writes outbox records for successful webhook deliveries', async () => {
    registerWebhook(workspacePath, {
      url: 'https://hooks.example/success',
      events: ['thread.*'],
    });
    fetchMock.mockResolvedValueOnce(mockResponse({
      ok: true,
      status: 202,
    }));

    await dispatchWebhookEvent(workspacePath, makeEvent());

    const outbox = transport.listTransportOutbox(workspacePath);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].status).toBe('delivered');
    expect(outbox[0].deliveryHandler).toBe('dashboard-webhook');
  });

  it('writes dead-letter records when webhook delivery fails', async () => {
    registerWebhook(workspacePath, {
      url: 'https://hooks.example/failure',
      events: ['thread.*'],
    });
    fetchMock.mockResolvedValueOnce(mockResponse({
      ok: false,
      status: 500,
      statusText: 'Server Error',
    }));

    await dispatchWebhookEvent(workspacePath, makeEvent());

    const outbox = transport.listTransportOutbox(workspacePath);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].status).toBe('failed');

    const deadLetters = transport.listTransportDeadLetters(workspacePath);
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].sourceRecordId).toBe(outbox[0].id);
  });
});
