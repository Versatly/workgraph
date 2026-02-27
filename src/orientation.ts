/**
 * Orientation helpers: status, brief, checkpoint/intake.
 */

import * as ledger from './ledger.js';
import * as query from './query.js';
import * as store from './store.js';
import * as thread from './thread.js';
import type { PrimitiveInstance, WorkgraphBrief, WorkgraphStatusSnapshot } from './types.js';

export function statusSnapshot(workspacePath: string): WorkgraphStatusSnapshot {
  const threads = store.list(workspacePath, 'thread');
  const allPrimitives = query.queryPrimitives(workspacePath);
  const byType = allPrimitives.reduce<Record<string, number>>((acc, instance) => {
    acc[instance.type] = (acc[instance.type] ?? 0) + 1;
    return acc;
  }, {});

  const claims = ledger.allClaims(workspacePath);
  const ready = thread.listReadyThreads(workspacePath);

  return {
    generatedAt: new Date().toISOString(),
    threads: {
      total: threads.length,
      open: threads.filter((item) => item.fields.status === 'open').length,
      active: threads.filter((item) => item.fields.status === 'active').length,
      blocked: threads.filter((item) => item.fields.status === 'blocked').length,
      done: threads.filter((item) => item.fields.status === 'done').length,
      cancelled: threads.filter((item) => item.fields.status === 'cancelled').length,
      ready: ready.length,
    },
    claims: {
      active: claims.size,
    },
    primitives: {
      total: allPrimitives.length,
      byType,
    },
  };
}

export function brief(workspacePath: string, actor: string, options: { recentCount?: number; nextCount?: number } = {}): WorkgraphBrief {
  const myClaims = [...ledger.allClaims(workspacePath).entries()]
    .filter(([, owner]) => owner === actor)
    .map(([target]) => store.read(workspacePath, target))
    .filter((instance): instance is PrimitiveInstance => instance !== null);

  const myOpenThreads = query.queryPrimitives(workspacePath, {
    type: 'thread',
    owner: actor,
  }).filter((instance) => ['open', 'active'].includes(String(instance.fields.status)));

  return {
    generatedAt: new Date().toISOString(),
    actor,
    myClaims,
    myOpenThreads,
    blockedThreads: store.blockedThreads(workspacePath),
    nextReadyThreads: thread.listReadyThreads(workspacePath).slice(0, options.nextCount ?? 5),
    recentActivity: ledger.recent(workspacePath, options.recentCount ?? 12),
  };
}

export function checkpoint(
  workspacePath: string,
  actor: string,
  summary: string,
  options: {
    next?: string[];
    blocked?: string[];
    tags?: string[];
  } = {},
): PrimitiveInstance {
  const title = `Checkpoint ${new Date().toISOString()}`;
  const bodyLines = [
    '## Summary',
    '',
    summary,
    '',
    '## Next',
    '',
    ...(options.next && options.next.length > 0 ? options.next.map((item) => `- ${item}`) : ['- None']),
    '',
    '## Blocked',
    '',
    ...(options.blocked && options.blocked.length > 0 ? options.blocked.map((item) => `- ${item}`) : ['- None']),
    '',
  ];
  return store.create(
    workspacePath,
    'checkpoint',
    {
      title,
      actor,
      summary,
      next: options.next ?? [],
      blocked: options.blocked ?? [],
      tags: options.tags ?? [],
    },
    bodyLines.join('\n'),
    actor,
  );
}

export function intake(
  workspacePath: string,
  actor: string,
  observation: string,
  options: {
    tags?: string[];
  } = {},
): PrimitiveInstance {
  return checkpoint(workspacePath, actor, observation, {
    tags: ['intake', ...(options.tags ?? [])],
  });
}
