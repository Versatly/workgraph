import { spawn } from 'node:child_process';
import type {
  DispatchAdapter,
  DispatchAdapterCreateInput,
  DispatchAdapterExecutionInput,
  DispatchAdapterExecutionResult,
  DispatchAdapterLogEntry,
  DispatchAdapterRunStatus,
} from './contracts.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CAPTURE_CHARS = 12_000;

export class ShellSubprocessAdapter implements DispatchAdapter {
  name = 'shell-subprocess';

  async create(_input: DispatchAdapterCreateInput): Promise<DispatchAdapterRunStatus> {
    return { runId: 'shell-subprocess-managed', status: 'queued' };
  }

  async status(runId: string): Promise<DispatchAdapterRunStatus> {
    return { runId, status: 'running' };
  }

  async followup(runId: string, _actor: string, _input: string): Promise<DispatchAdapterRunStatus> {
    return { runId, status: 'running' };
  }

  async stop(runId: string, _actor: string): Promise<DispatchAdapterRunStatus> {
    return { runId, status: 'cancelled' };
  }

  async logs(_runId: string): Promise<DispatchAdapterLogEntry[]> {
    return [];
  }

  async execute(input: DispatchAdapterExecutionInput): Promise<DispatchAdapterExecutionResult> {
    const command = readString(input.context?.shell_command);
    if (!command) {
      return {
        status: 'failed',
        error: 'shell-subprocess adapter requires context.shell_command.',
        logs: [],
      };
    }

    const shellCwd = readString(input.context?.shell_cwd) ?? input.workspacePath;
    const timeoutMs = clampInt(readNumber(input.context?.shell_timeout_ms), DEFAULT_TIMEOUT_MS, 1_000, 60 * 60 * 1_000);
    const shellEnv = readEnv(input.context?.shell_env);
    const logs: DispatchAdapterLogEntry[] = [];
    const startedAt = Date.now();
    const outputParts: string[] = [];
    const errorParts: string[] = [];

    pushLog(logs, 'info', `shell-subprocess starting command: ${command}`);
    pushLog(logs, 'info', `shell-subprocess cwd: ${shellCwd}`);

    const result = await runShellCommand({
      command,
      cwd: shellCwd,
      timeoutMs,
      env: shellEnv,
      isCancelled: input.isCancelled,
      onStdout: (chunk) => {
        outputParts.push(chunk);
        pushLog(logs, 'info', `[stdout] ${chunk.trimEnd()}`);
      },
      onStderr: (chunk) => {
        errorParts.push(chunk);
        pushLog(logs, 'warn', `[stderr] ${chunk.trimEnd()}`);
      },
    });

    const elapsedMs = Date.now() - startedAt;
    const stdout = truncateText(outputParts.join(''), MAX_CAPTURE_CHARS);
    const stderr = truncateText(errorParts.join(''), MAX_CAPTURE_CHARS);

    if (result.cancelled) {
      pushLog(logs, 'warn', `shell-subprocess command cancelled after ${elapsedMs}ms`);
      return {
        status: 'cancelled',
        output: formatShellOutput(command, result.exitCode, stdout, stderr, elapsedMs, true),
        logs,
      };
    }

    if (result.timedOut) {
      pushLog(logs, 'error', `shell-subprocess command timed out after ${elapsedMs}ms`);
      return {
        status: 'failed',
        error: formatShellOutput(command, result.exitCode, stdout, stderr, elapsedMs, false),
        logs,
      };
    }

    if (result.exitCode !== 0) {
      pushLog(logs, 'error', `shell-subprocess command failed with exit code ${result.exitCode}`);
      return {
        status: 'failed',
        error: formatShellOutput(command, result.exitCode, stdout, stderr, elapsedMs, false),
        logs,
      };
    }

    pushLog(logs, 'info', `shell-subprocess command succeeded in ${elapsedMs}ms`);
    return {
      status: 'succeeded',
      output: formatShellOutput(command, result.exitCode, stdout, stderr, elapsedMs, false),
      logs,
      metrics: {
        elapsedMs,
        exitCode: result.exitCode,
        adapter: this.name,
      },
    };
  }
}

interface RunShellCommandOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  env: Record<string, string>;
  isCancelled?: () => boolean;
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
}

interface RunShellCommandResult {
  exitCode: number;
  timedOut: boolean;
  cancelled: boolean;
}

async function runShellCommand(options: RunShellCommandOptions): Promise<RunShellCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(options.command, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolved = false;
    let timedOut = false;
    let cancelled = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_500).unref();
    }, options.timeoutMs);

    const cancelWatcher = setInterval(() => {
      if (options.isCancelled?.()) {
        cancelled = true;
        child.kill('SIGTERM');
      }
    }, 200);
    cancelWatcher.unref();

    child.stdout.on('data', (chunk: Buffer) => {
      options.onStdout(chunk.toString('utf-8'));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      options.onStderr(chunk.toString('utf-8'));
    });

    child.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);
      clearInterval(cancelWatcher);
      resolve({
        exitCode: typeof code === 'number' ? code : 1,
        timedOut,
        cancelled,
      });
    });

    child.on('error', () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);
      clearInterval(cancelWatcher);
      resolve({
        exitCode: 1,
        timedOut,
        cancelled,
      });
    });
  });
}

function pushLog(target: DispatchAdapterLogEntry[], level: DispatchAdapterLogEntry['level'], message: string): void {
  target.push({
    ts: new Date().toISOString(),
    level,
    message,
  });
}

function readEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!key) continue;
    if (raw === undefined || raw === null) continue;
    result[key] = String(raw);
  }
  return result;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const raw = typeof value === 'number' ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, raw));
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...[truncated]`;
}

function formatShellOutput(
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string,
  elapsedMs: number,
  cancelled: boolean,
): string {
  const lines = [
    'Shell subprocess execution summary',
    `Command: ${command}`,
    `Exit code: ${exitCode}`,
    `Elapsed ms: ${elapsedMs}`,
    `Cancelled: ${cancelled ? 'yes' : 'no'}`,
    '',
    'STDOUT:',
    stdout || '(empty)',
    '',
    'STDERR:',
    stderr || '(empty)',
  ];
  return lines.join('\n');
}
