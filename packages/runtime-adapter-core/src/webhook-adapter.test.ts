import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DispatchAdapterExecutionInput } from '@versatly/workgraph-kernel';
import { adapterHttpWebhook } from '@versatly/workgraph-kernel';
import { WebhookAdapter } from './webhook-adapter.js';

function makeInput(overrides: Partial<DispatchAdapterExecutionInput> = {}): DispatchAdapterExecutionInput {
  return {
    workspacePath: '/workspace/demo',
    runId: 'run-webhook-runtime-core',
    actor: 'agent-runtime-core',
    objective: 'run webhook adapter',
    context: {
      webhook_url: 'https://dispatch.example/runs',
    },
    ...overrides,
  };
}

function mockResponse(ok: boolean, status: number): Response {
  return {
    ok,
    status,
    text: async () => '',
  } as Response;
}

describe('WebhookAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('dispatches through kernel webhook adapter and stores result', async () => {
    const executeSpy = vi.spyOn(adapterHttpWebhook.HttpWebhookAdapter.prototype, 'execute').mockResolvedValue({
      status: 'succeeded',
      output: 'webhook-ok',
      logs: [{
        ts: new Date().toISOString(),
        level: 'info',
        message: 'webhook done',
      }],
    });
    const adapter = new WebhookAdapter();

    await adapter.dispatch(makeInput());
    const status = await waitForTerminalStatus(adapter, 'run-webhook-runtime-core');
    expect(status.status).toBe('succeeded');
    expect(status.output).toBe('webhook-ok');
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it('runs health checks against configured endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(true, 200));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new WebhookAdapter();

    const result = await adapter.healthCheck({
      context: {
        webhook_health_url: 'https://dispatch.example/health',
      },
    });

    expect(result.ok).toBe(true);
    expect(result.adapter).toBe('webhook');
    expect(fetchMock).toHaveBeenCalledWith('https://dispatch.example/health', expect.objectContaining({
      method: 'HEAD',
    }));
  });
});

async function waitForTerminalStatus(adapter: WebhookAdapter, runId: string): Promise<{ status: string; output?: string }> {
  for (let i = 0; i < 30; i += 1) {
    const status = await adapter.poll(runId);
    if (status.status === 'succeeded' || status.status === 'failed' || status.status === 'cancelled') {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return adapter.poll(runId);
}
