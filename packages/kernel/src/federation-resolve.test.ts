import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as federation from './federation.js';
import { loadRegistry, saveRegistry } from './registry.js';
import * as store from './store.js';
import { createThread } from './thread.js';

let workspacePath: string;
let remoteWorkspacePath: string;

beforeEach(() => {
  workspacePath = createWorkspace('wg-federation-resolve-');
  remoteWorkspacePath = createWorkspace('wg-federation-resolve-remote-');
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
  fs.rmSync(remoteWorkspacePath, { recursive: true, force: true });
});

describe('federation identity and resolution', () => {
  it('creates stable local workspace identity in federation config', () => {
    const config = federation.ensureFederationConfig(workspacePath);
    expect(config.workspace.workspaceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(config.workspace.protocolVersion).toBe('wg-federation/v1');
    expect(config.workspace.capabilities).toContain('resolve-ref');
    expect(config.workspace.trustLevel).toBe('local');
  });

  it('stores typed federated refs alongside legacy links and resolves them remotely', () => {
    createThread(workspacePath, 'Local Thread', 'Local handoff', 'agent-local');
    const remoteThread = createThread(remoteWorkspacePath, 'Remote Thread', 'Remote dependency', 'agent-remote');
    federation.ensureFederationConfig(remoteWorkspacePath);
    federation.addRemoteWorkspace(workspacePath, {
      id: 'remote-main',
      path: remoteWorkspacePath,
      name: 'Remote Main',
    });

    const linked = federation.linkThreadToRemoteWorkspace(
      workspacePath,
      'threads/local-thread.md',
      'remote-main',
      remoteThread.path,
      'agent-local',
    );
    expect(linked.ref.workspaceId).toBe(federation.ensureFederationConfig(remoteWorkspacePath).workspace.workspaceId);
    expect(linked.ref.primitiveType).toBe('thread');
    expect(linked.ref.primitiveSlug).toBe('remote-thread');
    expect(linked.ref.protocolVersion).toBe('wg-federation/v1');
    expect(readRefs(linked.thread.fields.federation_refs)).toHaveLength(1);

    const resolved = federation.resolveFederatedRef(workspacePath, linked.ref);
    expect(resolved.source).toBe('remote');
    expect(resolved.authority).toBe('remote');
    expect(resolved.instance.path).toBe(remoteThread.path);
  });

  it('prefers local authority when local and remote primitive slugs collide', () => {
    const localThread = createThread(workspacePath, 'Remote Thread', 'Local wins', 'agent-local');
    const remoteThread = createThread(remoteWorkspacePath, 'Remote Thread', 'Remote collides', 'agent-remote');
    federation.ensureFederationConfig(remoteWorkspacePath);
    federation.addRemoteWorkspace(workspacePath, {
      id: 'remote-main',
      path: remoteWorkspacePath,
    });

    const linked = federation.linkThreadToRemoteWorkspace(
      workspacePath,
      localThread.path,
      'remote-main',
      remoteThread.path,
      'agent-local',
    );
    const resolved = federation.resolveFederatedRef(workspacePath, linked.ref);
    expect(resolved.source).toBe('local');
    expect(resolved.authority).toBe('local');
    expect(resolved.instance.path).toBe(localThread.path);
    expect(resolved.warning).toContain('overrides remote authority');
  });

  it('fails clearly on protocol or capability mismatch and surfaces staleness', () => {
    const remoteThread = createThread(remoteWorkspacePath, 'Remote Capability', 'Remote capability target', 'agent-remote');
    federation.saveFederationConfig(remoteWorkspacePath, {
      version: 2,
      updatedAt: new Date().toISOString(),
      workspace: {
        workspaceId: 'remote-capability-test',
        protocolVersion: 'wg-federation/v999',
        capabilities: ['search'],
        trustLevel: 'read-only',
      },
      remotes: [],
    });
    federation.addRemoteWorkspace(workspacePath, {
      id: 'remote-main',
      path: remoteWorkspacePath,
    });

    expect(() => federation.resolveFederatedRef(
      workspacePath,
      {
        workspaceId: 'remote-capability-test',
        primitiveType: 'thread',
        primitiveSlug: 'remote-capability',
        primitivePath: remoteThread.path,
        protocolVersion: 'wg-federation/v999',
        transport: 'local-path',
        remoteAlias: 'remote-main',
      },
    )).toThrow('Protocol mismatch');

    federation.saveFederationConfig(remoteWorkspacePath, {
      version: 2,
      updatedAt: new Date().toISOString(),
      workspace: {
        workspaceId: 'remote-capability-test',
        protocolVersion: 'wg-federation/v1',
        capabilities: ['search'],
        trustLevel: 'read-only',
      },
      remotes: [],
    });
    expect(() => federation.resolveFederatedRef(
      workspacePath,
      {
        workspaceId: 'remote-capability-test',
        primitiveType: 'thread',
        primitiveSlug: 'remote-capability',
        primitivePath: remoteThread.path,
        protocolVersion: 'wg-federation/v1',
        transport: 'local-path',
        remoteAlias: 'remote-main',
      },
    )).toThrow('does not support federated ref resolution');

    federation.saveFederationConfig(remoteWorkspacePath, {
      version: 2,
      updatedAt: new Date().toISOString(),
      workspace: {
        workspaceId: 'remote-capability-test',
        protocolVersion: 'wg-federation/v1',
        capabilities: ['search', 'resolve-ref', 'read-thread'],
        trustLevel: 'read-only',
      },
      remotes: [],
    });
    federation.syncFederation(workspacePath, 'sync-agent');
    store.update(remoteWorkspacePath, remoteThread.path, { status: 'blocked' }, undefined, 'agent-remote');
    const resolved = federation.resolveFederatedRef(
      workspacePath,
      {
        workspaceId: 'remote-capability-test',
        primitiveType: 'thread',
        primitiveSlug: 'remote-capability',
        primitivePath: remoteThread.path,
        protocolVersion: 'wg-federation/v1',
        transport: 'local-path',
        remoteAlias: 'remote-main',
      },
    );
    expect(resolved.stale).toBe(true);
    expect(resolved.warning).toContain('stale');
  });
});

function createWorkspace(prefix: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const registry = loadRegistry(target);
  saveRegistry(target, registry);
  return target;
}

function readRefs(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    : [];
}
