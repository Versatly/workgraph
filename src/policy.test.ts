import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canTransitionStatus,
  getParty,
  loadPolicyRegistry,
  policyPath,
  upsertParty,
} from './policy.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-policy-core-'));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('policy core module', () => {
  it('resolves policy file path under .workgraph', () => {
    const resolved = policyPath(workspacePath);
    expect(resolved).toBe(path.join(workspacePath, '.workgraph', 'policy.json'));
  });

  it('seeds policy registry on first load with system party', () => {
    const registry = loadPolicyRegistry(workspacePath);
    expect(registry.version).toBe(1);
    expect(registry.parties.system).toBeDefined();
    expect(registry.parties.system.capabilities).toContain('promote:sensitive');
    expect(fs.existsSync(policyPath(workspacePath))).toBe(true);
  });

  it('falls back to seeded registry when policy file is malformed', () => {
    const pPath = policyPath(workspacePath);
    fs.mkdirSync(path.dirname(pPath), { recursive: true });
    fs.writeFileSync(pPath, '{invalid-json', 'utf-8');

    const registry = loadPolicyRegistry(workspacePath);
    expect(registry.parties.system.id).toBe('system');
    expect(Object.keys(registry.parties)).toContain('system');
  });

  it('upserts parties and preserves createdAt on subsequent updates', () => {
    const created = upsertParty(workspacePath, 'agent-reviewer', {
      roles: ['reviewer'],
      capabilities: ['promote:decision'],
    });
    expect(created.id).toBe('agent-reviewer');
    expect(created.roles).toEqual(['reviewer']);

    const updated = upsertParty(workspacePath, 'agent-reviewer', {
      capabilities: ['promote:sensitive'],
    });
    expect(updated.id).toBe('agent-reviewer');
    expect(updated.roles).toEqual(['reviewer']);
    expect(updated.capabilities).toEqual(['promote:sensitive']);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.updatedAt));
  });

  it('returns null from getParty when actor is not registered', () => {
    expect(getParty(workspacePath, 'missing-actor')).toBeNull();
  });

  it('allows non-sensitive transitions and no-op transitions', () => {
    const threadDecision = canTransitionStatus(
      workspacePath,
      'anyone',
      'thread',
      'open',
      'active',
    );
    expect(threadDecision.allowed).toBe(true);

    const noOp = canTransitionStatus(
      workspacePath,
      'anyone',
      'decision',
      'draft',
      'draft',
    );
    expect(noOp.allowed).toBe(true);
  });

  it('blocks sensitive promotions for unregistered and underprivileged actors', () => {
    const unregistered = canTransitionStatus(
      workspacePath,
      'agent-plain',
      'decision',
      'draft',
      'approved',
    );
    expect(unregistered.allowed).toBe(false);
    expect(unregistered.reason).toContain('is not a registered party');

    upsertParty(workspacePath, 'agent-plain', {
      roles: ['contributor'],
      capabilities: ['read-only'],
    });
    const underprivileged = canTransitionStatus(
      workspacePath,
      'agent-plain',
      'decision',
      'draft',
      'approved',
    );
    expect(underprivileged.allowed).toBe(false);
    expect(underprivileged.reason).toContain('lacks required capabilities');
  });

  it('allows sensitive promotions for specific/global capabilities and system actor', () => {
    upsertParty(workspacePath, 'agent-specific', {
      roles: ['reviewer'],
      capabilities: ['promote:decision'],
    });
    const specific = canTransitionStatus(
      workspacePath,
      'agent-specific',
      'decision',
      'draft',
      'approved',
    );
    expect(specific.allowed).toBe(true);

    upsertParty(workspacePath, 'agent-global', {
      roles: ['admin'],
      capabilities: ['promote:sensitive'],
    });
    const global = canTransitionStatus(
      workspacePath,
      'agent-global',
      'incident',
      'draft',
      'active',
    );
    expect(global.allowed).toBe(true);

    const system = canTransitionStatus(
      workspacePath,
      'system',
      'policy',
      'proposed',
      'active',
    );
    expect(system.allowed).toBe(true);
  });
});
