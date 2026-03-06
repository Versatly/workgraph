import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as federation from './federation.js';
import { loadRegistry, saveRegistry } from './registry.js';
import { createThread } from './thread.js';

let workspacePath: string;
let remoteWorkspacePath: string;

beforeEach(() => {
  workspacePath = createWorkspace('wg-federation-');
  remoteWorkspacePath = createWorkspace('wg-federation-remote-');
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
  fs.rmSync(remoteWorkspacePath, { recursive: true, force: true });
});

describe('federation config', () => {
  it('adds, lists, and removes remote workspaces', () => {
    const added = federation.addRemoteWorkspace(workspacePath, {
      id: 'remote-main',
      path: remoteWorkspacePath,
      name: 'Remote Main',
      tags: ['prod', 'shared'],
    });
    expect(added.created).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, '.workgraph/federation.yaml'))).toBe(true);

    const remotes = federation.listRemoteWorkspaces(workspacePath);
    expect(remotes).toHaveLength(1);
    expect(remotes[0].id).toBe('remote-main');
    expect(remotes[0].name).toBe('Remote Main');
    expect(remotes[0].tags).toEqual(['prod', 'shared']);

    const removed = federation.removeRemoteWorkspace(workspacePath, 'remote-main');
    expect(removed.changed).toBe(true);
    expect(removed.removed?.id).toBe('remote-main');
    expect(federation.listRemoteWorkspaces(workspacePath)).toHaveLength(0);
  });
});

describe('thread federation links', () => {
  it('links a local thread to a remote thread idempotently', () => {
    createThread(workspacePath, 'Local Thread', 'Coordinate cross-workspace handoff', 'agent-local');
    createThread(remoteWorkspacePath, 'Remote Thread', 'Remote dependency', 'agent-remote');
    federation.addRemoteWorkspace(workspacePath, {
      id: 'remote-main',
      path: remoteWorkspacePath,
      name: 'Remote Main',
    });

    const first = federation.linkThreadToRemoteWorkspace(
      workspacePath,
      'threads/local-thread.md',
      'remote-main',
      'threads/remote-thread.md',
      'agent-local',
    );
    expect(first.created).toBe(true);
    expect(first.link).toBe('federation://remote-main/threads/remote-thread.md');
    expect(readStringList(first.thread.fields.federation_links)).toContain(first.link);
    expect(first.thread.body).toContain('## Federated links');

    const second = federation.linkThreadToRemoteWorkspace(
      workspacePath,
      'threads/local-thread.md',
      'remote-main',
      'threads/remote-thread.md',
      'agent-local',
    );
    expect(second.created).toBe(false);
    expect(readStringList(second.thread.fields.federation_links)).toEqual([
      'federation://remote-main/threads/remote-thread.md',
    ]);
  });
});

describe('federated search', () => {
  it('returns local and remote matches', () => {
    createThread(workspacePath, 'Auth rollout', 'Coordinate auth migration', 'agent-local');
    createThread(remoteWorkspacePath, 'Auth dashboard', 'Build dashboard for auth metrics', 'agent-remote');
    federation.addRemoteWorkspace(workspacePath, {
      id: 'remote-main',
      path: remoteWorkspacePath,
    });

    const result = federation.searchFederated(workspacePath, 'auth', {
      type: 'thread',
    });
    expect(result.errors).toEqual([]);
    expect(result.results.some((entry) => entry.workspaceId === 'local')).toBe(true);
    expect(result.results.some((entry) => entry.workspaceId === 'remote-main')).toBe(true);
  });
});

describe('federation sync', () => {
  it('captures per-remote sync status and updates sync timestamps', () => {
    createThread(remoteWorkspacePath, 'Remote queue item', 'Process the remote queue', 'agent-remote');
    federation.addRemoteWorkspace(workspacePath, {
      id: 'remote-main',
      path: remoteWorkspacePath,
    });
    federation.addRemoteWorkspace(workspacePath, {
      id: 'missing-remote',
      path: path.join(remoteWorkspacePath, 'missing'),
    });

    const syncResult = federation.syncFederation(workspacePath, 'sync-agent');
    expect(syncResult.actor).toBe('sync-agent');
    expect(syncResult.remotes).toHaveLength(2);

    const remoteOk = syncResult.remotes.find((entry) => entry.id === 'remote-main');
    expect(remoteOk?.status).toBe('synced');
    expect(remoteOk?.threadCount).toBe(1);

    const remoteMissing = syncResult.remotes.find((entry) => entry.id === 'missing-remote');
    expect(remoteMissing?.status).toBe('error');
    expect(remoteMissing?.error).toContain('not found');

    const refreshed = federation.listRemoteWorkspaces(workspacePath);
    const refreshedRemote = refreshed.find((entry) => entry.id === 'remote-main');
    expect(typeof refreshedRemote?.lastSyncedAt).toBe('string');
    expect(refreshedRemote?.lastSyncStatus).toBe('synced');
  });
});

function createWorkspace(prefix: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const registry = loadRegistry(target);
  saveRegistry(target, registry);
  return target;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry));
}
