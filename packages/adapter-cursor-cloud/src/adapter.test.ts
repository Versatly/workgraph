import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DispatchAdapterExecutionInput } from '@versatly/workgraph-kernel';
import { adapterCursorCloud } from '@versatly/workgraph-kernel';
import { CursorCloudAdapter } from './adapter.js';

function makeInput(overrides: Partial<DispatchAdapterExecutionInput> = {}): DispatchAdapterExecutionInput {
  return {
    workspacePath: '/workspace/demo',
    runId: 'run-cursor-cloud-adapter',
    actor: 'agent-cursor-cloud',
    objective: 'run cursor cloud adapter',
    context: {},
    ...overrides,
  };
}

describe('adapter-cursor-cloud package adapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('supports runtime dispatch lifecycle methods', async () => {
    const executeSpy = vi.spyOn(adapterCursorCloud.CursorCloudAdapter.prototype, 'execute').mockResolvedValue({
      status: 'succeeded',
      output: 'cursor-ok',
      logs: [{
        ts: new Date().toISOString(),
        level: 'info',
        message: 'cursor cloud complete',
      }],
      metrics: {
        adapter: 'cursor-cloud',
      },
    });
    const adapter = new CursorCloudAdapter();

    const handle = await adapter.dispatch(makeInput());
    const status = await waitForTerminalStatus(adapter, handle.runId);
    const logs = await adapter.logs(handle.runId);
    const health = await adapter.healthCheck();

    expect(status.status).toBe('succeeded');
    expect(status.output).toBe('cursor-ok');
    expect(logs.some((entry) => entry.message.includes('cursor cloud complete'))).toBe(true);
    expect(health.ok).toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });
});

async function waitForTerminalStatus(adapter: CursorCloudAdapter, runId: string): Promise<{ status: string; output?: string }> {
  for (let i = 0; i < 30; i += 1) {
    const status = await adapter.poll(runId);
    if (status.status === 'succeeded' || status.status === 'failed' || status.status === 'cancelled') {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return adapter.poll(runId);
}
