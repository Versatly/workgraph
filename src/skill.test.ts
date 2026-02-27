import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadRegistry, saveRegistry } from './registry.js';
import { listSkills, loadSkill, promoteSkill, proposeSkill, writeSkill } from './skill.js';
import { read as readPrimitive } from './store.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-skill-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('skill primitive lifecycle', () => {
  it('writes and loads a skill primitive', () => {
    const created = writeSkill(
      workspacePath,
      'workgraph-manual',
      '# Workgraph Manual\n\nHow to operate the workgraph.',
      'agent-author',
      {
        owner: 'agent-author',
        version: '1.0.0',
        tags: ['coordination'],
      },
    );

    expect(created.type).toBe('skill');
    expect(created.path).toBe('skills/workgraph-manual.md');
    expect(created.fields.status).toBe('draft');

    const loaded = loadSkill(workspacePath, 'workgraph-manual');
    expect(loaded.path).toBe(created.path);
    expect(loaded.fields.owner).toBe('agent-author');
  });

  it('proposes a skill and creates a proposal thread when needed', () => {
    writeSkill(workspacePath, 'tailscale-shared-skill', '# skill body', 'agent-author');
    const proposed = proposeSkill(workspacePath, 'tailscale-shared-skill', 'agent-reviewer', {
      createThreadIfMissing: true,
      space: 'spaces/platform.md',
      reviewers: ['agent-reviewer', 'agent-lead'],
    });

    expect(proposed.fields.status).toBe('proposed');
    expect(String(proposed.fields.proposal_thread)).toContain('threads/review-skill-tailscale-shared-skill.md');
    expect(Array.isArray(proposed.fields.reviewers)).toBe(true);
    expect(proposed.fields.reviewers).toContain('agent-lead');

    const proposalThreadPath = String(proposed.fields.proposal_thread);
    const proposalThread = readPrimitive(workspacePath, proposalThreadPath);
    expect(proposalThread).not.toBeNull();
    expect(proposalThread?.fields.space).toBe('spaces/platform.md');
  });

  it('promotes a skill and bumps patch version by default', () => {
    writeSkill(workspacePath, 'routing-playbook', '# routing', 'agent-author', {
      version: '1.2.3',
      status: 'proposed',
    });

    const promoted = promoteSkill(workspacePath, 'routing-playbook', 'agent-lead');
    expect(promoted.fields.status).toBe('active');
    expect(promoted.fields.version).toBe('1.2.4');
    expect(promoted.fields.promoted_at).toBeDefined();
  });

  it('lists skills and filters by status', () => {
    writeSkill(workspacePath, 'skill-a', '# a', 'agent-author', { status: 'draft' });
    writeSkill(workspacePath, 'skill-b', '# b', 'agent-author', { status: 'active' });

    const all = listSkills(workspacePath);
    const active = listSkills(workspacePath, { status: 'active' });

    expect(all).toHaveLength(2);
    expect(active).toHaveLength(1);
    expect(active[0].fields.title).toBe('skill-b');
  });
});
