import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fs from './storage-fs.js';
import { detectEnvironment } from './environment.js';

const SYNC_QUEUE_FILE = '.workgraph/sync-queue.jsonl';
const SYNC_STATE_FILE = '.workgraph/sync-state.json';

export interface SyncQueueOperation {
  id: string;
  ts: string;
  op: string;
  target?: string;
  type?: string;
  data?: Record<string, unknown>;
}

export interface SyncStatus {
  mode: 'local' | 'cloud';
  offline: boolean;
  pendingOperations: number;
  queuePath: string;
  lastSyncedAt?: string;
}

export interface SyncRecordResult {
  queued: boolean;
  replayed: number;
  pending: number;
}

export function syncQueuePath(workspacePath: string): string {
  return path.join(workspacePath, SYNC_QUEUE_FILE);
}

export function syncStatePath(workspacePath: string): string {
  return path.join(workspacePath, SYNC_STATE_FILE);
}

export function recordSyncOperation(
  workspacePath: string,
  operation: Omit<SyncQueueOperation, 'id' | 'ts'>,
): SyncRecordResult {
  const env = detectEnvironment(workspacePath);
  if (env.mode !== 'cloud') {
    return {
      queued: false,
      replayed: 0,
      pending: 0,
    };
  }

  if (env.offline) {
    const entry: SyncQueueOperation = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      ...operation,
    };
    appendQueueEntry(workspacePath, entry);
    return {
      queued: true,
      replayed: 0,
      pending: readQueueEntries(workspacePath).length,
    };
  }

  const replayed = replayQueuedOperations(workspacePath);
  return {
    queued: false,
    replayed,
    pending: readQueueEntries(workspacePath).length,
  };
}

export function replayQueuedOperations(workspacePath: string): number {
  const env = detectEnvironment(workspacePath);
  if (env.mode !== 'cloud' || env.offline) return 0;
  const queued = readQueueEntries(workspacePath);
  if (queued.length === 0) {
    writeSyncState(workspacePath, {
      lastSyncedAt: new Date().toISOString(),
      replayed: 0,
    });
    return 0;
  }

  // Cloud transport backends can hook into this replay path in a future adapter.
  clearQueue(workspacePath);
  writeSyncState(workspacePath, {
    lastSyncedAt: new Date().toISOString(),
    replayed: queued.length,
  });
  return queued.length;
}

export function getSyncStatus(workspacePath: string): SyncStatus {
  const env = detectEnvironment(workspacePath);
  if (env.mode === 'cloud' && !env.offline) {
    replayQueuedOperations(workspacePath);
  }
  const state = readSyncState(workspacePath);
  return {
    mode: env.mode,
    offline: env.offline,
    pendingOperations: readQueueEntries(workspacePath).length,
    queuePath: SYNC_QUEUE_FILE,
    lastSyncedAt: typeof state.lastSyncedAt === 'string' ? state.lastSyncedAt : undefined,
  };
}

function appendQueueEntry(workspacePath: string, entry: SyncQueueOperation): void {
  const filePath = syncQueuePath(workspacePath);
  ensureParentDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
}

function readQueueEntries(workspacePath: string): SyncQueueOperation[] {
  const filePath = syncQueuePath(workspacePath);
  if (!fs.existsSync(filePath)) return [];
  const lines = String(fs.readFileSync(filePath, 'utf-8'))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const entries: SyncQueueOperation[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as SyncQueueOperation;
      if (typeof parsed.id !== 'string' || typeof parsed.op !== 'string') continue;
      entries.push(parsed);
    } catch {
      // Ignore malformed lines to avoid blocking sync status reporting.
    }
  }
  return entries;
}

function clearQueue(workspacePath: string): void {
  const filePath = syncQueuePath(workspacePath);
  if (!fs.existsSync(filePath)) return;
  fs.rmSync(filePath, { force: true });
}

function writeSyncState(workspacePath: string, state: Record<string, unknown>): void {
  const filePath = syncStatePath(workspacePath);
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

function readSyncState(workspacePath: string): Record<string, unknown> {
  const filePath = syncStatePath(workspacePath);
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(String(fs.readFileSync(filePath, 'utf-8'))) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
