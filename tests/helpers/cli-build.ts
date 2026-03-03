import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

const BUILD_LOCK_DIR = path.join(os.tmpdir(), 'workgraph-cli-build-lock');
const DIST_ENTRY = path.resolve('dist/cli.js');
const PNPM_COMMAND = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const BUILD_LOCK_POLL_MS = 50;
const SLEEP_BUFFER = new SharedArrayBuffer(4);
const SLEEP_ARRAY = new Int32Array(SLEEP_BUFFER);

export function ensureCliBuiltForTests(): void {
  if (fs.existsSync(DIST_ENTRY)) return;

  acquireBuildLock();
  try {
    if (fs.existsSync(DIST_ENTRY)) return;
    const result = runBuild();
    if (result.status !== 0) {
      throw new Error(`Failed to build CLI for tests.\n${formatBuildFailure(result)}`);
    }
  } finally {
    releaseBuildLock();
  }
}

function acquireBuildLock(): void {
  // Directory creation is atomic; retries coordinate concurrent test workers.
  while (true) {
    try {
      fs.mkdirSync(BUILD_LOCK_DIR);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      sleep(BUILD_LOCK_POLL_MS);
    }
  }
}

function releaseBuildLock(): void {
  fs.rmSync(BUILD_LOCK_DIR, { recursive: true, force: true });
}

function runBuild(): SpawnSyncReturns<string> {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return spawnSync(process.execPath, [npmExecPath, 'run', '--silent', 'build'], {
      encoding: 'utf-8',
    });
  }
  return spawnSync(PNPM_COMMAND, ['run', '--silent', 'build'], {
    encoding: 'utf-8',
  });
}

function formatBuildFailure(result: SpawnSyncReturns<string>): string {
  const stderr = result.stderr?.trim();
  const stdout = result.stdout?.trim();
  const error = result.error?.message;
  return [
    `status=${String(result.status)} signal=${String(result.signal)}`,
    error ? `error=${error}` : '',
    `stdout:\n${stdout || '(empty)'}`,
    `stderr:\n${stderr || '(empty)'}`,
  ].filter(Boolean).join('\n');
}

function sleep(ms: number): void {
  Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
}
