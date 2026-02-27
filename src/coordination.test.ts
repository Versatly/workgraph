/**
 * Multi-agent coordination test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadRegistry, saveRegistry, defineType, listTypes } from './registry.js';
import * as ledger from './ledger.js';
import * as store from './store.js';
import * as thread from './thread.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-coord-'));
  const reg = loadRegistry(workspacePath);
  saveRegistry(workspacePath, reg);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('multi-agent coordination', () => {
  it('two agents coordinate on a decomposed task with custom primitives', () => {
    const LEAD = 'agent-lead';
    const WORKER = 'agent-worker';

    const milestoneDef = defineType(workspacePath, 'milestone', 'A project checkpoint with deliverables', {
      deliverables: { type: 'list', default: [], description: 'Expected outputs' },
      thread_refs: { type: 'list', default: [], description: 'Threads that contribute to this milestone' },
      target_date: { type: 'date', description: 'When this milestone should be hit' },
      status: { type: 'string', default: 'pending', description: 'pending | achieved | missed' },
    }, LEAD);

    expect(milestoneDef.name).toBe('milestone');
    expect(milestoneDef.builtIn).toBe(false);
    expect(milestoneDef.createdBy).toBe(LEAD);

    const types = listTypes(workspacePath);
    expect(types.map(t => t.name)).toContain('milestone');

    const parentThread = thread.createThread(workspacePath,
      'Build User Auth System', 'Complete JWT-based auth with refresh tokens', LEAD,
      { priority: 'high', tags: ['auth', 'backend'] });

    expect(parentThread.fields.status).toBe('open');

    const children = thread.decompose(workspacePath, parentThread.path, [
      { title: 'Design DB Schema', goal: 'Create user and session tables' },
      { title: 'Implement JWT Service', goal: 'Token generation, validation, refresh', deps: ['threads/design-db-schema.md'] },
      { title: 'Add Auth Middleware', goal: 'Express middleware for protected routes', deps: ['threads/implement-jwt-service.md'] },
    ], LEAD);

    expect(children).toHaveLength(3);
    expect(children[1].fields.deps).toContain('threads/design-db-schema.md');

    const m1 = store.create(workspacePath, 'milestone', {
      title: 'Auth MVP',
      deliverables: ['JWT tokens working', 'Protected routes', 'Refresh flow'],
      thread_refs: children.map(c => c.path),
      target_date: '2026-03-15',
    }, '# Auth MVP Milestone\n\nAll auth components shipped and tested.', LEAD);

    expect(m1.path).toBe('milestones/auth-mvp.md');

    const open = store.openThreads(workspacePath);
    expect(open.length).toBeGreaterThanOrEqual(3);

    const dbSchema = open.find(t => String(t.fields.title).includes('DB Schema'));
    expect(dbSchema).toBeDefined();

    thread.claim(workspacePath, dbSchema!.path, WORKER);
    expect(ledger.currentOwner(workspacePath, dbSchema!.path)).toBe(WORKER);

    expect(() => thread.claim(workspacePath, dbSchema!.path, LEAD))
      .toThrow('Cannot claim');

    thread.done(workspacePath, dbSchema!.path, WORKER,
      'Created users and sessions tables with indices. Schema in migrations/001_auth.sql.');

    const completed = store.read(workspacePath, dbSchema!.path);
    expect(completed!.fields.status).toBe('done');
    expect(completed!.body).toContain('migrations/001_auth.sql');

    const jwtThread = children.find(c => String(c.fields.title).includes('JWT'));
    thread.claim(workspacePath, jwtThread!.path, WORKER);
    thread.block(workspacePath, jwtThread!.path, WORKER, 'external/key-management', 'Need KMS access');

    const blockedThreads = store.blockedThreads(workspacePath);
    expect(blockedThreads).toHaveLength(1);

    thread.unblock(workspacePath, jwtThread!.path, LEAD);
    thread.done(workspacePath, jwtThread!.path, WORKER, 'JWT service with RS256 signing, 15min access, 7d refresh.');

    const allEntries = ledger.readAll(workspacePath);
    expect(allEntries.length).toBeGreaterThan(10);

    const claimEntries = allEntries.filter(e => e.op === 'claim');
    expect(claimEntries).toHaveLength(2);
    expect(claimEntries.every(e => e.actor === WORKER)).toBe(true);

    const doneEntries = allEntries.filter(e => e.op === 'done');
    expect(doneEntries).toHaveLength(2);

    const blockEntries = allEntries.filter(e => e.op === 'block');
    expect(blockEntries).toHaveLength(1);
    expect(blockEntries[0].data?.blocked_by).toBe('external/key-management');

    const milestoneInst = store.read(workspacePath, m1.path);
    expect(milestoneInst).not.toBeNull();
    expect(milestoneInst!.fields.thread_refs).toHaveLength(3);

    const leadActivity = ledger.activityOf(workspacePath, LEAD);
    const workerActivity = ledger.activityOf(workspacePath, WORKER);
    expect(leadActivity.length).toBeGreaterThan(0);
    expect(workerActivity.length).toBeGreaterThan(0);
    expect(leadActivity.some(e => e.op === 'decompose')).toBe(true);
    expect(leadActivity.some(e => e.op === 'unblock')).toBe(true);
    expect(workerActivity.some(e => e.op === 'claim')).toBe(true);
    expect(workerActivity.some(e => e.op === 'done')).toBe(true);
    expect(workerActivity.some(e => e.op === 'block')).toBe(true);
  });

  it('compounding abstraction: agent builds on another agent primitive', () => {
    const ARCHITECT = 'agent-architect';
    const BUILDER = 'agent-builder';
    const PM = 'agent-pm';

    defineType(workspacePath, 'component', 'A software component with API surface', {
      language: { type: 'string' },
      api_surface: { type: 'list', default: [] },
      depends_on: { type: 'list', default: [] },
    }, ARCHITECT);

    defineType(workspacePath, 'test-plan', 'Test strategy for a component', {
      component_ref: { type: 'ref', required: true },
      coverage_target: { type: 'number', default: 80 },
      test_types: { type: 'list', default: ['unit', 'integration'] },
    }, BUILDER);

    defineType(workspacePath, 'release', 'A release bundle', {
      version: { type: 'string', required: true },
      component_refs: { type: 'list', default: [] },
      test_plan_refs: { type: 'list', default: [] },
      go_no_go: { type: 'string', default: 'pending' },
    }, PM);

    const comp = store.create(workspacePath, 'component', {
      title: 'Auth Service',
      language: 'typescript',
      api_surface: ['POST /login', 'POST /refresh', 'DELETE /logout'],
    }, '# Auth Service Component', ARCHITECT);

    const testPlan = store.create(workspacePath, 'test-plan', {
      title: 'Auth Service Tests',
      component_ref: comp.path,
      coverage_target: 90,
      test_types: ['unit', 'integration', 'e2e'],
    }, '# Auth Test Plan', BUILDER);

    const rel = store.create(workspacePath, 'release', {
      title: 'v2.0.0 Release',
      version: '2.0.0',
      component_refs: [comp.path],
      test_plan_refs: [testPlan.path],
    }, '# Release v2.0.0', PM);

    expect(store.list(workspacePath, 'component')).toHaveLength(1);
    expect(store.list(workspacePath, 'test-plan')).toHaveLength(1);
    expect(store.list(workspacePath, 'release')).toHaveLength(1);

    const loadedRel = store.read(workspacePath, rel.path);
    expect(loadedRel!.fields.component_refs).toContain(comp.path);
    expect(loadedRel!.fields.test_plan_refs).toContain(testPlan.path);

    const allTypes = listTypes(workspacePath);
    const customTypes = allTypes.filter(t => !t.builtIn);
    expect(customTypes).toHaveLength(3);
    expect(customTypes.map(t => t.createdBy).sort()).toEqual([ARCHITECT, BUILDER, PM].sort());

    const defineEntries = ledger.readAll(workspacePath).filter(e => e.op === 'define');
    expect(defineEntries).toHaveLength(3);
    expect(new Set(defineEntries.map(e => e.type))).toEqual(new Set(['component', 'test-plan', 'release']));
    const createEntries = ledger.readAll(workspacePath).filter(e => e.op === 'create');
    expect(createEntries).toHaveLength(3);
    expect(new Set(createEntries.map(e => e.type))).toEqual(new Set(['component', 'test-plan', 'release']));
  });
});
