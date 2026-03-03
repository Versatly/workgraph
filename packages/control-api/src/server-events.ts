import { ledger as ledgerModule, type LedgerEntry, type LedgerOp } from '@versatly/workgraph-kernel';

const ledger = ledgerModule;
const EVENT_ID_DELIMITER = '#';

export type DashboardEventType =
  | 'thread.created'
  | 'thread.updated'
  | 'thread.claimed'
  | 'thread.done'
  | 'thread.blocked'
  | 'thread.released'
  | 'conversation.updated'
  | 'plan-step.updated'
  | 'run.updated'
  | 'ledger.appended'
  | 'primitive.changed';

export interface DashboardEvent {
  id: string;
  type: DashboardEventType;
  path: string;
  actor: string;
  fields: Record<string, unknown>;
  ts: string;
}

export interface DashboardEventFilter {
  eventTypes?: ReadonlySet<string>;
  primitiveTypes?: ReadonlySet<string>;
  threadPaths?: ReadonlySet<string>;
}

export interface CreateDashboardEventFilterInput {
  eventTypes?: Iterable<string>;
  primitiveTypes?: Iterable<string>;
  threads?: Iterable<string>;
}

/**
 * Deterministic event projection for dashboard consumers.
 *
 * Guarantees:
 * - Event order follows ledger append order + stable projection order per ledger entry.
 * - Event ids are deterministic and unique per projected event.
 * - Replays are idempotent via `id` and `Last-Event-ID`.
 */
export function mapLedgerEntryToDashboardEvents(entry: LedgerEntry): DashboardEvent[] {
  const entryId = readEntryId(entry);
  const base = {
    path: entry.target,
    actor: entry.actor,
    ts: entry.ts,
  };

  const projected: Array<Omit<DashboardEvent, 'id'>> = [];
  const pushEvent = (type: DashboardEventType, fields: Record<string, unknown>) => {
    projected.push({
      ...base,
      type,
      fields,
    });
  };

  if (entry.type === 'thread') {
    const threadEventType = toThreadEventType(entry.op);
    if (threadEventType) {
      pushEvent(threadEventType, deriveEventFields(entry));
    }
  }

  const primitiveLifecycleType = toPrimitiveLifecycleEventType(entry);
  if (primitiveLifecycleType) {
    pushEvent(primitiveLifecycleType, {
      op: entry.op,
      type: entry.type,
      ...sanitizeData(entry.data),
    });
  }

  if (shouldEmitPrimitiveChanged(entry)) {
    pushEvent('primitive.changed', {
      op: entry.op,
      type: entry.type,
      ...sanitizeData(entry.data),
    });
  };

  pushEvent('ledger.appended', {
    op: entry.op,
    type: entry.type,
    ...sanitizeData(entry.data),
  });

  const slotByType = new Map<string, number>();
  return projected.map((event) => {
    const slot = slotByType.get(event.type) ?? 0;
    slotByType.set(event.type, slot + 1);
    const slotName = slot === 0 ? event.type : `${event.type}.${slot + 1}`;
    return {
      id: composeEventId(entryId, slotName),
      ...event,
    };
  });
}

export function listDashboardEventsSince(
  workspacePath: string,
  lastEventId: string | undefined,
  filter?: DashboardEventFilter,
): DashboardEvent[] {
  const allEvents = ledger
    .readAll(workspacePath)
    .flatMap((entry) => mapLedgerEntryToDashboardEvents(entry));
  const startIdx = resolveReplayStartIndex(allEvents, lastEventId);
  const replay = allEvents.slice(startIdx);
  if (!filter) return replay;
  return replay.filter((event) => matchesDashboardEventFilter(event, filter));
}

export function subscribeToDashboardEvents(
  workspacePath: string,
  onEvent: (event: DashboardEvent) => void,
  filter?: DashboardEventFilter,
): () => void {
  return ledger.subscribe(workspacePath, (entry) => {
    const events = mapLedgerEntryToDashboardEvents(entry);
    for (const event of events) {
      if (!matchesDashboardEventFilter(event, filter)) continue;
      onEvent(event);
    }
  });
}

