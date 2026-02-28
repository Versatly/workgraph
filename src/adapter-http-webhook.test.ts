import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpWebhookAdapter } from './adapter-http-webhook.js';
import type { DispatchAdapterExecutionInput } from './runtime-adapter-contracts.js';

const ENV_KEYS = [
  'WORKGRAPH_DISPATCH_WEBHOOK_URL',
  'WORKGRAPH_DISPATCH_WEBHOOK_TOKEN',
  'WORKGRAPH_DISPATCH_WEBHOOK_STATUS_URL',
] as const;

function makeInput(overrides: Partial<DispatchAdapterExecutionInput> = {}): DispatchAdapterExecutionInput {
  return {
    workspacePath: '/workspace/demo',
    runId: 'run-webhook-1',
    actor: 'agent-webhook',
    objective: 'Test webhook adapter',
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

describe('HttpWebhookAdapter', () => {
  const envSnapshot: Record<string, string | undefined> = {};
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const key of ENV_KEYS) {
      envSnapshot[key] = process.env[key];
      delete process.env[key];
    }
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const key of ENV_KEYS) {
      if (envSnapshot[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = envSnapshot[key];
      }
    }
  });

  it('returns failed when webhook URL is missing', async () => {
    const adapter = new HttpWebhookAdapter();
    const result = await adapter.execute(makeInput());

    expect(result.status).toBe('failed');
    expect(result.error).toContain('requires context.webhook_url');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts payload with headers and returns immediate terminal response', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        text: JSON.stringify({
          status: 'succeeded',
          output: 'remote success',
        }),
      }),
    );
    const adapter = new HttpWebhookAdapter();
    const result = await adapter.execute(
      makeInput({
        context: {
          webhook_url: 'https://dispatch.example/runs',
          webhook_token: 'token-123',
          webhook_headers: {
            'X-Trace-Id': 'trace-1',
            priority: 5,
          },
        },
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://dispatch.example/runs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-trace-id': 'trace-1',
        priority: '5',
        authorization: 'Bearer token-123',
      },
      body: expect.any(String),
    });
    expect(result.status).toBe('succeeded');
    expect(result.output).toBe('remote success');
    expect(result.metrics).toMatchObject({
      adapter: 'http-webhook',
      httpStatus: 200,
    });
  });

  it('returns failed result for non-2xx webhook responses', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        text: 'upstream down',
      }),
    );
    const adapter = new HttpWebhookAdapter();
    const result = await adapter.execute(
      makeInput({
        context: {
          webhook_url: 'https://dispatch.example/runs',
        },
      }),
    );

    expect(result.status).toBe('failed');
    expect(result.error).toContain('http-webhook request failed (502)');
    expect(result.error).toContain('upstream down');
    expect(result.logs.some((entry) => entry.level === 'error')).toBe(true);
  });

  it('treats acknowledged non-terminal response as synchronous success when no poll URL is provided', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 202,
        text: JSON.stringify({
          status: 'running',
          accepted: true,
        }),
      }),
    );
    const adapter = new HttpWebhookAdapter();
    const result = await adapter.execute(
      makeInput({
        context: {
          webhook_url: 'https://dispatch.example/runs',
        },
      }),
    );

    expect(result.status).toBe('succeeded');
    expect(result.output).toContain('"accepted":true');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('polls status endpoint until a terminal result is returned', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 202,
          text: JSON.stringify({
            status: 'running',
            pollUrl: 'https://dispatch.example/runs/run-webhook-1/status',
          }),
        }),
      )
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          text: JSON.stringify({
            status: 'running',
          }),
        }),
      )
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          text: JSON.stringify({
            status: 'succeeded',
            output: 'poll-complete',
          }),
        }),
      );

    const adapter = new HttpWebhookAdapter();
    const execution = adapter.execute(
      makeInput({
        context: {
          webhook_url: 'https://dispatch.example/runs',
          webhook_poll_ms: 250,
          webhook_max_wait_ms: 2_000,
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(300);
    const result = await execution;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://dispatch.example/runs/run-webhook-1/status',
      expect.objectContaining({
        method: 'GET',
      }),
    );
    expect(result.status).toBe('succeeded');
    expect(result.output).toBe('poll-complete');
    expect(result.metrics).toMatchObject({
      adapter: 'http-webhook',
      pollUrl: 'https://dispatch.example/runs/run-webhook-1/status',
      pollHttpStatus: 200,
    });
  });

  it('returns cancelled when cancellation is requested during polling', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 202,
        text: JSON.stringify({
          status: 'running',
          pollUrl: 'https://dispatch.example/runs/run-webhook-1/status',
        }),
      }),
    );
    const adapter = new HttpWebhookAdapter();
    const result = await adapter.execute(
      makeInput({
        context: {
          webhook_url: 'https://dispatch.example/runs',
        },
        isCancelled: () => true,
      }),
    );

    expect(result.status).toBe('cancelled');
    expect(result.output).toContain('polling cancelled');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails when polling exceeds timeout window', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (_url: string, requestInit?: RequestInit) => {
      if (requestInit?.method === 'POST') {
        return mockResponse({
          ok: true,
          status: 202,
          text: JSON.stringify({
            status: 'running',
            pollUrl: 'https://dispatch.example/runs/run-webhook-1/status',
          }),
        });
      }
      return mockResponse({
        ok: true,
        status: 200,
        text: JSON.stringify({
          status: 'running',
        }),
      });
    });

    const adapter = new HttpWebhookAdapter();
    const execution = adapter.execute(
      makeInput({
        context: {
          webhook_url: 'https://dispatch.example/runs',
          webhook_poll_ms: 200,
          webhook_max_wait_ms: 1_000,
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(2_000);
    const result = await execution;

    expect(result.status).toBe('failed');
    expect(result.error).toContain('polling exceeded timeout');
  });
});
