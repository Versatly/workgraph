import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadRegistry, saveRegistry } from './registry.js';
import * as agent from './agent.js';
import { getParty } from './policy.js';
import * as store from './store.js';
import { initWorkspace } from './workspace.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-agent-'));
  const reg = loadRegistry(workspacePath);
  saveRegistry(workspacePath, reg);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('agent presence', () => {
  it('creates a presence heartbeat primitive in agents/', () => {
    const presence = agent.heartbeat(workspacePath, 'agent-alpha', {
      actor: 'agent-alpha',
      status: 'busy',
      currentTask: 'threads/auth.md',
      capabilities: ['typescript', 'cli'],
    });

    expect(presence.path).toBe('agents/agent-alpha.md');
    expect(presence.type).toBe('presence');
    expect(presence.fields.name).toBe('agent-alpha');
    expect(presence.fields.status).toBe('busy');
    expect(presence.fields.current_task).toBe('threads/auth.md');
    expect(presence.fields.capabilities).toEqual(['typescript', 'cli']);
    expect(typeof presence.fields.last_seen).toBe('string');
  });

  it('updates heartbeat for existing agent and preserves prior capabilities by default', () => {
    const first = agent.heartbeat(workspacePath, 'agent-alpha', {
      actor: 'agent-alpha',
      status: 'online',
      capabilities: ['coordination'],
    });
    const second = agent.heartbeat(workspacePath, 'agent-alpha', {
      actor: 'agent-alpha',
      status: 'busy',
      currentTask: 'threads/incident.md',
    });

    expect(second.path).toBe(first.path);
    expect(second.fields.status).toBe('busy');
    expect(second.fields.current_task).toBe('threads/incident.md');
    expect(second.fields.capabilities).toEqual(['coordination']);

    const loaded = store.read(workspacePath, first.path);
    expect(loaded?.type).toBe('presence');
    expect(loaded?.fields.status).toBe('busy');
  });

  it('lists presence entries sorted by most recent heartbeat', async () => {
    const alpha = agent.heartbeat(workspacePath, 'agent-alpha', {
      actor: 'agent-alpha',
      status: 'online',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const beta = agent.heartbeat(workspacePath, 'agent-beta', {
      actor: 'agent-beta',
      status: 'offline',
    });

    const listed = agent.list(workspacePath);
    expect(listed).toHaveLength(2);
    expect(listed[0].path).toBe(beta.path);
    expect(listed[1].path).toBe(alpha.path);
  });

  it('registers first agent from bootstrap trust token and creates policy party', () => {
    const initResult = initWorkspace(workspacePath, { createReadme: false });

    const registration = agent.registerAgent(workspacePath, 'agent-alpha', {
      token: initResult.bootstrapTrustToken,
    });

    expect(registration.agentName).toBe('agent-alpha');
    expect(registration.role).toBe('admin');
    expect(registration.rolePath).toBe('roles/admin.md');
    expect(registration.trustTokenPath).toBe(initResult.bootstrapTrustTokenPath);
    expect(registration.trustTokenStatus).toBe('used');
    expect(registration.policyParty.id).toBe('agent-alpha');
    expect(registration.policyParty.roles).toEqual(['admin']);
    expect(registration.policyParty.capabilities).toContain('agent:register');
    expect(registration.presence.path).toBe('agents/agent-alpha.md');

    const persistedParty = getParty(workspacePath, 'agent-alpha');
    expect(persistedParty?.roles).toEqual(['admin']);
    expect(persistedParty?.capabilities).toContain('promote:sensitive');

    const trustToken = store.read(workspacePath, initResult.bootstrapTrustTokenPath);
    expect(trustToken).not.toBeNull();
    expect(trustToken?.fields.status).toBe('used');
    expect(trustToken?.fields.used_by).toEqual(['agent-alpha']);
    expect(trustToken?.fields.used_count).toBe(1);
  });

  it('allows idempotent re-registration for the same agent token holder', () => {
    const initResult = initWorkspace(workspacePath, { createReadme: false });

    const first = agent.registerAgent(workspacePath, 'agent-alpha', {
      token: initResult.bootstrapTrustToken,
    });
    const second = agent.registerAgent(workspacePath, 'agent-alpha', {
      token: initResult.bootstrapTrustToken,
    });

    expect(first.agentName).toBe('agent-alpha');
    expect(second.agentName).toBe('agent-alpha');
    const trustToken = store.read(workspacePath, initResult.bootstrapTrustTokenPath);
    expect(trustToken?.fields.used_by).toEqual(['agent-alpha']);
    expect(trustToken?.fields.used_count).toBe(1);
  });

  it('rejects registering a second distinct agent with single-use bootstrap token', () => {
    const initResult = initWorkspace(workspacePath, { createReadme: false });

    agent.registerAgent(workspacePath, 'agent-alpha', {
      token: initResult.bootstrapTrustToken,
    });

    expect(() => agent.registerAgent(workspacePath, 'agent-beta', {
      token: initResult.bootstrapTrustToken,
    })).toThrow('already been used');
  });
});