export function toSsePayload(event: DashboardEvent): string {
  const body = JSON.stringify({
    id: event.id,
    type: event.type,
    path: event.path,
    actor: event.actor,
    fields: event.fields,
    ts: event.ts,
  });
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${body}\n\n`;
}

export function deriveEventFields(entry: LedgerEntry): Record<string, unknown> {
  const fallback = sanitizeData(entry.data);
  switch (entry.op) {
    case 'claim':
      return {
        status: 'active',
        owner: entry.actor,
        ...fallback,
      };
    case 'release':
    case 'reopen':
      return {
        status: 'open',
        owner: null,
        ...fallback,
      };
    case 'done':
      return {
        status: 'done',
        ...fallback,
      };
    case 'block':
      return {
        status: 'blocked',
        ...fallback,
      };
    case 'unblock':
      return {
        status: 'active',
        ...fallback,
      };
    case 'cancel':
      return {
        status: 'cancelled',
        owner: null,
        ...fallback,
      };
    case 'delete':
      return {
        deleted: true,
        ...fallback,
      };
    default:
      return fallback;
  }
}

function shouldEmitPrimitiveChanged(entry: LedgerEntry): boolean {
  if (!entry.type) return false;
  if (entry.target.startsWith('.workgraph/ledger')) return false;
  return isPrimitiveMutationOp(entry.op);
}

export function createDashboardEventFilter(input: CreateDashboardEventFilterInput): DashboardEventFilter | undefined {
  const eventTypes = normalizeStringSet(input.eventTypes);
  const primitiveTypes = normalizeStringSet(input.primitiveTypes);
  const threadPaths = normalizeThreadPathSet(input.threads);
  if (!eventTypes && !primitiveTypes && !threadPaths) return undefined;
  return {
    ...(eventTypes ? { eventTypes } : {}),
    ...(primitiveTypes ? { primitiveTypes } : {}),
    ...(threadPaths ? { threadPaths } : {}),
  };
}

export function matchesDashboardEventFilter(event: DashboardEvent, filter: DashboardEventFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.eventTypes && !filter.eventTypes.has(event.type.toLowerCase())) {
    return false;
  }
  if (filter.primitiveTypes) {
    const primitiveType = inferPrimitiveType(event)?.toLowerCase();
    if (!primitiveType || !filter.primitiveTypes.has(primitiveType)) {
      return false;
    }
  }
  if (filter.threadPaths) {
    const eventThreadPath = normalizeThreadPath(event.path);
    if (!eventThreadPath || !filter.threadPaths.has(eventThreadPath)) {
      return false;
    }
  }
  return true;
}

function isPrimitiveMutationOp(op: LedgerOp): boolean {
  return op === 'create' ||
    op === 'update' ||
    op === 'delete' ||
    op === 'claim' ||
    op === 'release' ||
    op === 'done' ||
    op === 'block' ||
    op === 'unblock' ||
    op === 'reopen' ||
    op === 'cancel' ||
    op === 'heartbeat' ||
    op === 'handoff' ||
    op === 'decompose';
}

function toThreadEventType(op: LedgerOp): DashboardEventType | undefined {
  if (op === 'create') return 'thread.created';
  if (op === 'update') return 'thread.updated';
  if (op === 'claim') return 'thread.claimed';
  if (op === 'done') return 'thread.done';
  if (op === 'block') return 'thread.blocked';
  if (op === 'release' || op === 'reopen') return 'thread.released';
  if (op === 'unblock' || op === 'cancel' || op === 'heartbeat' || op === 'handoff' || op === 'decompose') {
    return 'thread.updated';
  }
  return undefined;
}

function toPrimitiveLifecycleEventType(entry: LedgerEntry): DashboardEventType | undefined {
  if (!entry.type || !isPrimitiveMutationOp(entry.op)) return undefined;
  if (entry.type === 'conversation') return 'conversation.updated';
  if (entry.type === 'plan-step') return 'plan-step.updated';
  if (entry.type === 'run') return 'run.updated';
  return undefined;
}

function readEntryId(entry: LedgerEntry): string {
  if (entry.hash) return entry.hash;
  return `${entry.ts}:${entry.actor}:${entry.op}:${entry.target}`;
}

function composeEventId(entryId: string, slotName: string): string {
  return `${entryId}${EVENT_ID_DELIMITER}${slotName}`;
}

function resolveReplayStartIndex(events: DashboardEvent[], lastEventId: string | undefined): number {
  if (!lastEventId) return 0;
  const normalized = lastEventId.trim();
  if (!normalized) return 0;
  const idx = events.findIndex((event) => event.id === normalized);
  if (idx < 0) return 0;
  return idx + 1;
}

function sanitizeData(data: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!data) return {};
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

function inferPrimitiveType(event: DashboardEvent): string | undefined {
  if (event.type.startsWith('thread.')) return 'thread';
  const fromFields = readNonEmptyString(event.fields.type);
  if (fromFields) return fromFields;
  const fromPath = primitiveTypeFromPath(event.path);
  if (fromPath) return fromPath;
  return undefined;
}

function primitiveTypeFromPath(rawPath: string): string | undefined {
  const normalized = String(rawPath).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized) return undefined;
  if (normalized.startsWith('.workgraph/runs/')) return 'run';
  if (normalized.startsWith('.workgraph/')) return undefined;
  const directory = normalized.split('/')[0];
  if (directory === 'threads') return 'thread';
  if (directory === 'conversations') return 'conversation';
  if (directory === 'plan-steps') return 'plan-step';
  return undefined;
}

function normalizeStringSet(values: Iterable<string> | undefined): ReadonlySet<string> | undefined {
  if (!values) return undefined;
  const set = new Set<string>();
  for (const raw of values) {
    const value = String(raw).trim().toLowerCase();
    if (!value) continue;
    set.add(value);
  }
  return set.size > 0 ? set : undefined;
}

function normalizeThreadPathSet(values: Iterable<string> | undefined): ReadonlySet<string> | undefined {
  if (!values) return undefined;
  const set = new Set<string>();
  for (const raw of values) {
    const normalized = normalizeThreadPath(raw);
    if (!normalized) continue;
    set.add(normalized);
  }
  return set.size > 0 ? set : undefined;
}

function normalizeThreadPath(rawPath: string): string | undefined {
  const raw = String(rawPath).trim();
  if (!raw) return undefined;
  const decoded = safeDecodeURIComponent(raw);
  const trimmed = decoded.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!trimmed) return undefined;
  const withDirectory = trimmed.startsWith('threads/')
    ? trimmed
    : `threads/${trimmed}`;
  return withDirectory.endsWith('.md')
    ? withDirectory
    : `${withDirectory}.md`;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
