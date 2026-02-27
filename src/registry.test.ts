import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadRegistry, saveRegistry, defineType, getType, listTypes, extendType, registryPath } from './registry.js';
import { readAll } from './ledger.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-registry-'));
  fs.mkdirSync(path.join(workspacePath, '.clawvault'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('registry', () => {
  it('seeds built-in types on first load', () => {
    const reg = loadRegistry(workspacePath);
    expect(reg.types.thread).toBeDefined();
    expect(reg.types.space).toBeDefined();
    expect(reg.types.decision).toBeDefined();
    expect(reg.types.lesson).toBeDefined();
    expect(reg.types.fact).toBeDefined();
    expect(reg.types.agent).toBeDefined();
    expect(reg.types.skill).toBeDefined();
    expect(reg.types.thread.builtIn).toBe(true);
  });

  it('persists registry to disk', () => {
    const reg = loadRegistry(workspacePath);
    saveRegistry(workspacePath, reg);
    expect(fs.existsSync(registryPath(workspacePath))).toBe(true);

    const loaded = loadRegistry(workspacePath);
    expect(loaded.types.thread.name).toBe('thread');
  });

  it('defines a new primitive type at runtime', () => {
    defineType(workspacePath, 'workflow', 'A sequence of staged work', {
      stages: { type: 'list', required: true, description: 'Ordered stage names' },
      current_stage: { type: 'string', default: '' },
      assigned_agents: { type: 'list', default: [] },
    }, 'agent-alpha');

    const wf = getType(workspacePath, 'workflow');
    expect(wf).toBeDefined();
    expect(wf!.name).toBe('workflow');
    expect(wf!.builtIn).toBe(false);
    expect(wf!.createdBy).toBe('agent-alpha');
    expect(wf!.fields.stages.type).toBe('list');
    expect(wf!.fields.title).toBeDefined();
    expect(wf!.fields.created).toBeDefined();
    expect(wf!.directory).toBe('workflows');

    const defineEntries = readAll(workspacePath).filter(e => e.op === 'define');
    expect(defineEntries).toHaveLength(1);
    expect(defineEntries[0].actor).toBe('agent-alpha');
    expect(defineEntries[0].target).toBe('.clawvault/registry.json');
    expect(defineEntries[0].type).toBe('workflow');
  });

  it('refuses to redefine built-in types', () => {
    expect(() => defineType(workspacePath, 'thread', 'override', {}, 'bad-actor'))
      .toThrow('Cannot redefine built-in type');
  });

  it('extends existing types with new fields', () => {
    const before = getType(workspacePath, 'thread');
    expect(before!.fields.estimated_hours).toBeUndefined();

    extendType(workspacePath, 'thread', {
      estimated_hours: { type: 'number', description: 'Time estimate' },
    }, 'agent-beta');

    const after = getType(workspacePath, 'thread');
    expect(after!.fields.estimated_hours).toBeDefined();
    expect(after!.fields.estimated_hours.type).toBe('number');
  });

  it('lists all types including custom ones', () => {
    defineType(workspacePath, 'review-gate', 'Approval checkpoint', {
      approver: { type: 'string', required: true },
      approved: { type: 'boolean', default: false },
    }, 'agent-gamma');

    const types = listTypes(workspacePath);
    const names = types.map(t => t.name);
    expect(names).toContain('thread');
    expect(names).toContain('review-gate');
  });

  it('sanitizes type names', () => {
    defineType(workspacePath, 'My Custom Type!', 'test', {}, 'agent');
    const t = getType(workspacePath, 'my-custom-type-');
    expect(t).toBeDefined();
  });

  it('ensures built-ins survive registry reload', () => {
    const reg = loadRegistry(workspacePath);
    delete reg.types.thread;
    saveRegistry(workspacePath, reg);

    const reloaded = loadRegistry(workspacePath);
    expect(reloaded.types.thread).toBeDefined();
  });
});
