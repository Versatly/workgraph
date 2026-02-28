/**
 * Agent performance profiles derived from ledger metrics.
 */

import * as ledger from './ledger.js';
import type { LedgerEntry } from './types.js';

export interface AgentProfile {
  actor: string;
  tasksCompleted: number;
  failures: number;
  attempts: number;
  failureRate: number;
  averageTaskDurationMs: number;
  averageTaskDurationMinutes: number;
  lastActivityAt: string | null;
}

export interface AgentProfilingSnapshot {
  generatedAt: string;
  totalEvents: number;
  profiles: AgentProfile[];
}

interface AgentAccumulator {
  actor: string;
  tasksCompleted: number;
  failures: number;
  durationsMs: number[];
  lastActivityAt: string | null;
}

export function buildAgentProfiles(workspacePath: string): AgentProfilingSnapshot {
  const entries = ledger.readAll(workspacePath);
  const byActor = new Map<string, AgentAccumulator>();
  const claimTimes = new Map<string, string[]>();

  const ensureActor = (actor: string): AgentAccumulator => {
    const existing = byActor.get(actor);
    if (existing) return existing;
    const seeded: AgentAccumulator = {
      actor,
      tasksCompleted: 0,
      failures: 0,
      durationsMs: [],
      lastActivityAt: null,
    };
    byActor.set(actor, seeded);
    return seeded;
  };

  for (const entry of entries) {
    const actor = String(entry.actor ?? '').trim();
    if (!actor) continue;
    const acc = ensureActor(actor);
    if (!acc.lastActivityAt || entry.ts > acc.lastActivityAt) {
      acc.lastActivityAt = entry.ts;
    }

    if (isThreadClaim(entry)) {
      const key = actorThreadKey(actor, entry.target);
      const stack = claimTimes.get(key) ?? [];
      stack.push(entry.ts);
      claimTimes.set(key, stack);
      continue;
    }

    if (isThreadCompletion(entry)) {
      acc.tasksCompleted += 1;
      const key = actorThreadKey(actor, entry.target);
      const stack = claimTimes.get(key);
      const claimTs = stack && stack.length > 0 ? stack.pop() : undefined;
      if (claimTs) {
        const durationMs = Date.parse(entry.ts) - Date.parse(claimTs);
        if (Number.isFinite(durationMs) && durationMs >= 0) {
          acc.durationsMs.push(durationMs);
        }
      }
      continue;
    }

    if (isFailureEvent(entry)) {
      acc.failures += 1;
    }
  }

  const profiles = [...byActor.values()]
    .map(toProfile)
    .sort((a, b) =>
      b.tasksCompleted - a.tasksCompleted ||
      a.failureRate - b.failureRate ||
      a.actor.localeCompare(b.actor),
    );

  return {
    generatedAt: new Date().toISOString(),
    totalEvents: entries.length,
    profiles,
  };
}

export function getAgentProfile(
  workspacePath: string,
  actor: string,
): AgentProfile {
  const snapshot = buildAgentProfiles(workspacePath);
  const target = actor.trim().toLowerCase();
  const match = snapshot.profiles.find((profile) => profile.actor.toLowerCase() === target);
  if (match) return match;
  return {
    actor,
    tasksCompleted: 0,
    failures: 0,
    attempts: 0,
    failureRate: 0,
    averageTaskDurationMs: 0,
    averageTaskDurationMinutes: 0,
    lastActivityAt: null,
  };
}

function toProfile(acc: AgentAccumulator): AgentProfile {
  const attempts = acc.tasksCompleted + acc.failures;
  const totalDurationMs = acc.durationsMs.reduce((sum, value) => sum + value, 0);
  const averageTaskDurationMs = acc.durationsMs.length > 0 ? totalDurationMs / acc.durationsMs.length : 0;
  return {
    actor: acc.actor,
    tasksCompleted: acc.tasksCompleted,
    failures: acc.failures,
    attempts,
    failureRate: attempts > 0 ? acc.failures / attempts : 0,
    averageTaskDurationMs,
    averageTaskDurationMinutes: averageTaskDurationMs / 60_000,
    lastActivityAt: acc.lastActivityAt,
  };
}

function isThreadClaim(entry: LedgerEntry): boolean {
  return entry.op === 'claim' && entry.type === 'thread';
}

function isThreadCompletion(entry: LedgerEntry): boolean {
  return entry.op === 'done' && entry.type === 'thread';
}

function isFailureEvent(entry: LedgerEntry): boolean {
  if (entry.op === 'cancel' && entry.type === 'thread') {
    return true;
  }
  if (entry.op === 'update' && entry.type === 'run' && String(entry.data?.status ?? '') === 'failed') {
    return true;
  }
  return false;
}

function actorThreadKey(actor: string, threadPath: string): string {
  return `${actor}::${threadPath}`;
}
