import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { create, read, list, update, remove, findByField, openThreads, threadsInSpace } from './store.js';
import { defineType, loadRegistry, saveRegistry } from './registry.js';
import * as ledger from './ledger.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-store-'));
  const reg = loadRegistry(workspacePath);
  saveRegistry(workspacePath, reg);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('store', () => {
  it('creates a primitive instance and writes markdown', () => {
    const inst = create(workspacePath, 'thread', {
      title: 'Build Auth System',
      goal: 'Implement JWT auth',
    }, '## Goal\n\nImplement JWT auth\n', 'agent-alpha');

    expect(inst.path).toBe('threads/build-auth-system.md');
    expect(inst.fields.title).toBe('Build Auth System');
    expect(inst.fields.status).toBe('open');
    expect(inst.fields.deps).toEqual([]);

    const absPath = path.join(workspacePath, inst.path);
    expect(fs.existsSync(absPath)).toBe(true);
  });

  it('reads a primitive back from disk', () => {
    create(workspacePath, 'thread', {
      title: 'Auth Thread',
      goal: 'Build auth',
    }, 'Body content', 'agent-alpha');

    const inst = read(workspacePath, 'threads/auth-thread.md');
    expect(inst).not.toBeNull();
    expect(inst!.fields.title).toBe('Auth Thread');
    expect(inst!.body).toBe('Body content');
    expect(inst!.type).toBe('thread');
  });

  it('lists all instances of a type', () => {
    create(workspacePath, 'thread', { title: 'Thread A', goal: 'A' }, '', 'agent');
    create(workspacePath, 'thread', { title: 'Thread B', goal: 'B' }, '', 'agent');
    create(workspacePath, 'decision', { title: 'Decision X', date: '2026-02-01' }, '', 'agent');

    const threads = list(workspacePath, 'thread');
    expect(threads).toHaveLength(2);

    const decisions = list(workspacePath, 'decision');
    expect(decisions).toHaveLength(1);
  });

  it('updates a primitive', () => {
    create(workspacePath, 'thread', { title: 'Update Me', goal: 'test' }, 'old body', 'agent');

    const updated = update(workspacePath, 'threads/update-me.md', {
      status: 'active',
      owner: 'agent-beta',
    }, 'new body', 'agent-beta');

    expect(updated.fields.status).toBe('active');
    expect(updated.fields.owner).toBe('agent-beta');
    expect(updated.body).toBe('new body');
  });

  it('soft-deletes (archives) a primitive', () => {
    create(workspacePath, 'thread', { title: 'Delete Me', goal: 'test' }, '', 'agent');
    remove(workspacePath, 'threads/delete-me.md', 'agent');

    expect(read(workspacePath, 'threads/delete-me.md')).toBeNull();
    expect(fs.existsSync(path.join(workspacePath, '.clawvault/archive/delete-me.md'))).toBe(true);
  });

  it('applies field defaults from type definition', () => {
    const inst = create(workspacePath, 'thread', {
      title: 'Defaults Test',
      goal: 'test defaults',
    }, '', 'agent');

    expect(inst.fields.status).toBe('open');
    expect(inst.fields.priority).toBe('medium');
    expect(inst.fields.deps).toEqual([]);
    expect(inst.fields.tags).toEqual([]);
  });

  it('logs all mutations to the ledger', () => {
    create(workspacePath, 'thread', { title: 'Logged', goal: 'test' }, '', 'agent-a');
    update(workspacePath, 'threads/logged.md', { priority: 'high' }, undefined, 'agent-a');

    const entries = ledger.readAll(workspacePath);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[0].op).toBe('create');
    expect(entries[1].op).toBe('update');
  });

  it('throws on unknown type', () => {
    expect(() => create(workspacePath, 'nonexistent', { title: 'X' }, '', 'agent'))
      .toThrow('Unknown primitive type');
  });

  it('throws on duplicate file', () => {
    create(workspacePath, 'thread', { title: 'Dupe', goal: 'test' }, '', 'agent');
    expect(() => create(workspacePath, 'thread', { title: 'Dupe', goal: 'test2' }, '', 'agent'))
      .toThrow('already exists');
  });

  it('validates required fields on create', () => {
    expect(() => create(workspacePath, 'thread', { title: 'Missing goal' }, '', 'agent'))
      .toThrow('Missing required field "goal"');
  });

  it('validates field types on update while keeping soft schemas', () => {
    create(workspacePath, 'thread', { title: 'Typed Update', goal: 'g' }, '', 'agent');
    expect(() => update(
      workspacePath,
      'threads/typed-update.md',
      { deps: 'threads/other.md' },
      undefined,
      'agent',
    )).toThrow('expected list');

    const updated = update(
      workspacePath,
      'threads/typed-update.md',
      { custom_runtime_hint: { lane: 'api' } },
      undefined,
      'agent',
    );
    expect(updated.fields.custom_runtime_hint).toEqual({ lane: 'api' });
  });

  it('works with agent-defined types', () => {
    defineType(workspacePath, 'playbook', 'Reusable workflow template', {
      stages: { type: 'list', default: [] },
      owner: { type: 'string' },
    }, 'agent-builder');

    const inst = create(workspacePath, 'playbook', {
      title: 'Incident Response',
      stages: ['triage', 'investigate', 'mitigate', 'postmortem'],
      owner: 'sre-team',
    }, '# Incident Response Playbook\n', 'agent-builder');

    expect(inst.path).toBe('playbooks/incident-response.md');
    expect(inst.fields.stages).toEqual(['triage', 'investigate', 'mitigate', 'postmortem']);

    const loaded = read(workspacePath, 'playbooks/incident-response.md');
    expect(loaded!.fields.stages).toEqual(['triage', 'investigate', 'mitigate', 'postmortem']);
  });

  it('finds instances by field value', () => {
    create(workspacePath, 'thread', { title: 'T1', goal: 'g1', priority: 'high' }, '', 'a');
    create(workspacePath, 'thread', { title: 'T2', goal: 'g2', priority: 'low' }, '', 'a');
    create(workspacePath, 'thread', { title: 'T3', goal: 'g3', priority: 'high' }, '', 'a');

    const highPriority = findByField(workspacePath, 'thread', 'priority', 'high');
    expect(highPriority).toHaveLength(2);
  });

  it('finds open threads', () => {
    create(workspacePath, 'thread', { title: 'Open 1', goal: 'g' }, '', 'a');
    create(workspacePath, 'thread', { title: 'Open 2', goal: 'g' }, '', 'a');
    create(workspacePath, 'thread', { title: 'Active', goal: 'g', status: 'active' }, '', 'a');

    const open = openThreads(workspacePath);
    expect(open).toHaveLength(2);
  });

  it('filters threads by space reference', () => {
    create(workspacePath, 'thread', { title: 'Backend 1', goal: 'g', space: 'spaces/backend.md' }, '', 'a');
    create(workspacePath, 'thread', { title: 'Backend 2', goal: 'g', space: '[[spaces/backend.md]]' }, '', 'a');
    create(workspacePath, 'thread', { title: 'Frontend', goal: 'g', space: 'spaces/frontend.md' }, '', 'a');

    const backendThreads = threadsInSpace(workspacePath, 'spaces/backend');
    expect(backendThreads).toHaveLength(2);
    expect(backendThreads.map(t => t.path).sort()).toEqual([
      'threads/backend-1.md',
      'threads/backend-2.md',
    ]);
  });
});
