import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchAdapterExecutionInput } from './contracts.js';
import { ShellSubprocessAdapter } from './shell-adapter.js';

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
    objective: 'Test shell adapter',
    context: {},
    ...overrides,
  };
}

function createFakeChildProcess(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true) as any;
  return child;
}

describe('ShellSubprocessAdapter', () => {
  const spawnMock = vi.mocked(spawn);

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns failed when shell command is missing', async () => {
    const adapter = new ShellSubprocessAdapter();
    const result = await adapter.execute(makeInput());

    expect(spawnMock).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('context.shell_command');
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
    const adapter = new ShellSubprocessAdapter();

    const result = await adapter.execute(
      makeInput({
        context: {
          shell_command: 'echo hello shell',
          shell_cwd: '/tmp/shell-subprocess',
          shell_timeout_ms: 5_000,
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
        cwd: '/tmp/shell-subprocess',
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
      adapter: 'shell-subprocess',
      exitCode: 0,
    });
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
    const adapter = new ShellSubprocessAdapter();

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
    const adapter = new ShellSubprocessAdapter();

    const execution = adapter.execute(
      makeInput({
        context: {
          shell_command: 'sleep 999',
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
