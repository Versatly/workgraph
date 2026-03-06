import path from 'node:path';
import { spawn } from 'node:child_process';
import fs from './storage-fs.js';

const DAEMON_DIR = '.workgraph/daemon';
const AUTONOMY_PID_FILE = 'autonomy.pid';
const AUTONOMY_HEARTBEAT_FILE = 'autonomy-heartbeat.json';
const AUTONOMY_LOG_FILE = 'autonomy.log';
const AUTONOMY_META_FILE = 'autonomy-process.json';

export interface AutonomyDaemonStartInput {
  cliEntrypointPath: string;
  actor: string;
  adapter?: string;
  agents?: string[];
  pollMs?: number;
  maxCycles?: number;
  maxIdleCycles?: number;
  maxSteps?: number;
  stepDelayMs?: number;
  space?: string;
  executeTriggers?: boolean;
  executeReadyThreads?: boolean;
  logPath?: string;
  heartbeatPath?: string;
}

export interface AutonomyDaemonStopInput {
  signal?: NodeJS.Signals;
  timeoutMs?: number;
}

export interface AutonomyDaemonHeartbeat {
  ts: string;
  cycle?: number;
  readyThreads?: number;
  triggerActions?: number;
  runStatus?: string;
  driftOk?: boolean;
  driftIssues?: number;
  finalReadyThreads?: number;
  finalDriftOk?: boolean;
}

export interface AutonomyDaemonStatus {
  running: boolean;
  pid?: number;
  pidPath: string;
  logPath: string;
  heartbeatPath: string;
  heartbeat?: AutonomyDaemonHeartbeat;
}

export interface AutonomyDaemonStopResult {
  stopped: boolean;
  previouslyRunning: boolean;
  pid?: number;
  status: AutonomyDaemonStatus;
}

export function startAutonomyDaemon(
  workspacePath: string,
  input: AutonomyDaemonStartInput,
): AutonomyDaemonStatus {
  const daemonDir = ensureDaemonDir(workspacePath);
  const pidPath = path.join(daemonDir, AUTONOMY_PID_FILE);
  const heartbeatPath = input.heartbeatPath
    ? resolvePathWithinWorkspace(workspacePath, input.heartbeatPath)
    : path.join(daemonDir, AUTONOMY_HEARTBEAT_FILE);
  const logPath = input.logPath
    ? resolvePathWithinWorkspace(workspacePath, input.logPath)
    : path.join(daemonDir, AUTONOMY_LOG_FILE);
  const metaPath = path.join(daemonDir, AUTONOMY_META_FILE);

  const existing = readAutonomyDaemonStatus(workspacePath, { cleanupStalePidFile: true });
  if (existing.running) {
    throw new Error(`Autonomy daemon already running (pid=${existing.pid}). Stop it before starting a new one.`);
  }

  const logFd = fs.openSync(logPath, 'a');
  const args = buildAutonomyDaemonArgs(workspacePath, input, heartbeatPath);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });
  fs.closeSync(logFd);
  child.unref();
  if (!child.pid) {
    throw new Error('Failed to start autonomy daemon: missing child process pid.');
  }

  fs.writeFileSync(pidPath, `${child.pid}\n`, 'utf-8');
  fs.writeFileSync(metaPath, JSON.stringify({
    startedAt: new Date().toISOString(),
    pid: child.pid,
    args,
    actor: input.actor,
    adapter: input.adapter ?? 'cursor-cloud',
    logPath,
    heartbeatPath,
  }, null, 2) + '\n', 'utf-8');

  return readAutonomyDaemonStatus(workspacePath, { cleanupStalePidFile: true });
}

export async function stopAutonomyDaemon(
  workspacePath: string,
  input: AutonomyDaemonStopInput = {},
): Promise<AutonomyDaemonStopResult> {
  const status = readAutonomyDaemonStatus(workspacePath, { cleanupStalePidFile: false });
  if (!status.pid) {
    return {
      stopped: true,
      previouslyRunning: false,
      status: readAutonomyDaemonStatus(workspacePath, { cleanupStalePidFile: true }),
    };
  }

  const pid = status.pid;
  const signal = input.signal ?? 'SIGTERM';
  const timeoutMs = clampInt(input.timeoutMs, 5000, 250, 60_000);
  const previouslyRunning = isProcessAlive(pid);
  if (previouslyRunning) {
    process.kill(pid, signal);
  }
  await waitForProcessExit(pid, timeoutMs);
  let stopped = !isProcessAlive(pid);
  if (!stopped && signal !== 'SIGKILL') {
    process.kill(pid, 'SIGKILL');
    await waitForProcessExit(pid, 1500);
    stopped = !isProcessAlive(pid);
  }

  const pidPath = path.join(ensureDaemonDir(workspacePath), AUTONOMY_PID_FILE);
  if (stopped && fs.existsSync(pidPath)) {
    fs.rmSync(pidPath, { force: true });
  }
  return {
    stopped,
    previouslyRunning,
    pid,
    status: readAutonomyDaemonStatus(workspacePath, { cleanupStalePidFile: true }),
  };
}

