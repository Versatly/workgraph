import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { ConcurrencyError, StateCorruptionError } from './errors.js';

const DEFAULT_STALE_LOCK_MS = 5 * 60_000;
const lockState = new Map<string, number>();

interface LockFilePayload {
  pid: number;
  createdAt: string;
  key: string;
}

export function withFileLock<T>(
  workspacePath: string,
  lockScope: string,
  fn: () => T,
  options: {
    staleMs?: number;
  } = {},
): T {
  const lockPath = fileLockPath(workspacePath, lockScope);
  const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
  const localDepth = lockState.get(lockPath) ?? 0;
  if (localDepth > 0) {
    lockState.set(lockPath, localDepth + 1);
    try {
      return fn();
    } finally {
      decrementLocalLockDepth(lockPath);
    }
  }

  acquireLockFile(lockPath, lockScope, staleMs);
  lockState.set(lockPath, 1);
  try {
    return fn();
  } finally {
    decrementLocalLockDepth(lockPath);
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      // Non-critical lock cleanup failure.
    }
  }
}

export function atomicWriteFile(filePath: string, contents: string): void {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  const tmpPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  fs.writeFileSync(tmpPath, contents, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

export function readJsonFileOrFallback<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new StateCorruptionError(`Failed to parse JSON file at ${filePath}.`, { target: filePath }, { cause: error });
  }
}

function fileLockPath(workspacePath: string, lockScope: string): string {
  const lockDir = path.join(workspacePath, '.workgraph', 'locks');
  if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });
  const lockName = `${crypto.createHash('sha1').update(lockScope).digest('hex')}.lock`;
  return path.join(lockDir, lockName);
}

function acquireLockFile(lockPath: string, key: string, staleMs: number): void {
  try {
    const fd = fs.openSync(lockPath, 'wx');
    const payload: LockFilePayload = {
      pid: process.pid,
      createdAt: new Date().toISOString(),
      key,
    };
    fs.writeFileSync(fd, JSON.stringify(payload) + '\n', 'utf-8');
    fs.closeSync(fd);
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw new ConcurrencyError(`Unable to acquire lock for "${key}".`, { target: key }, { cause: error });
    }
    if (isStaleLock(lockPath, staleMs)) {
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        // If deletion fails, we'll fall through to a deterministic lock conflict.
      }
      acquireLockFile(lockPath, key, staleMs);
      return;
    }
    throw new ConcurrencyError(
      `Another worker currently holds lock "${key}". Retry shortly.`,
      { target: key },
      { cause: error },
    );
  }
}

function isAlreadyExists(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'EEXIST';
}

function decrementLocalLockDepth(lockPath: string): void {
  const depth = lockState.get(lockPath);
  if (!depth || depth <= 1) {
    lockState.delete(lockPath);
    return;
  }
  lockState.set(lockPath, depth - 1);
}

function isStaleLock(lockPath: string, staleMs: number): boolean {
  if (!fs.existsSync(lockPath)) return false;
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<LockFilePayload>;
    const createdAt = Date.parse(String(parsed.createdAt ?? ''));
    if (!Number.isFinite(createdAt)) return true;
    return Date.now() - createdAt >= staleMs;
  } catch {
    return true;
  }
}
