/**
 * Meta-coordination layer that inspects swarm state and restructures work.
 */

import * as store from './store.js';
import * as thread from './thread.js';
import * as swarm from './swarm.js';

export type MetaCoordinationAction =
  | {
      type: 'create-unblock-thread';
      targetThreadPath: string;
      createdThreadPath: string;
    }
  | {
      type: 'reprioritize-thread';
      threadPath: string;
      previousPriority: string;
      nextPriority: string;
    };

export interface MetaCoordinationOptions {
  actor: string;
  priorityBoostCompletionThreshold?: number;
  maxUnblockThreadsPerCycle?: number;
}

export interface MetaCoordinationResult {
  analyzedAt: string;
  spaceSlug: string;
  actions: MetaCoordinationAction[];
  statusBefore: {
    total: number;
    done: number;
    blocked: number;
    open: number;
    readyToClaim: number;
    percentComplete: number;
  };
  statusAfter: {
    total: number;
    done: number;
    blocked: number;
    open: number;
    readyToClaim: number;
    percentComplete: number;
  };
}

export function restructureSwarm(
  workspacePath: string,
  spaceSlug: string,
  options: MetaCoordinationOptions,
): MetaCoordinationResult {
  const analyzedAt = new Date().toISOString();
  const actions: MetaCoordinationAction[] = [];
  const threshold = clampInt(options.priorityBoostCompletionThreshold, 70, 0, 100);
  const maxUnblockThreads = clampInt(options.maxUnblockThreadsPerCycle, 5, 1, 100);
  const spaceRef = `spaces/${spaceSlug}.md`;
  const statusBefore = swarm.getSwarmStatus(workspacePath, spaceSlug);

  const activeMetaTargets = new Set(
    store
      .threadsInSpace(workspacePath, spaceRef)
      .filter((entry) => String(entry.fields.meta_kind ?? '') === 'meta-unblock')
      .filter((entry) => {
        const status = String(entry.fields.status ?? '');
        return status === 'open' || status === 'active' || status === 'blocked';
      })
      .map((entry) => String(entry.fields.meta_target ?? ''))
      .filter(Boolean),
  );

  for (const blocked of statusBefore.threads.filter((entry) => entry.status === 'blocked').slice(0, maxUnblockThreads)) {
    if (activeMetaTargets.has(blocked.path)) continue;
    const created = thread.createThread(
      workspacePath,
      `Resolve blocker: ${blocked.title}`,
      `Unblock swarm execution for thread ${blocked.path}.`,
      options.actor,
      {
        priority: 'high',
        space: spaceRef,
        context_refs: [blocked.path, spaceRef],
        tags: ['meta-coordination', 'unblock'],
      },
    );
    const enrichedBody = `${created.body}\n\n## Meta Coordination\n\nTarget blocked thread: [[${blocked.path}]]\n`;
    const updated = store.update(
      workspacePath,
      created.path,
      {
        meta_kind: 'meta-unblock',
        meta_target: blocked.path,
      },
      enrichedBody,
      options.actor,
    );
    activeMetaTargets.add(blocked.path);
    actions.push({
      type: 'create-unblock-thread',
      targetThreadPath: blocked.path,
      createdThreadPath: updated.path,
    });
  }

  if (statusBefore.percentComplete >= threshold) {
    const readyThreads = thread.listReadyThreadsInSpace(workspacePath, spaceRef);
    for (const candidate of readyThreads) {
      const previousPriority = String(candidate.fields.priority ?? 'medium').toLowerCase();
      if (previousPriority !== 'low' && previousPriority !== 'medium') continue;
      store.update(
        workspacePath,
        candidate.path,
        {
          priority: 'high',
          meta_reprioritized_at: analyzedAt,
        },
        undefined,
        options.actor,
      );
      actions.push({
        type: 'reprioritize-thread',
        threadPath: candidate.path,
        previousPriority,
        nextPriority: 'high',
      });
    }
  }

  const statusAfter = swarm.getSwarmStatus(workspacePath, spaceSlug);
  return {
    analyzedAt,
    spaceSlug,
    actions,
    statusBefore: summarize(statusBefore),
    statusAfter: summarize(statusAfter),
  };
}

function summarize(status: swarm.SwarmStatus): MetaCoordinationResult['statusBefore'] {
  return {
    total: status.total,
    done: status.done,
    blocked: status.blocked,
    open: status.open,
    readyToClaim: status.readyToClaim,
    percentComplete: status.percentComplete,
  };
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const raw = Number.isFinite(value) ? Math.trunc(Number(value)) : fallback;
  return Math.min(max, Math.max(min, raw));
}
