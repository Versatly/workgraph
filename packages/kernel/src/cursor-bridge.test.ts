import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, saveRegistry } from './registry.js';
import * as dispatch from './dispatch.js';
import * as store from './store.js';
import * as thread from './thread.js';
import {
  ingestCursorAutomationWebhook,
  normalizeCursorAutomationWebhookPayload,
} from './cursor-bridge.js';

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
  it('marks run terminal, stores evidence, and syncs related thread', () => {
    const actor = 'cursor-worker';
    const createdThread = thread.createThread(
      workspacePath,
      'Cursor bridge thread',
      'Implement bridge behavior',
      actor,
    );
    thread.claim(workspacePath, createdThread.path, actor);
    const run = dispatch.createRun(workspacePath, {
      actor,
      adapter: 'cursor-bridge',
      objective: 'Bridge objective',
      context: {
        thread_path: createdThread.path,
      },
    });

    const ingested = ingestCursorAutomationWebhook(workspacePath, {
      runId: run.id,
      status: 'succeeded',
      prUrl: 'https://github.com/versatly/workgraph/pull/123',
      output: 'Completed implementation',
      logs: [
        '[info] planning',
        '[info] tests passed',
      ],
      threadPath: createdThread.path,
    }, {
      actor,
    });

    expect(ingested.status).toBe('succeeded');
    expect(ingested.evidenceCount).toBeGreaterThan(0);
    expect(ingested.threadSync?.updated).toBe(true);

    const finalRun = dispatch.status(workspacePath, run.id);
    expect(finalRun.status).toBe('succeeded');
    expect(finalRun.context?.cursor_automation_pr_url).toBe('https://github.com/versatly/workgraph/pull/123');

    const evidence = dispatch.listRunEvidence(workspacePath, run.id);
    expect(evidence.some((item) => item.type === 'pr-url')).toBe(true);

    const finalThread = store.read(workspacePath, createdThread.path);
    expect(finalThread?.fields.status).toBe('done');
  });

  it('normalizes nested cursor automation webhook payload variants', () => {
    const normalized = normalizeCursorAutomationWebhookPayload({
      result: {
        status: 'completed',
        output: 'Finished run. PR: https://github.com/versatly/workgraph/pull/456',
        logs: [{ level: 'info', message: 'step completed' }],
      },
      metadata: {
        run_id: 'run_abc123',
        thread_path: 'threads/my-thread',
      },
    });

    expect(normalized.runId).toBe('run_abc123');
    expect(normalized.status).toBe('succeeded');
    expect(normalized.prUrl).toBe('https://github.com/versatly/workgraph/pull/456');
    expect(normalized.threadPath).toBe('threads/my-thread.md');
    expect(normalized.logs).toContain('[info] step completed');
  });
});

