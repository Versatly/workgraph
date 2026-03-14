import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, saveRegistry } from './registry.js';
import * as orientation from './orientation.js';
import * as store from './store.js';
import * as thread from './thread.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-orientation-core-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('orientation core module', () => {
  it('produces status snapshot counts for thread states, claims, and primitive totals', () => {
    thread.createThread(workspacePath, 'Open task', 'Do open work', 'agent-seed');

    thread.createThread(workspacePath, 'Active task', 'Do active work', 'agent-seed');
    thread.claim(workspacePath, 'threads/active-task.md', 'agent-a');

    thread.createThread(workspacePath, 'Blocked task', 'Do blocked work', 'agent-seed');
    thread.claim(workspacePath, 'threads/blocked-task.md', 'agent-b');
    thread.block(
      workspacePath,
      'threads/blocked-task.md',
      'agent-b',
      'external/dependency',
      'Waiting for dependency',
    );

    thread.createThread(workspacePath, 'Done task', 'Do done work', 'agent-seed');
    thread.claim(workspacePath, 'threads/done-task.md', 'agent-c');
    thread.done(workspacePath, 'threads/done-task.md', 'agent-c', 'Completed https://github.com/versatly/workgraph/pull/21');

    thread.createThread(workspacePath, 'Cancelled task', 'No longer needed', 'agent-seed');
    thread.cancel(workspacePath, 'threads/cancelled-task.md', 'agent-seed', 'Out of scope');

    const snapshot = orientation.statusSnapshot(workspacePath);
    expect(snapshot.threads.total).toBe(5);
    expect(snapshot.threads.open).toBe(1);
    expect(snapshot.threads.active).toBe(1);
    expect(snapshot.threads.blocked).toBe(1);
    expect(snapshot.threads.done).toBe(1);
    expect(snapshot.threads.cancelled).toBe(1);
    expect(snapshot.threads.ready).toBe(1);
    expect(snapshot.claims.active).toBe(2);
    expect(snapshot.primitives.byType.thread).toBe(5);
  });

  it('builds actor brief with bounded recent activity and next-ready lists', () => {
    thread.createThread(workspacePath, 'Mine', 'Owned by actor', 'agent-seed');
    thread.claim(workspacePath, 'threads/mine.md', 'agent-focus');
    thread.createThread(workspacePath, 'Another ready', 'Ready queue item', 'agent-seed');
    thread.createThread(workspacePath, 'Someone else', 'Other owner', 'agent-seed');
    thread.claim(workspacePath, 'threads/someone-else.md', 'agent-other');
    thread.block(workspacePath, 'threads/someone-else.md', 'agent-other', 'external/input');

    const brief = orientation.brief(workspacePath, 'agent-focus', {
      recentCount: 1,
      nextCount: 1,
    });

    expect(brief.actor).toBe('agent-focus');
    expect(brief.myClaims.map((entry) => entry.path)).toEqual(['threads/mine.md']);
    expect(brief.myOpenThreads.map((entry) => entry.path)).toEqual(['threads/mine.md']);
    expect(brief.blockedThreads.map((entry) => entry.path)).toContain('threads/someone-else.md');
    expect(brief.nextReadyThreads).toHaveLength(1);
    expect(brief.recentActivity).toHaveLength(1);
    expect(brief.companyContext.teams).toEqual([]);
    expect(brief.companyContext.clients).toEqual([]);
    expect(brief.companyContext.recentDecisions).toEqual([]);
    expect(brief.companyContext.patterns).toEqual([]);
  });

  it('creates checkpoint primitives with explicit next/blocked sections', () => {
    const checkpoint = orientation.checkpoint(
      workspacePath,
      'agent-handoff',
      'Finished parser baseline.',
      {
        next: ['Add schema validation', 'Wire retry policy'],
        blocked: ['Waiting for perf benchmark'],
        tags: ['handoff', 'iteration-2'],
      },
    );

    expect(checkpoint.type).toBe('checkpoint');
    expect(checkpoint.fields.actor).toBe('agent-handoff');
    expect(checkpoint.fields.summary).toBe('Finished parser baseline.');
    expect(checkpoint.fields.tags).toEqual(['handoff', 'iteration-2']);
    expect(checkpoint.body).toContain('## Next');
    expect(checkpoint.body).toContain('- Add schema validation');
    expect(checkpoint.body).toContain('## Blocked');
    expect(checkpoint.body).toContain('- Waiting for perf benchmark');
  });

  it('fills checkpoint next/blocked body with None defaults when omitted', () => {
    const checkpoint = orientation.checkpoint(
      workspacePath,
      'agent-defaults',
      'No extra details',
    );

    expect(checkpoint.body).toContain('## Next');
    expect(checkpoint.body).toContain('- None');
    expect(checkpoint.body).toContain('## Blocked');
  });

  it('creates intake checkpoints with mandatory intake tag', () => {
    const intake = orientation.intake(
      workspacePath,
      'agent-intake',
      'Observed recurring timeout on edge route',
      { tags: ['incident', 'customer'] },
    );

    expect(intake.type).toBe('checkpoint');
    expect(intake.fields.summary).toBe('Observed recurring timeout on edge route');
    expect(Array.isArray(intake.fields.tags)).toBe(true);
    expect((intake.fields.tags as string[])).toEqual(['intake', 'incident', 'customer']);
  });

  it('returns empty personal workload in brief when actor has no claims', () => {
    thread.createThread(workspacePath, 'Backlog only', 'No one claimed me yet', 'agent-seed');
    store.create(
      workspacePath,
      'decision',
      { title: 'Background decision', date: new Date().toISOString(), status: 'draft' },
      'Decision body',
      'agent-seed',
    );

    const brief = orientation.brief(workspacePath, 'agent-none');
    expect(brief.myClaims).toEqual([]);
    expect(brief.myOpenThreads).toEqual([]);
    expect(brief.nextReadyThreads.length).toBeGreaterThanOrEqual(1);
  });

  it('includes company context in actor brief', () => {
    const now = new Date().toISOString();
    store.create(
      workspacePath,
      'org',
      {
        title: 'Versatly',
        mission: 'Make autonomous coordination reliable.',
        strategy: 'Invest in company context graph primitives.',
      },
      'Org context',
      'agent-seed',
    );
    store.create(
      workspacePath,
      'team',
      {
        title: 'Platform',
        members: ['agent-focus', 'agent-other'],
        responsibilities: ['runtime', 'mcp'],
      },
      'Team context',
      'agent-seed',
    );
    store.create(
      workspacePath,
      'client',
      {
        name: 'Acme Corp',
        status: 'active',
        description: 'Strategic customer',
      },
      'Client context',
      'agent-seed',
    );
    store.create(
      workspacePath,
      'decision',
      {
        title: 'Adopt company context graph',
        date: now,
        status: 'approved',
        decided_by: 'agent-focus',
      },
      'Decision context',
      'agent-seed',
    );
    store.create(
      workspacePath,
      'pattern',
      {
        title: 'Weekly context sync',
        description: 'Capture and refresh context every Friday',
      },
      'Pattern context',
      'agent-seed',
    );
    store.create(
      workspacePath,
      'agent',
      {
        name: 'agent-focus',
        capabilities: ['briefing', 'coordination'],
        permissions: ['mcp:write'],
      },
      'Agent profile',
      'agent-seed',
    );

    const brief = orientation.brief(workspacePath, 'agent-focus');
    expect(brief.companyContext.org?.title).toBe('Versatly');
    expect(brief.companyContext.teams[0]?.title).toBe('Platform');
    expect(brief.companyContext.clients[0]?.title).toBe('Acme Corp');
    expect(brief.companyContext.recentDecisions[0]?.decidedBy).toBe('agent-focus');
    expect(brief.companyContext.patterns[0]?.title).toBe('Weekly context sync');
    expect(brief.companyContext.agentProfile?.name).toBe('agent-focus');
    expect(brief.companyContext.agentProfile?.permissions).toEqual(['mcp:write']);
  });
});
