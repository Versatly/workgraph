import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canTransitionStatus } from './gates.js';
import { getParty, loadPolicyRegistry, policyPath, upsertParty } from './registry.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-policy-package-'));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('packages/policy registry + gates', () => {
  it('seeds and persists policy registry inside workspace', () => {
    const registry = loadPolicyRegistry(workspacePath);
    expect(registry.version).toBe(1);
    expect(registry.parties.system).toBeDefined();
    expect(fs.existsSync(policyPath(workspacePath))).toBe(true);
  });

  it('upserts and reads party capabilities', () => {
    const party = upsertParty(workspacePath, 'agent-policy', {
      roles: ['operator'],
      capabilities: ['promote:sensitive'],
    });
    expect(party.id).toBe('agent-policy');
    expect(party.roles).toEqual(['operator']);
    expect(party.capabilities).toEqual(['promote:sensitive']);

    const fetched = getParty(workspacePath, 'agent-policy');
    expect(fetched?.id).toBe('agent-policy');
  });

  it('enforces sensitive transition capabilities', () => {
    const denied = canTransitionStatus(
      workspacePath,
      'agent-unregistered',
      'policy',
      'draft',
      'approved',
    );
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('not a registered party');

    upsertParty(workspacePath, 'agent-policy', {
      roles: ['operator'],
      capabilities: ['promote:sensitive'],
    });
    const allowed = canTransitionStatus(
      workspacePath,
      'agent-policy',
      'policy',
      'draft',
      'approved',
    );
    expect(allowed.allowed).toBe(true);
  });
});
