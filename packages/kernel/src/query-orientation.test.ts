import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadRegistry, saveRegistry } from './registry.js';
import * as thread from './thread.js';
import * as query from './query.js';
import * as orientation from './orientation.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-query-orientation-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('query and orientation', () => {
  it('queries primitives with filters and text search', () => {
    thread.createThread(workspacePath, 'Auth API rollout', 'Ship auth API', 'agent-a', {
      priority: 'high',
      tags: ['backend', 'auth'],
    });
    thread.createThread(workspacePath, 'Frontend polish', 'Improve dashboard UX', 'agent-a', {
      priority: 'low',
      tags: ['frontend'],
    });

    const auth = query.queryPrimitives(workspacePath, { type: 'thread', text: 'auth' });
    expect(auth).toHaveLength(1);
    expect(auth[0].path).toBe('threads/auth-api-rollout.md');

    const tagged = query.queryPrimitives(workspacePath, { type: 'thread', tag: 'frontend' });
    expect(tagged).toHaveLength(1);
    expect(tagged[0].path).toBe('threads/frontend-polish.md');
  });

  it('produces status/brief and creates checkpoints', () => {
    thread.createThread(workspacePath, 'Implement queue', 'Build queue service', 'agent-a');
    thread.createThread(workspacePath, 'Add retries', 'Add retry logic', 'agent-a');
    thread.claim(workspacePath, 'threads/add-retries.md', 'agent-b');

    const snapshot = orientation.statusSnapshot(workspacePath);
    expect(snapshot.threads.total).toBe(2);
    expect(snapshot.threads.active).toBe(1);
    expect(snapshot.claims.active).toBe(1);

    const brief = orientation.brief(workspacePath, 'agent-b');
    expect(brief.myClaims).toHaveLength(1);
    expect(brief.recentActivity.length).toBeGreaterThan(0);

    const checkpoint = orientation.checkpoint(
      workspacePath,
      'agent-b',
      'Queue worker baseline implemented.',
      { next: ['add dead letter queue'] },
    );
    expect(checkpoint.type).toBe('checkpoint');
    expect(checkpoint.fields.actor).toBe('agent-b');
  });
});
