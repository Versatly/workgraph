import {
  ledger as ledgerModule,
  store as storeModule,
  type LedgerEntry,
  type PrimitiveInstance,
} from '@versatly/workgraph-kernel';
import { deriveEventFields } from './server-events.js';

const ledger = ledgerModule;
const store = storeModule;

const STALE_THREAD_MS = 24 * 60 * 60 * 1_000;
const AGENT_ONLINE_WINDOW_MS = 30 * 60 * 1_000;

export interface LensOptions {
  space?: string;
}

export interface AttentionLensResult {
  threads: AttentionLensThread[];
  summary: {
    blocked: number;
    stale: number;
    urgent_unclaimed: number;
  };
}

export interface AttentionLensThread {
  path: string;
  title: string;
  status: string;
  priority: string;
  owner?: string;
  space?: string;
  updated?: string;
  reason: 'blocked' | 'urgent_unclaimed' | 'stale' | 'unresolved_dependencies';
  unresolvedDeps?: string[];
}

export interface AgentsLensResult {
  agents: AgentLensSummary[];
}

export interface AgentLensSummary {
  name: string;
  lastSeen: string;
  actionCount: number;
  claimedThreads: string[];
  online: boolean;
}

export interface SpacesLensResult {
  spaces: SpaceLensSummary[];
}

export interface SpaceLensSummary {
  name: string;
  total: number;
  open: number;
  active: number;
  blocked: number;
  done: number;
  progress: number;
}

export interface TimelineLensResult {
  events: TimelineLensEvent[];
}

export interface TimelineLensEvent {
  timestamp: string;
  actor: string;
  operation: string;
  path: string;
  threadTitle?: string;
  changedFields: Record<string, unknown>;
}

export function buildAttentionLens(workspacePath: string, options: LensOptions = {}): AttentionLensResult {
  const normalizedSpace = normalizeSpaceRef(options.space);
  const nowMs = Date.now();
  const claims = ledger.allClaims(workspacePath);
  const allThreads = listThreads(workspacePath, normalizedSpace);
  const threadByPath = new Map(allThreads.map((thread) => [thread.path, thread]));

  const blocked = allThreads
    .filter((thread) => threadStatus(thread) === 'blocked')
    .sort(comparePriorityThenUpdatedAsc);
  const urgentUnclaimed = allThreads
    .filter((thread) =>
      threadStatus(thread) === 'open' &&
      normalizePriority(thread.fields.priority) === 'urgent' &&
      !claims.has(thread.path))
    .sort(comparePriorityThenUpdatedAsc);
  const stale = allThreads
    .filter((thread) =>
      threadStatus(thread) === 'active' &&
      isStaleThread(thread, nowMs))
    .sort(comparePriorityThenUpdatedAsc);
  const unresolvedDeps = allThreads
    .map((thread) => ({ thread, unresolved: unresolvedDependencies(thread, threadByPath) }))
    .filter((entry) =>
      entry.unresolved.length > 0 &&
      threadStatus(entry.thread) !== 'done' &&
      threadStatus(entry.thread) !== 'cancelled')
    .sort((a, b) => comparePriorityThenUpdatedAsc(a.thread, b.thread));

  const prioritized = new Map<string, AttentionLensThread>();
  for (const thread of blocked) {
    prioritized.set(thread.path, toAttentionThread(thread, 'blocked'));
  }
  for (const thread of urgentUnclaimed) {
    if (!prioritized.has(thread.path)) {
      prioritized.set(thread.path, toAttentionThread(thread, 'urgent_unclaimed'));
    }
  }
  for (const thread of stale) {
    if (!prioritized.has(thread.path)) {
      prioritized.set(thread.path, toAttentionThread(thread, 'stale'));
    }
  }
  for (const entry of unresolvedDeps) {
    if (!prioritized.has(entry.thread.path)) {
      prioritized.set(
        entry.thread.path,
        toAttentionThread(entry.thread, 'unresolved_dependencies', entry.unresolved),
      );
    }
  }

  return {
    threads: [...prioritized.values()],
    summary: {
      blocked: blocked.length,
      stale: stale.length,
      urgent_unclaimed: urgentUnclaimed.length,
    },
  };
}

