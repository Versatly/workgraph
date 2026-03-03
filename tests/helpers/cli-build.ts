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
const CLI_BUILD_DEPENDENCIES = [
  path.resolve('package.json'),
  path.resolve('tsup.config.ts'),
  path.resolve('packages/cli/src'),
  path.resolve('packages/kernel/src'),
  path.resolve('packages/control-api/src'),
  path.resolve('packages/mcp-server/src'),
  path.resolve('packages/adapter-claude-code/src'),
  path.resolve('packages/adapter-cursor-cloud/src'),
  path.resolve('packages/obsidian-integration/src'),
  path.resolve('packages/policy/src'),
  path.resolve('packages/runtime-adapter-core/src'),
  path.resolve('packages/search-qmd-adapter/src'),
  path.resolve('packages/sdk/src'),
  path.resolve('packages/skills/src'),
];

export function ensureCliBuiltForTests(): void {
  if (!needsCliBuild()) return;

  acquireBuildLock();
  try {
    // Re-check under lock so only one worker pays build cost.
    if (!needsCliBuild()) return;
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
  if (process.platform === 'win32') {
    return spawnSync('cmd.exe', ['/d', '/s', '/c', `${PNPM_COMMAND} run --silent build`], {
      encoding: 'utf-8',
    });
  }
  return spawnSync(PNPM_COMMAND, ['run', '--silent', 'build'], {
    encoding: 'utf-8',
  });
}

function needsCliBuild(): boolean {
  if (!fs.existsSync(DIST_ENTRY)) return true;
  const distMtime = safeMtimeMs(DIST_ENTRY);
  if (distMtime === null) return true;
  return CLI_BUILD_DEPENDENCIES.some((entryPath) => hasNewerMtime(entryPath, distMtime));
}

function hasNewerMtime(entryPath: string, thresholdMtime: number): boolean {
  if (!fs.existsSync(entryPath)) return false;
  const stats = fs.statSync(entryPath);
  if (stats.isFile()) {
    return stats.mtimeMs > thresholdMtime;
  }
  if (!stats.isDirectory()) return false;

  const entries = fs.readdirSync(entryPath);
  for (const childName of entries) {
    const childPath = path.join(entryPath, childName);
    if (hasNewerMtime(childPath, thresholdMtime)) return true;
  }
  return false;
}

function safeMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
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
