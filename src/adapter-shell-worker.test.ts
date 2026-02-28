import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchAdapterExecutionInput } from './runtime-adapter-contracts.js';
import { CursorCloudAdapter } from './adapter-cursor-cloud.js';
import { ShellWorkerAdapter } from './adapter-shell-worker.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';

interface FakeChildProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function makeInput(overrides: Partial<DispatchAdapterExecutionInput> = {}): DispatchAdapterExecutionInput {
  return {
    workspacePath: '/workspace/demo',
    runId: 'run-shell-1',
    actor: 'agent-shell',
    objective: 'Test shell worker adapter',
    context: {},
    ...overrides,
  };
}

function createFakeChildProcess(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

describe('ShellWorkerAdapter', () => {
  const spawnMock = vi.mocked(spawn);

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('falls back to cursor-cloud adapter when shell_command is not configured', async () => {
    const fallbackSpy = vi.spyOn(CursorCloudAdapter.prototype, 'execute').mockResolvedValue({
      status: 'succeeded',
      output: 'fallback result',
      logs: [],
      metrics: {
        adapter: 'cursor-cloud',
      },
    });
    const adapter = new ShellWorkerAdapter();

    const result = await adapter.execute(makeInput());

    expect(spawnMock).not.toHaveBeenCalled();
    expect(fallbackSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-shell-1',
      }),
    );
    expect(result.status).toBe('succeeded');
    expect(result.output).toBe('fallback result');
  });

  it('executes shell command successfully and captures stdout/stderr', async () => {
    spawnMock.mockImplementation(() => {
      const child = createFakeChildProcess();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('hello shell\n'));
        child.stderr.emit('data', Buffer.from('warning line\n'));
        child.emit('close', 0);
      });
      return child as unknown as ReturnType<typeof spawn>;
    });
    const adapter = new ShellWorkerAdapter();

    const result = await adapter.execute(
      makeInput({
        context: {
          shell_command: 'echo hello shell',
          shell_cwd: '/tmp/shell-worker',
          shell_timeout_ms: 5000,
          shell_env: {
            TEST_FLAG: 'enabled',
          },
        },
      }),
    );

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      'echo hello shell',
      expect.objectContaining({
        cwd: '/tmp/shell-worker',
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: expect.objectContaining({
          TEST_FLAG: 'enabled',
        }),
      }),
    );
    expect(result.status).toBe('succeeded');
    expect(result.output).toContain('hello shell');
    expect(result.output).toContain('warning line');
    expect(result.metrics).toMatchObject({
      adapter: 'shell-worker',
      exitCode: 0,
    });
    expect(result.logs.some((entry) => entry.message.includes('[stdout] hello shell'))).toBe(true);
    expect(result.logs.some((entry) => entry.message.includes('[stderr] warning line'))).toBe(true);
  });

  it('returns failed result when command exits non-zero', async () => {
    spawnMock.mockImplementation(() => {
      const child = createFakeChildProcess();
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('boom\n'));
        child.emit('close', 7);
      });
      return child as unknown as ReturnType<typeof spawn>;
    });
    const adapter = new ShellWorkerAdapter();

    const result = await adapter.execute(
      makeInput({
        context: {
          shell_command: 'false',
        },
      }),
    );

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Exit code: 7');
    expect(result.error).toContain('boom');
    expect(result.logs.some((entry) => entry.level === 'error')).toBe(true);
  });

  it('marks command as failed when execution times out', async () => {
    let childRef: FakeChildProcess | undefined;
    spawnMock.mockImplementation(() => {
      const child = createFakeChildProcess();
      child.kill.mockImplementation(() => {
        setTimeout(() => {
          child.emit('close', 143);
        }, 0);
        return true;
      });
      childRef = child;
      return child as unknown as ReturnType<typeof spawn>;
    });
    const adapter = new ShellWorkerAdapter();

    const execution = adapter.execute(
      makeInput({
        context: {
          shell_command: 'sleep 999',
          shell_timeout_ms: 10,
        },
      }),
    );
    const result = await execution;

    expect(childRef?.kill).toHaveBeenCalledWith('SIGTERM');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Command: sleep 999');
    expect(result.error).toContain('Cancelled: no');
  });

  it('marks command as cancelled when cancellation signal is raised', async () => {
    vi.useFakeTimers();
    let childRef: FakeChildProcess | undefined;
    spawnMock.mockImplementation(() => {
      const child = createFakeChildProcess();
      child.kill.mockImplementation(() => {
        queueMicrotask(() => {
          child.emit('close', 143);
        });
        return true;
      });
      childRef = child;
      return child as unknown as ReturnType<typeof spawn>;
    });
    let cancelled = false;
    const adapter = new ShellWorkerAdapter();

    const execution = adapter.execute(
      makeInput({
        context: {
          shell_command: 'sleep 999',
          shell_timeout_ms: 2000,
        },
        isCancelled: () => cancelled,
      }),
    );
    cancelled = true;
    await vi.advanceTimersByTimeAsync(250);
    const result = await execution;

    expect(childRef?.kill).toHaveBeenCalledWith('SIGTERM');
    expect(result.status).toBe('cancelled');
    expect(result.output).toContain('Cancelled: yes');
  });
});