export function buildAgentsLens(workspacePath: string, options: LensOptions = {}): AgentsLensResult {
  const normalizedSpace = normalizeSpaceRef(options.space);
  const threadByPath = buildThreadPathIndex(workspacePath);
  const allEntries = ledger.readAll(workspacePath);
  const entries = filterLedgerBySpace(allEntries, normalizedSpace, threadByPath);
  const claims = [...ledger.allClaims(workspacePath).entries()]
    .filter(([threadPath]) => threadInSpace(threadByPath.get(threadPath), normalizedSpace));

  const byAgent = new Map<string, AgentLensSummary>();
  for (const entry of entries) {
    const current = byAgent.get(entry.actor) ?? {
      name: entry.actor,
      lastSeen: entry.ts,
      actionCount: 0,
      claimedThreads: [],
      online: false,
    };
    current.actionCount += 1;
    if (entry.ts > current.lastSeen) current.lastSeen = entry.ts;
    byAgent.set(entry.actor, current);
  }

  for (const [threadPath, owner] of claims) {
    const current = byAgent.get(owner) ?? {
      name: owner,
      lastSeen: '',
      actionCount: 0,
      claimedThreads: [],
      online: false,
    };
    if (!current.claimedThreads.includes(threadPath)) {
      current.claimedThreads.push(threadPath);
    }
    byAgent.set(owner, current);
  }

  const nowMs = Date.now();
  const agents = [...byAgent.values()]
    .map((agent) => ({
      ...agent,
      claimedThreads: [...agent.claimedThreads].sort((a, b) => a.localeCompare(b)),
      online: isOnline(agent.lastSeen, nowMs),
    }))
    .sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return b.lastSeen.localeCompare(a.lastSeen) || b.actionCount - a.actionCount || a.name.localeCompare(b.name);
    });

  return { agents };
}

