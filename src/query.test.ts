import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, saveRegistry } from './registry.js';
import * as query from './query.js';
import * as store from './store.js';
import * as thread from './thread.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-query-core-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('query core module', () => {
  it('filters by type/status/owner/tag combinations', () => {
    thread.createThread(workspacePath, 'Backend migration', 'Move DB', 'agent-seed', {
      tags: ['backend', 'db'],
    });
    thread.claim(workspacePath, 'threads/backend-migration.md', 'agent-a');
    thread.createThread(workspacePath, 'Frontend polish', 'Improve UX', 'agent-seed', {
      tags: ['frontend'],
    });

    const matches = query.queryPrimitives(workspacePath, {
      type: 'thread',
      status: 'active',
      owner: 'agent-a',
      tag: 'backend',
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].path).toBe('threads/backend-migration.md');
  });

  it('searches text case-insensitively across fields and body', () => {
    store.create(
      workspacePath,
      'decision',
      {
        title: 'Adopt risk register',
        date: new Date().toISOString(),
        status: 'draft',
        tags: ['planning'],
      },
      'The RISK register drives weekly review.',
      'agent-docs',
    );

    const textHits = query.queryPrimitives(workspacePath, { text: 'risk REGISTER' });
    expect(textHits.map((instance) => instance.path)).toContain('decisions/adopt-risk-register.md');
  });

  it('supports pathIncludes filtering and unknown type queries', () => {
    store.create(
      workspacePath,
      'decision',
      { title: 'Keep changelog', date: new Date().toISOString(), status: 'draft' },
      'Track key platform changes.',
      'agent-docs',
    );
    thread.createThread(workspacePath, 'Ship changelog bot', 'Automate posting', 'agent-dev');

    const pathMatches = query.queryPrimitives(workspacePath, {
      pathIncludes: 'decisions/',
    });
    expect(pathMatches).toHaveLength(1);
    expect(pathMatches[0].type).toBe('decision');

    expect(query.queryPrimitives(workspacePath, { type: 'not-a-type' })).toEqual([]);
  });

  it('applies created/updated date windows and rejects invalid thresholds', () => {
    const seeded = store.create(
      workspacePath,
      'thread',
      {
        title: 'Historical thread',
        goal: 'Carry history forward',
        created: '2020-01-01T00:00:00.000Z',
      },
      'Created years ago but updated now.',
      'agent-a',
    );
    expect(seeded.path).toBe('threads/historical-thread.md');

    expect(
      query.queryPrimitives(workspacePath, {
        type: 'thread',
        createdBefore: '2021-01-01T00:00:00.000Z',
      }),
    ).toHaveLength(1);

    expect(
      query.queryPrimitives(workspacePath, {
        type: 'thread',
        createdAfter: '2021-01-01T00:00:00.000Z',
      }),
    ).toHaveLength(0);

    expect(
      query.queryPrimitives(workspacePath, {
        type: 'thread',
        updatedBefore: '2999-01-01T00:00:00.000Z',
      }),
    ).toHaveLength(1);

    expect(
      query.queryPrimitives(workspacePath, {
        type: 'thread',
        updatedAfter: 'not-a-date',
      }),
    ).toHaveLength(0);
  });

  it('supports limit/offset pagination including negative offset clamping', () => {
    for (let idx = 0; idx < 4; idx++) {
      thread.createThread(workspacePath, `Task ${idx + 1}`, `Goal ${idx + 1}`, 'agent-seed');
    }

    const paged = query.queryPrimitives(workspacePath, {
      type: 'thread',
      offset: 1,
      limit: 2,
    });
    expect(paged).toHaveLength(2);

    const clamped = query.queryPrimitives(workspacePath, {
      type: 'thread',
      offset: -100,
    });
    expect(clamped).toHaveLength(4);

    const emptyPage = query.queryPrimitives(workspacePath, {
      type: 'thread',
      offset: 999,
      limit: 10,
    });
    expect(emptyPage).toEqual([]);
  });

  it('keywordSearch delegates to text search and accepts additional filters', () => {
    thread.createThread(workspacePath, 'Deploy API', 'Ship deploy pipeline', 'agent-dev');
    store.create(
      workspacePath,
      'decision',
      { title: 'Deploy cadence', date: new Date().toISOString(), status: 'draft' },
      'Weekly deploy trains.',
      'agent-docs',
    );

    const matches = query.keywordSearch(workspacePath, 'deploy', { type: 'thread' });
    expect(matches).toHaveLength(1);
    expect(matches[0].path).toBe('threads/deploy-api.md');
  });
});
