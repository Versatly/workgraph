import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from './adapter-claude-code.js';
import { ShellWorkerAdapter } from './adapter-shell-worker.js';
import type { DispatchAdapterExecutionInput, DispatchAdapterExecutionResult } from './runtime-adapter-contracts.js';

const ENV_KEYS = ['WORKGRAPH_CLAUDE_COMMAND_TEMPLATE', 'WORKGRAPH_CLAUDE_TIMEOUT_MS'] as const;

function makeInput(overrides: Partial<DispatchAdapterExecutionInput> = {}): DispatchAdapterExecutionInput {
  return {
    workspacePath: '/workspace/demo',
    runId: 'run-123',
    actor: 'agent-a',
    objective: "Fix user's parser reliability issue",
    ...overrides,
  };
}

describe('ClaudeCodeAdapter', () => {
  const envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      envSnapshot[key] = process.env[key];
      delete process.env[key];
    }
    vi.restoreAllMocks();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (envSnapshot[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = envSnapshot[key];
      }
    }
  });

  it('delegates lifecycle methods to the shell worker adapter', async () => {
    const createSpy = vi.spyOn(ShellWorkerAdapter.prototype, 'create').mockResolvedValue({
      runId: 'run-create',
      status: 'queued',
    });
    const statusSpy = vi.spyOn(ShellWorkerAdapter.prototype, 'status').mockResolvedValue({
      runId: 'run-status',
      status: 'running',
    });
    const followupSpy = vi.spyOn(ShellWorkerAdapter.prototype, 'followup').mockResolvedValue({
      runId: 'run-followup',
      status: 'running',
    });
    const stopSpy = vi.spyOn(ShellWorkerAdapter.prototype, 'stop').mockResolvedValue({
      runId: 'run-stop',
      status: 'cancelled',
    });
    const logsSpy = vi.spyOn(ShellWorkerAdapter.prototype, 'logs').mockResolvedValue([
      {
        ts: '2026-01-01T00:00:00.000Z',
        level: 'info',
        message: 'mock log entry',
      },
    ]);

    const adapter = new ClaudeCodeAdapter();
    await expect(adapter.create({ actor: 'agent-a', objective: 'create run' })).resolves.toEqual({
      runId: 'run-create',
      status: 'queued',
    });
    await expect(adapter.status('run-status')).resolves.toEqual({
      runId: 'run-status',
      status: 'running',
    });
    await expect(adapter.followup('run-followup', 'agent-a', 'continue')).resolves.toEqual({
      runId: 'run-followup',
      status: 'running',
    });
    await expect(adapter.stop('run-stop', 'agent-a')).resolves.toEqual({
      runId: 'run-stop',
      status: 'cancelled',
    });
    await expect(adapter.logs('run-logs')).resolves.toEqual([
      {
        ts: '2026-01-01T00:00:00.000Z',
        level: 'info',
        message: 'mock log entry',
      },
    ]);

    expect(createSpy).toHaveBeenCalledWith({ actor: 'agent-a', objective: 'create run' });
    expect(statusSpy).toHaveBeenCalledWith('run-status');
    expect(followupSpy).toHaveBeenCalledWith('run-followup', 'agent-a', 'continue');
    expect(stopSpy).toHaveBeenCalledWith('run-stop', 'agent-a');
    expect(logsSpy).toHaveBeenCalledWith('run-logs');
  });

  it('fails fast when no command template is configured', async () => {
    const executeSpy = vi.spyOn(ShellWorkerAdapter.prototype, 'execute');
    const adapter = new ClaudeCodeAdapter();

    const result = await adapter.execute(makeInput());

    expect(result.status).toBe('failed');
    expect(result.error).toContain('requires a command template');
    expect(result.logs[0]?.level).toBe('error');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('renders template values and augments shell-worker output', async () => {
    process.env.WORKGRAPH_CLAUDE_TIMEOUT_MS = '4567';
    const shellWorkerResult: DispatchAdapterExecutionResult = {
      status: 'succeeded',
      output: 'shell worker output',
      logs: [
        {
          ts: '2026-01-02T00:00:00.000Z',
          level: 'info',
          message: 'shell worker complete',
        },
      ],
      metrics: {
        existingMetric: true,
      },
    };
    const executeSpy = vi.spyOn(ShellWorkerAdapter.prototype, 'execute').mockResolvedValue(shellWorkerResult);

    const adapter = new ClaudeCodeAdapter();
    const result = await adapter.execute(
      makeInput({
        context: {
          claude_command_template:
            'runner --workspace {workspace} --run {run_id} --actor {actor} --objective "{objective}" --prompt-shell {prompt_shell} --prompt "{prompt}"',
          claude_instructions: 'Focus on maintainability and explicit tests.',
          shell_cwd: '   /tmp/workgraph-shell   ',
        },
      }),
    );

    expect(executeSpy).toHaveBeenCalledTimes(1);
    const shellInput = executeSpy.mock.calls[0][0];
    const command = String(shellInput.context?.shell_command ?? '');
    expect(command).toContain('--workspace /workspace/demo');
    expect(command).toContain('--run run-123');
    expect(command).toContain('--actor agent-a');
    expect(command).toContain('--objective "Fix user\'s parser reliability issue"');
    expect(command).toContain('Workgraph run id: run-123');
    expect(command).toContain('Instructions: Focus on maintainability and explicit tests.');
    expect(command).toContain("'\\''");
    expect(command).not.toContain('{run_id}');
    expect(shellInput.context?.shell_cwd).toBe('/tmp/workgraph-shell');
    expect(shellInput.context?.shell_timeout_ms).toBe('4567');

    expect(result.status).toBe('succeeded');
    expect(result.logs[0]?.message).toContain('dispatched shell execution');
    expect(result.logs).toHaveLength(2);
    expect(result.metrics).toMatchObject({
      existingMetric: true,
      adapter: 'claude-code',
    });
  });

  it('uses command template from environment when context template is missing', async () => {
    process.env.WORKGRAPH_CLAUDE_COMMAND_TEMPLATE = 'echo {actor}:{run_id}:{workspace}';
    const executeSpy = vi.spyOn(ShellWorkerAdapter.prototype, 'execute').mockResolvedValue({
      status: 'succeeded',
      output: 'ok',
      logs: [],
    });
    const adapter = new ClaudeCodeAdapter();

    await adapter.execute(makeInput());

    const shellInput = executeSpy.mock.calls[0][0];
    expect(String(shellInput.context?.shell_command)).toContain('echo agent-a:run-123:/workspace/demo');
  });
});
