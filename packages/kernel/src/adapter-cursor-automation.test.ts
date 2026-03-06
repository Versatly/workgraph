import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CursorAutomationAdapter } from './adapter-cursor-automation.js';
import type { DispatchAdapterExecutionInput } from './runtime-adapter-contracts.js';

function makeInput(
  workspacePath: string,
  overrides: Partial<DispatchAdapterExecutionInput> = {},
): DispatchAdapterExecutionInput {
  return {
    workspacePath,
    runId: 'run-cursor-1',
    actor: 'agent-cursor',
    objective: 'Run cursor automation adapter test',
    context: {},
    ...overrides,
  };
}

function mockResponse(options: { ok: boolean; status: number; text: string; statusText?: string }): Response {
  return {
    ok: options.ok,
    status: options.status,
    statusText: options.statusText ?? '',
    text: async () => options.text,
  } as Response;
}

describe('CursorAutomationAdapter', () => {
  let workspacePath: string;
  const fetchMock = vi.fn();

  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-cursor-adapter-'));
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it('fails when webhook URL is not configured', async () => {
    const adapter = new CursorAutomationAdapter();
    const result = await adapter.execute(makeInput(workspacePath));
    expect(result.status).toBe('failed');
    expect(result.error).toContain('cursor-bridge adapter requires --webhook-url');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dispatches payload and returns deferred running status when accepted', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 202,
        text: JSON.stringify({
          status: 'running',
          automationRunId: 'cursor-auto-42',
          message: 'accepted',
        }),
      }),
    );
    const adapter = new CursorAutomationAdapter();
    const result = await adapter.execute(
      makeInput(workspacePath, {
        context: {
          cursor_webhook_url: 'https://cursor.example/automations/dispatch',
          thread_path: 'threads/test-thread.md',
        },
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://cursor.example/automations/dispatch', {
      method: 'POST',
      headers: expect.objectContaining({
        'content-type': 'application/json',
        'x-workgraph-source': 'workgraph-dispatch',
      }),
      body: expect.any(String),
    });
    expect(result.status).toBe('running');
    expect(result.output).toContain('Cursor automation request accepted.');
    expect(result.metrics).toMatchObject({
      adapter: 'cursor-bridge',
      httpStatus: 202,
      automationRunId: 'cursor-auto-42',
    });
  });
});
