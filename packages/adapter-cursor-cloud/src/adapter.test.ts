import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CursorCloudAdapter } from './adapter.js';
import type {
  DispatchAdapterCancelInput,
  DispatchAdapterDispatchInput,
  DispatchAdapterPollInput,
} from '@versatly/workgraph-runtime-adapter-core';

function makeDispatchInput(overrides: Partial<DispatchAdapterDispatchInput> = {}): DispatchAdapterDispatchInput {
  return {
    workspacePath: '/workspace/demo',
    runId: 'run_cursor_external_1',
    actor: 'agent-cursor',
    objective: 'Dispatch cursor task externally',
    context: {
      cursor_cloud_api_base_url: 'https://cursor.example/api',
    },
    followups: [],
    ...overrides,
  };
}

function makePollInput(overrides: Partial<DispatchAdapterPollInput> = {}): DispatchAdapterPollInput {
  return {
    workspacePath: '/workspace/demo',
    runId: 'run_cursor_external_1',
    actor: 'agent-cursor',
    objective: 'Poll cursor task externally',
    context: {
      cursor_cloud_api_base_url: 'https://cursor.example/api',
    },
    external: {
      provider: 'cursor-cloud',
      externalRunId: 'cursor-agent-123',
      correlationKeys: ['run_cursor_external_1'],
    },
    ...overrides,
  };
}

function makeCancelInput(overrides: Partial<DispatchAdapterCancelInput> = {}): DispatchAdapterCancelInput {
  return {
    workspacePath: '/workspace/demo',
    runId: 'run_cursor_external_1',
    actor: 'agent-cursor',
    objective: 'Cancel cursor task externally',
    context: {
      cursor_cloud_api_base_url: 'https://cursor.example/api',
    },
    external: {
      provider: 'cursor-cloud',
      externalRunId: 'cursor-agent-123',
      correlationKeys: ['run_cursor_external_1'],
    },
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

describe('CursorCloudAdapter external broker mode', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('dispatches external runs and returns provider correlation metadata', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({
      ok: true,
      status: 202,
      text: JSON.stringify({
        id: 'cursor-agent-123',
        status: 'queued',
        agentId: 'cursor-agent-primary',
      }),
    }));

    const adapter = new CursorCloudAdapter();
    const result = await adapter.dispatch!(makeDispatchInput());

    expect(fetchMock).toHaveBeenCalledWith(
      'https://cursor.example/api/runs',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'application/json',
        }),
      }),
    );
    expect(result.acknowledged).toBe(true);
    expect(result.status).toBe('queued');
    expect(result.external).toMatchObject({
      provider: 'cursor-cloud',
      externalRunId: 'cursor-agent-123',
      externalAgentId: 'cursor-agent-primary',
    });
  });

  it('polls and cancels external runs using provider endpoints', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({
        ok: true,
        status: 200,
        text: JSON.stringify({
          status: 'running',
          updatedAt: '2026-03-11T10:00:00.000Z',
        }),
      }))
      .mockResolvedValueOnce(mockResponse({
        ok: true,
        status: 202,
        text: JSON.stringify({
          status: 'cancelled',
        }),
      }));

    const adapter = new CursorCloudAdapter();
    const polled = await adapter.poll!(makePollInput());
    const cancelled = await adapter.cancel!(makeCancelInput());

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://cursor.example/api/runs/cursor-agent-123',
      expect.objectContaining({
        method: 'GET',
      }),
    );
    expect(polled?.status).toBe('running');
    expect(polled?.external?.externalRunId).toBe('cursor-agent-123');

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://cursor.example/api/runs/cursor-agent-123/cancel',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(cancelled.acknowledged).toBe(true);
    expect(cancelled.status).toBe('cancelled');
  });
});