export function buildSpacesLens(workspacePath: string, options: LensOptions = {}): SpacesLensResult {
  const normalizedSpace = normalizeSpaceRef(options.space);
  const allThreads = listThreads(workspacePath, normalizedSpace);
  const bySpace = new Map<string, SpaceLensSummary>();

  for (const thread of allThreads) {
    const spaceName = normalizeSpaceRef(thread.fields.space) ?? 'unassigned';
    const current = bySpace.get(spaceName) ?? {
      name: spaceName,
      total: 0,
      open: 0,
      active: 0,
      blocked: 0,
      done: 0,
      progress: 0,
    };
    current.total += 1;
    const status = threadStatus(thread);
    if (status === 'open') current.open += 1;
    if (status === 'active') current.active += 1;
    if (status === 'blocked') current.blocked += 1;
    if (status === 'done') current.done += 1;
    bySpace.set(spaceName, current);
  }

  const spaces = [...bySpace.values()]
    .map((space) => ({
      ...space,
      progress: space.total === 0 ? 0 : roundToTwo((space.done / space.total) * 100),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { spaces };
}

export function buildTimelineLens(workspacePath: string, options: LensOptions = {}): TimelineLensResult {
  const normalizedSpace = normalizeSpaceRef(options.space);
  const threadByPath = buildThreadPathIndex(workspacePath);
  const allEntries = ledger.readAll(workspacePath);
  const entries = filterLedgerBySpace(allEntries, normalizedSpace, threadByPath)
    .slice(-50)
    .reverse();

  return {
    events: entries.map((entry) => {
      const threadTitle = resolveThreadTitle(entry, threadByPath);
      return {
        timestamp: entry.ts,
        actor: entry.actor,
        operation: entry.op,
        path: entry.target,
        ...(threadTitle ? { threadTitle } : {}),
        changedFields: deriveEventFields(entry),
      };
    }),
  };
}

function listThreads(workspacePath: string, space: string | undefined): PrimitiveInstance[] {
  const allThreads = store.list(workspacePath, 'thread');
  return allThreads.filter((thread) => threadInSpace(thread, space));
}

function buildThreadPathIndex(workspacePath: string): Map<string, PrimitiveInstance> {
  const threads = store.list(workspacePath, 'thread');
  return new Map(threads.map((thread) => [thread.path, thread]));
}

function filterLedgerBySpace(
  entries: LedgerEntry[],
  space: string | undefined,
  threadByPath: Map<string, PrimitiveInstance>,
): LedgerEntry[] {
  if (!space) return entries;
  return entries.filter((entry) => {
    const targetThread = resolveThreadForLedgerEntry(entry, threadByPath);
    return threadInSpace(targetThread, space);
  });
}

function resolveThreadForLedgerEntry(
  entry: LedgerEntry,
  threadByPath: Map<string, PrimitiveInstance>,
): PrimitiveInstance | undefined {
  if (entry.type === 'thread' || looksLikeThreadPath(entry.target)) {
    return threadByPath.get(normalizeThreadPath(entry.target));
  }
  return undefined;
}

function resolveThreadTitle(
  entry: LedgerEntry,
  threadByPath: Map<string, PrimitiveInstance>,
): string | undefined {
  const thread = resolveThreadForLedgerEntry(entry, threadByPath);
  if (!thread) return undefined;
  const title = String(thread.fields.title ?? '').trim();
  return title || thread.path;
}

function unresolvedDependencies(
  thread: PrimitiveInstance,
  threadByPath: Map<string, PrimitiveInstance>,
): string[] {
  const deps = Array.isArray(thread.fields.deps) ? thread.fields.deps : [];
  const unresolved: string[] = [];
  for (const dep of deps) {
    const normalized = normalizeThreadPath(dep);
    if (!normalized) continue;
    if (normalized.startsWith('external/')) {
      unresolved.push(normalized);
      continue;
    }
    const dependencyThread = threadByPath.get(normalized);
    if (!dependencyThread || threadStatus(dependencyThread) !== 'done') {
      unresolved.push(normalized);
    }
  }
  return unresolved;
}

function toAttentionThread(
  thread: PrimitiveInstance,
  reason: AttentionLensThread['reason'],
  unresolved: string[] = [],
): AttentionLensThread {
  const owner = readOptionalString(thread.fields.owner);
  const space = normalizeSpaceRef(thread.fields.space);
  const updated = readOptionalString(thread.fields.updated);
  return {
    path: thread.path,
    title: String(thread.fields.title ?? thread.path),
    status: threadStatus(thread),
    priority: normalizePriority(thread.fields.priority),
    ...(owner ? { owner } : {}),
    ...(space ? { space } : {}),
    ...(updated ? { updated } : {}),
    reason,
    ...(unresolved.length > 0 ? { unresolvedDeps: unresolved } : {}),
  };
}

function isStaleThread(thread: PrimitiveInstance, nowMs: number): boolean {
  const updatedTs = parseTimestampMs(thread.fields.updated ?? thread.fields.created);
  if (!Number.isFinite(updatedTs)) return false;
  return nowMs - updatedTs > STALE_THREAD_MS;
}

function isOnline(lastSeen: string, nowMs: number): boolean {
  const ts = parseTimestampMs(lastSeen);
  if (!Number.isFinite(ts)) return false;
  return nowMs - ts <= AGENT_ONLINE_WINDOW_MS;
}

function comparePriorityThenUpdatedAsc(a: PrimitiveInstance, b: PrimitiveInstance): number {
  const priorityDelta = priorityRank(a.fields.priority) - priorityRank(b.fields.priority);
  if (priorityDelta !== 0) return priorityDelta;
  const updatedA = parseTimestampMs(a.fields.updated ?? a.fields.created);
  const updatedB = parseTimestampMs(b.fields.updated ?? b.fields.created);
  const safeA = Number.isFinite(updatedA) ? updatedA : Number.MAX_SAFE_INTEGER;
  const safeB = Number.isFinite(updatedB) ? updatedB : Number.MAX_SAFE_INTEGER;
  return safeA - safeB;
}

function priorityRank(value: unknown): number {
  const normalized = normalizePriority(value);
  if (normalized === 'urgent') return 0;
  if (normalized === 'high') return 1;
  if (normalized === 'medium') return 2;
  if (normalized === 'low') return 3;
  return 4;
}

function threadStatus(thread: PrimitiveInstance): string {
  return String(thread.fields.status ?? '');
}

function normalizePriority(value: unknown): string {
  return String(value ?? 'medium').trim().toLowerCase();
}

function normalizeSpaceRef(value: unknown): string | undefined {
  const raw = readOptionalString(value);
  if (!raw) return undefined;
  const unwrapped = raw.startsWith('[[') && raw.endsWith(']]')
    ? raw.slice(2, -2)
    : raw;
  return unwrapped.endsWith('.md') ? unwrapped : `${unwrapped}.md`;
}

function threadInSpace(thread: PrimitiveInstance | undefined, space: string | undefined): boolean {
  if (!space) return true;
  if (!thread) return false;
  return normalizeSpaceRef(thread.fields.space) === space;
}

function looksLikeThreadPath(value: string): boolean {
  return value.replace(/\\/g, '/').startsWith('threads/');
}

function normalizeThreadPath(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const unwrapped = raw.startsWith('[[') && raw.endsWith(']]')
    ? raw.slice(2, -2)
    : raw;
  const primary = unwrapped.split('|')[0].trim().split('#')[0].trim();
  if (!primary) return '';
  if (primary.startsWith('external/')) return primary;
  const withPathPrefix = primary.startsWith('threads/')
    ? primary
    : `threads/${primary}`;
  return withPathPrefix.endsWith('.md') ? withPathPrefix : `${withPathPrefix}.md`;
}

function parseTimestampMs(value: unknown): number {
  const parsed = Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) return Number.NaN;
  return parsed;
}

function roundToTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