export function readAutonomyDaemonStatus(
  workspacePath: string,
  options: { cleanupStalePidFile?: boolean } = {},
): AutonomyDaemonStatus {
  const daemonDir = ensureDaemonDir(workspacePath);
  const pidPath = path.join(daemonDir, AUTONOMY_PID_FILE);
  const meta = readDaemonMeta(path.join(daemonDir, AUTONOMY_META_FILE));
  const logPath = meta?.logPath ? String(meta.logPath) : path.join(daemonDir, AUTONOMY_LOG_FILE);
  const heartbeatPath = meta?.heartbeatPath ? String(meta.heartbeatPath) : path.join(daemonDir, AUTONOMY_HEARTBEAT_FILE);
  const pid = readPid(pidPath);
  const running = pid ? isProcessAlive(pid) : false;

  if (!running && pid && options.cleanupStalePidFile !== false && fs.existsSync(pidPath)) {
    fs.rmSync(pidPath, { force: true });
  }

  return {
    running,
    pid: running ? pid : undefined,
    pidPath,
    logPath,
    heartbeatPath,
    heartbeat: readHeartbeat(heartbeatPath),
  };
}

function buildAutonomyDaemonArgs(
  workspacePath: string,
  input: AutonomyDaemonStartInput,
  heartbeatPath: string,
): string[] {
  const args = [
    path.resolve(input.cliEntrypointPath),
    'autonomy',
    'run',
    '-w',
    workspacePath,
    '--actor',
    input.actor,
    '--adapter',
    input.adapter ?? 'cursor-cloud',
    '--watch',
    '--poll-ms',
    String(clampInt(input.pollMs, 2000, 100, 60_000)),
    '--max-idle-cycles',
    String(clampInt(input.maxIdleCycles, 2, 1, 10_000)),
    '--max-steps',
    String(clampInt(input.maxSteps, 200, 1, 5000)),
    '--step-delay-ms',
    String(clampInt(input.stepDelayMs, 25, 0, 5000)),
    '--heartbeat-file',
    heartbeatPath,
    '--json',
  ];
  if (typeof input.maxCycles === 'number') {
    args.push('--max-cycles', String(clampInt(input.maxCycles, 1, 1, Number.MAX_SAFE_INTEGER)));
  }
  if (input.agents && input.agents.length > 0) {
    args.push('--agents', input.agents.join(','));
  }
  if (input.space) {
    args.push('--space', input.space);
  }
  if (input.executeTriggers === false) {
    args.push('--no-execute-triggers');
  }
  if (input.executeReadyThreads === false) {
    args.push('--no-execute-ready-threads');
  }
  return args;
}

function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (!isProcessAlive(pid)) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
  });
}

function ensureDaemonDir(workspacePath: string): string {
  const daemonDir = path.join(workspacePath, DAEMON_DIR);
  if (!fs.existsSync(daemonDir)) fs.mkdirSync(daemonDir, { recursive: true });
  return daemonDir;
}

function readPid(pidPath: string): number | undefined {
  if (!fs.existsSync(pidPath)) return undefined;
  const raw = fs.readFileSync(pidPath, 'utf-8').trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function readHeartbeat(heartbeatPath: string): AutonomyDaemonHeartbeat | undefined {
  if (!fs.existsSync(heartbeatPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(heartbeatPath, 'utf-8')) as AutonomyDaemonHeartbeat;
    if (!parsed || typeof parsed !== 'object') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function readDaemonMeta(metaPath: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(metaPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (isZombieProcess(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isZombieProcess(pid: number): boolean {
  const statPath = `/proc/${pid}/stat`;
  if (!fs.existsSync(statPath)) return false;
  try {
    const stat = fs.readFileSync(statPath, 'utf-8');
    const closingIdx = stat.indexOf(')');
    if (closingIdx === -1 || closingIdx + 2 >= stat.length) return false;
    const state = stat.slice(closingIdx + 2, closingIdx + 3);
    return state === 'Z';
  } catch {
    return false;
  }
}

function resolvePathWithinWorkspace(workspacePath: string, filePath: string): string {
  const base = path.resolve(workspacePath);
  const resolved = path.resolve(base, filePath);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error(`Invalid path outside workspace: ${filePath}`);
  }
  return resolved;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, raw));
}
