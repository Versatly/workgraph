import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initWorkspace } from './workspace.js';
import * as thread from './thread.js';
import { getSyncStatus } from './sync.js';

describe('offline cloud sync queue', () => {
  let workspacePath: string;

  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-sync-'));
    process.env.WORKGRAPH_STORAGE_MODE = 'cloud';
    process.env.WORKGRAPH_OFFLINE = '1';
  });

  afterEach(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    delete process.env.WORKGRAPH_STORAGE_MODE;
    delete process.env.WORKGRAPH_OFFLINE;
  });

  it('queues operations while offline and replays once online', () => {
    initWorkspace(workspacePath);
    thread.createThread(workspacePath, 'Offline queued thread', 'Queue and replay', 'agent-sync');

    const offlineStatus = getSyncStatus(workspacePath);
    expect(offlineStatus.mode).toBe('cloud');
    expect(offlineStatus.offline).toBe(true);
    expect(offlineStatus.pendingOperations).toBeGreaterThan(0);

    process.env.WORKGRAPH_OFFLINE = '0';
    const onlineStatus = getSyncStatus(workspacePath);
    expect(onlineStatus.offline).toBe(false);
    expect(onlineStatus.pendingOperations).toBe(0);
    expect(typeof onlineStatus.lastSyncedAt).toBe('string');
  });
});
