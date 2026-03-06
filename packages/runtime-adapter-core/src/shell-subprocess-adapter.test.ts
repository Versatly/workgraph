import { describe, expect, it, vi } from 'vitest';
import type { DispatchAdapterExecutionInput } from '@versatly/workgraph-kernel';
import { ShellWorkerAdapter } from '@versatly/workgraph-kernel';
import { ShellSubprocessAdapter } from './shell-subprocess-adapter.js';

function makeInput(overrides: Partial<DispatchAdapterExecutionInput> = {}): DispatchAdapterExecutionInput {
  return {
    workspacePath: '/workspace/demo',
    runId: 'run-shell-runtime-core',
    actor: 'agent-runtime-core',
    objective: 'run shell adapter',
    context: {},
    ...overrides,
  };
}

describe('ShellSubprocessAdapter', () => {
  it('dispatches runs and exposes polling/log retrieval', async () => {
    const executeSpy = vi.spyOn(ShellWorkerAdapter.prototype, 'execute').mockResolvedValue({
      status: 'succeeded',
      output: 'shell-ok',
      logs: [{
        ts: new Date().toISOString(),
        level: 'info',
        message: 'shell run done',
      }],
      metrics: {
        adapter: 'shell-worker',
      },
    });
    const adapter = new ShellSubprocessAdapter();

    const handle = await adapter.dispatch(makeInput(), {
      metadata: {
        requestedBy: 'unit-test',
      },
    });
    expect(handle.adapter).toBe('shell');
    expect(handle.runId).toBe('run-shell-runtime-core');

    const polled = await waitForTerminalStatus(adapter, handle.runId);
    const logs = await adapter.logs(handle.runId);
    expect(polled.status).toBe('succeeded');
    expect(polled.output).toBe('shell-ok');
    expect(logs.some((entry) => entry.message.includes('shell run done'))).toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it('supports cancellation through runtime lifecycle', async () => {
    const executeSpy = vi.spyOn(ShellWorkerAdapter.prototype, 'execute').mockImplementation(async (input) => {
      await sleep(10);
      return {
        status: input.isCancelled?.() ? 'cancelled' : 'succeeded',
        output: input.isCancelled?.() ? 'cancelled' : 'completed',
        logs: [],
      };
    });
    const adapter = new ShellSubprocessAdapter();

    await adapter.dispatch(makeInput({
      runId: 'run-shell-runtime-core-cancel',
    }));
    await adapter.cancel('run-shell-runtime-core-cancel', 'agent-runtime-core');
    const status = await waitForTerminalStatus(adapter, 'run-shell-runtime-core-cancel');
    expect(status.status).toBe('cancelled');
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });
});

async function waitForTerminalStatus(adapter: ShellSubprocessAdapter, runId: string): Promise<{ status: string; output?: string }> {
  for (let i = 0; i < 30; i += 1) {
    const status = await adapter.poll(runId);
    if (status.status === 'succeeded' || status.status === 'failed' || status.status === 'cancelled') {
      return status;
    }
    await sleep(5);
  }
  return adapter.poll(runId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
