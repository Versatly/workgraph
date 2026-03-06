import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addRemoteWorkspace,
  linkFederatedThread,
  listRemoteWorkspaces,
  readFederationLinkIndex,
  removeRemoteWorkspace,
  searchFederatedWorkspaces,
  syncRemoteWorkspace,
} from './federation.js';
import { loadRegistry, saveRegistry } from './registry.js';
import * as store from './store.js';
import * as thread from './thread.js';

let localWorkspacePath: string;
let remoteWorkspacePath: string;

beforeEach(() => {
  localWorkspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-fed-local-'));
  remoteWorkspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-fed-remote-'));
  const localRegistry = loadRegistry(localWorkspacePath);
  saveRegistry(localWorkspacePath, localRegistry);
  const remoteRegistry = loadRegistry(remoteWorkspacePath);
  saveRegistry(remoteWorkspacePath, remoteRegistry);
  writeWorkspaceConfig(localWorkspacePath, 'local');
  writeWorkspaceConfig(remoteWorkspacePath, 'remote');
});

afterEach(() => {
  fs.rmSync(localWorkspacePath, { recursive: true, force: true });
  fs.rmSync(remoteWorkspacePath, { recursive: true, force: true });
});

describe('federation config', () => {
  it('adds, lists, and removes known remote workspaces', () => {
    const added = addRemoteWorkspace(localWorkspacePath, 'Remote', remoteWorkspacePath);
    expect(added.created).toBe(true);
    expect(added.remote.name).toBe('remote');
    expect(added.remote.target).toBe(remoteWorkspacePath);
    expect(added.remote.readOnly).toBe(true);

    const listed = listRemoteWorkspaces(localWorkspacePath);
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe('remote');

    const removed = removeRemoteWorkspace(localWorkspacePath, 'remote');
    expect(removed.removed).toBe(true);
    expect(listRemoteWorkspaces(localWorkspacePath)).toHaveLength(0);
  });
});

describe('cross-workspace thread references', () => {
  it('links local threads to federated ids and stores backlink index entries', () => {
    thread.createThread(localWorkspacePath, 'Local Task', 'Coordinate with remote team', 'agent-local');
    thread.createThread(remoteWorkspacePath, 'Remote Task', 'Complete federated work', 'agent-remote');
    thread.createThread(
      remoteWorkspacePath,
      'Backref Task',
      'Depends on local:local-task before merge',
      'agent-remote',
      {
        deps: ['local:local-task'],
      },
    );
    addRemoteWorkspace(localWorkspacePath, 'remote', remoteWorkspacePath);

    const result = linkFederatedThread(
      localWorkspacePath,
      'local-task',
      'remote:remote-task',
      'agent-local',
    );

    expect(result.link.remoteFederatedId).toBe('remote:remote-task');
    expect(result.link.localFederatedId).toBe('local:local-task');
    expect(result.backlinksTracked).toBe(1);
    expect(result.link.backlinks).toContain('remote:backref-task');

    const updatedThread = store.read(localWorkspacePath, 'threads/local-task.md');
    expect(updatedThread?.fields.federated_refs).toContain('remote:remote-task');

    const index = readFederationLinkIndex(localWorkspacePath);
    expect(index.links).toHaveLength(1);
    expect(index.backlinks['remote:remote-task']).toContain('local:local-task');
  });

  it('syncs remote workspace state into federation cache snapshots', () => {
    thread.createThread(localWorkspacePath, 'Local Task', 'Coordinate with remote team', 'agent-local');
    thread.createThread(remoteWorkspacePath, 'Remote Task', 'Complete federated work', 'agent-remote');
    addRemoteWorkspace(localWorkspacePath, 'remote', remoteWorkspacePath);
    linkFederatedThread(
      localWorkspacePath,
      'threads/local-task.md',
      'remote:remote-task',
      'agent-local',
    );

    const synced = syncRemoteWorkspace(localWorkspacePath, 'remote');
    const cacheAbsPath = path.join(localWorkspacePath, synced.cachePath);
    expect(fs.existsSync(cacheAbsPath)).toBe(true);
    expect(synced.snapshot.threadCount).toBe(1);
    expect(synced.snapshot.remote).toBe('remote');
    expect(synced.backlinksRefreshed).toBe(1);

    const cached = JSON.parse(fs.readFileSync(cacheAbsPath, 'utf-8')) as {
      threadCount: number;
      remote: string;
    };
    expect(cached.threadCount).toBe(1);
    expect(cached.remote).toBe('remote');
  });

  it('searches across configured remote workspaces', () => {
    thread.createThread(remoteWorkspacePath, 'Remote Searchable', 'Contains federated-search-keyword', 'agent-remote');
    addRemoteWorkspace(localWorkspacePath, 'remote', remoteWorkspacePath);

    const results = searchFederatedWorkspaces(localWorkspacePath, 'federated-search-keyword');
    expect(results).toHaveLength(1);
    expect(results[0].workspace).toBe('remote');
    expect(results[0].results.map((item) => item.path)).toContain('threads/remote-searchable.md');
  });
});

function writeWorkspaceConfig(workspacePath: string, name: string): void {
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(workspacePath, '.workgraph.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      mode: 'workgraph',
      createdAt: now,
      updatedAt: now,
    }, null, 2) + '\n',
    'utf-8',
  );
}
