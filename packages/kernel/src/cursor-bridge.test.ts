import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createCursorBridgeWebhookSignature,
  dispatchCursorAutomationEvent,
  getCursorBridgeStatus,
  listCursorBridgeEvents,
  receiveCursorAutomationWebhook,
  setupCursorBridge,
} from './cursor-bridge.js';
import { loadRegistry, saveRegistry } from './registry.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-cursor-bridge-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('cursor bridge', () => {
  it('persists setup and reports status with webhook/dispatch defaults', () => {
    setupCursorBridge(workspacePath, {
      actor: 'cursor-ops',
      enabled: true,
      secret: 'bridge-secret',
      allowedEventTypes: ['cursor.automation.*'],
      dispatch: {
        adapter: 'shell-worker',
        execute: true,
        maxSteps: 42,
      },
    });

    const status = getCursorBridgeStatus(workspacePath, { recentEventsLimit: 3 });
    expect(status.configured).toBe(true);
    expect(status.enabled).toBe(true);
    expect(status.webhook.hasSecret).toBe(true);
    expect(status.webhook.allowedEventTypes).toEqual(['cursor.automation.*']);
    expect(status.dispatch.actor).toBe('cursor-ops');
    expect(status.dispatch.adapter).toBe('shell-worker');
    expect(status.dispatch.execute).toBe(true);
    expect(status.dispatch.maxSteps).toBe(42);
    expect(status.recentEvents).toEqual([]);
  });

  it('creates queued dispatch runs and logs event bridge metadata', async () => {
    setupCursorBridge(workspacePath, {
      actor: 'cursor-ops',
      enabled: true,
      allowedEventTypes: ['cursor.automation.*'],
      dispatch: {
        adapter: 'cursor-cloud',
        execute: false,
      },
    });

    const result = await dispatchCursorAutomationEvent(workspacePath, {
      source: 'cli-dispatch',
      eventType: 'cursor.automation.run.completed',
      eventId: 'evt_queued_1',
      objective: 'Sync Cursor completion into queued dispatch run',
      context: {
        cursor_job_id: 'job_123',
      },
    });

    expect(result.run.status).toBe('queued');
    expect(result.run.context?.cursor_bridge).toMatchObject({
      event_type: 'cursor.automation.run.completed',
      event_id: 'evt_queued_1',
      source: 'cli-dispatch',
    });
    const events = listCursorBridgeEvents(workspacePath, { limit: 5 });
    expect(events).toHaveLength(1);
    expect(events[0].runId).toBe(result.run.id);
    expect(events[0].runStatus).toBe('queued');
    expect(events[0].error).toBeUndefined();
  });

  it('can execute bridged runs via dispatch integration defaults', async () => {
    setupCursorBridge(workspacePath, {
      actor: 'cursor-ops',
      enabled: true,
      allowedEventTypes: ['*'],
      dispatch: {
        adapter: 'shell-worker',
        execute: true,
      },
    });
    const shellCommand = `"${process.execPath}" -e "process.stdout.write('cursor_bridge_ok')"`;

    const result = await dispatchCursorAutomationEvent(workspacePath, {
      eventType: 'cursor.automation.run.completed',
      eventId: 'evt_exec_1',
      objective: 'Execute bridged run',
      context: {
        shell_command: shellCommand,
      },
    });

    expect(result.run.status).toBe('succeeded');
    expect(result.run.output).toContain('cursor_bridge_ok');
    const latest = listCursorBridgeEvents(workspacePath, { limit: 1 })[0];
    expect(latest.runId).toBe(result.run.id);
    expect(latest.runStatus).toBe('succeeded');
  });

  it('rejects signed webhooks when signature verification fails', async () => {
    setupCursorBridge(workspacePath, {
      actor: 'cursor-ops',
      enabled: true,
      secret: 'bridge-secret',
      allowedEventTypes: ['cursor.automation.*'],
      dispatch: {
        adapter: 'cursor-cloud',
        execute: false,
      },
    });
    const body = JSON.stringify({
      id: 'evt_bad_sig',
      type: 'cursor.automation.run.completed',
      objective: 'Dispatch should not happen',
    });

    await expect(receiveCursorAutomationWebhook(workspacePath, {
      body,
      headers: {
        'x-cursor-signature': 'sha256=deadbeef',
      },
    })).rejects.toThrow('Invalid Cursor webhook signature.');
  });

  it('accepts valid signed webhooks and enforces allowed event patterns', async () => {
    setupCursorBridge(workspacePath, {
      actor: 'cursor-ops',
      enabled: true,
      secret: 'bridge-secret',
      allowedEventTypes: ['cursor.automation.run.*'],
      dispatch: {
        adapter: 'cursor-cloud',
        execute: false,
      },
    });
    const body = JSON.stringify({
      id: 'evt_webhook_ok',
      type: 'cursor.automation.run.completed',
      objective: 'Webhook to dispatch',
    });
    const signature = createCursorBridgeWebhookSignature({
      secret: 'bridge-secret',
      body,
    });
    const accepted = await receiveCursorAutomationWebhook(workspacePath, {
      body,
      headers: {
        'x-cursor-signature': signature,
      },
    });
    expect(accepted.run.status).toBe('queued');
    expect(accepted.event.source).toBe('webhook');
    expect(accepted.event.eventType).toBe('cursor.automation.run.completed');

    const disallowedBody = JSON.stringify({
      id: 'evt_webhook_denied',
      type: 'cursor.automation.workflow.started',
      objective: 'Should be rejected',
    });
    const disallowedSignature = createCursorBridgeWebhookSignature({
      secret: 'bridge-secret',
      body: disallowedBody,
    });
    await expect(receiveCursorAutomationWebhook(workspacePath, {
      body: disallowedBody,
      headers: {
        'x-cursor-signature': disallowedSignature,
      },
    })).rejects.toThrow('is not allowed by bridge configuration');
  });
});
