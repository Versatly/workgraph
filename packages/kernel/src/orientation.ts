/**
 * Orientation helpers: status, brief, checkpoint/intake.
 */

import * as ledger from './ledger.js';
import * as query from './query.js';
import * as store from './store.js';
import * as thread from './thread.js';
import type {
  CompanyContext,
  PrimitiveInstance,
  WorkgraphBrief,
  WorkgraphStatusSnapshot,
} from './types.js';

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
    companyContext: companyContext(workspacePath, actor),
  };
}

export function companyContext(workspacePath: string, actor: string): CompanyContext {
  const orgs = query.queryPrimitives(workspacePath, { type: 'org' });
  const teams = query.queryPrimitives(workspacePath, { type: 'team' });
  const clients = query.queryPrimitives(workspacePath, { type: 'client' });
  const decisions = query.queryPrimitives(workspacePath, { type: 'decision' });
  const patterns = query.queryPrimitives(workspacePath, { type: 'pattern' });
  const agents = query.queryPrimitives(workspacePath, { type: 'agent' });

  const primaryOrg = orgs
    .slice()
    .sort((left, right) => compareByRecency(left, right, ['updated', 'created']))
    .at(0);
  const actorAgent = agents.find((instance) => normalizeText(instance.fields.name) === actor);

  return {
    ...(primaryOrg
      ? {
          org: {
            title: normalizeText(primaryOrg.fields.title) ?? 'Organization',
            ...(normalizeText(primaryOrg.fields.mission)
              ? { mission: normalizeText(primaryOrg.fields.mission) }
              : {}),
            ...(normalizeText(primaryOrg.fields.strategy)
              ? { strategy: normalizeText(primaryOrg.fields.strategy) }
              : {}),
          },
        }
      : {}),
    teams: teams.map((instance) => ({
      title: normalizeText(instance.fields.title) ?? 'Untitled team',
      members: normalizeStringList(instance.fields.members),
      responsibilities: normalizeStringList(instance.fields.responsibilities),
    })),
    clients: clients.map((instance) => ({
      title: normalizeText(instance.fields.title)
        ?? normalizeText(instance.fields.name)
        ?? 'Untitled client',
      status: normalizeText(instance.fields.status) ?? 'unknown',
      ...(normalizeText(instance.fields.description)
        ? { description: normalizeText(instance.fields.description) }
        : {}),
    })),
    recentDecisions: decisions
      .slice()
      .sort((left, right) => compareByRecency(left, right, ['date', 'updated', 'created']))
      .slice(0, 10)
      .map((instance) => ({
        title: normalizeText(instance.fields.title) ?? 'Untitled decision',
        ...(normalizeText(instance.fields.decided_by)
          ? { decidedBy: normalizeText(instance.fields.decided_by) }
          : {}),
        ...(normalizeText(instance.fields.date)
          ? { date: normalizeText(instance.fields.date) }
          : {}),
        status: normalizeText(instance.fields.status) ?? 'draft',
      })),
    patterns: patterns.map((instance) => ({
      title: normalizeText(instance.fields.title) ?? 'Untitled pattern',
      ...(normalizeText(instance.fields.description)
        ? { description: normalizeText(instance.fields.description) }
        : {}),
    })),
    ...(actorAgent
      ? {
          agentProfile: {
            name: normalizeText(actorAgent.fields.name) ?? actor,
            capabilities: normalizeStringList(actorAgent.fields.capabilities),
            permissions: normalizeStringList(actorAgent.fields.permissions),
          },
        }
      : {}),
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

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeText(item))
    .filter((item): item is string => !!item);
}

function compareByRecency(
  left: PrimitiveInstance,
  right: PrimitiveInstance,
  fieldPriority: string[],
): number {
  return getMostRecentTimestamp(right, fieldPriority) - getMostRecentTimestamp(left, fieldPriority);
}

function getMostRecentTimestamp(instance: PrimitiveInstance, fieldPriority: string[]): number {
  for (const fieldName of fieldPriority) {
    const raw = normalizeText(instance.fields[fieldName]);
    if (!raw) continue;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}
