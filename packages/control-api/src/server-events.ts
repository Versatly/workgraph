import { ledger as ledgerModule, type LedgerEntry, type LedgerOp } from '@versatly/workgraph-kernel';

const ledger = ledgerModule;

export type DashboardEventType =
  | 'thread.created'
  | 'thread.updated'
  | 'thread.claimed'
  | 'thread.done'
  | 'thread.blocked'
  | 'thread.released'
  | 'collaboration.message'
  | 'collaboration.ask'
  | 'collaboration.reply'
  | 'collaboration.heartbeat'
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

export function mapLedgerEntryToDashboardEvents(entry: LedgerEntry): DashboardEvent[] {
  const nextEventId = createEventIdFactory(entry);
  const base = {
    path: entry.target,
    actor: entry.actor,
    ts: entry.ts,
  };

  const events: DashboardEvent[] = [];
  if (entry.type === 'thread') {
    const threadEventType = toThreadEventType(entry.op);
    if (threadEventType) {
      events.push({
        id: nextEventId(),
        ...base,
        type: threadEventType,
        fields: deriveEventFields(entry),
      });
    }
  }

  const collaborationEvent = toCollaborationEvent(entry);
  if (collaborationEvent) {
    events.push({
      id: nextEventId(),
      ...base,
      type: collaborationEvent.type,
      fields: collaborationEvent.fields,
    });
  }

  if (shouldEmitPrimitiveChanged(entry)) {
    events.push({
      id: nextEventId(),
      ...base,
      type: 'primitive.changed',
      fields: {
        op: entry.op,
        type: entry.type,
        ...sanitizeData(entry.data),
      },
    });
  }

  events.push({
    id: nextEventId(),
    ...base,
    type: 'ledger.appended',
    fields: {
      op: entry.op,
      type: entry.type,
      ...sanitizeData(entry.data),
    },
  });

  return events;
}

export function listDashboardEventsSince(
  workspacePath: string,
  lastEventId: string | undefined,
): DashboardEvent[] {
  const events = ledger.readAll(workspacePath)
    .flatMap((entry) => mapLedgerEntryToDashboardEvents(entry));
  const startIdx = resolveReplayStartIndex(events, lastEventId);
  return events.slice(startIdx);
}

export function subscribeToDashboardEvents(
  workspacePath: string,
  onEvent: (event: DashboardEvent) => void,
): () => void {
  return ledger.subscribe(workspacePath, (entry) => {
    const events = mapLedgerEntryToDashboardEvents(entry);
    for (const event of events) {
      onEvent(event);
    }
  });
}

export function toSsePayload(event: DashboardEvent): string {
  const body = JSON.stringify({
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

function readEventId(entry: LedgerEntry): string {
  if (entry.hash) return entry.hash;
  return `${entry.ts}:${entry.actor}:${entry.op}:${entry.target}`;
}

function createEventIdFactory(entry: LedgerEntry): () => string {
  const baseId = readEventId(entry);
  let offset = 0;
  return () => `${baseId}:${offset++}`;
}

function resolveReplayStartIndex(events: DashboardEvent[], lastEventId: string | undefined): number {
  if (!lastEventId) return 0;
  const exact = events.findIndex((event) => event.id === lastEventId);
  if (exact >= 0) return exact + 1;
  // Backward-compat: clients may still send bare ledger hash ids.
  const entryPrefix = `${lastEventId}:`;
  let lastMatch = -1;
  for (let idx = 0; idx < events.length; idx += 1) {
    if (events[idx].id.startsWith(entryPrefix)) {
      lastMatch = idx;
    }
  }
  return lastMatch >= 0 ? lastMatch + 1 : 0;
}

function toCollaborationEvent(
  entry: LedgerEntry,
): { type: DashboardEventType; fields: Record<string, unknown> } | null {
  if (entry.type === 'conversation' && entry.op === 'update') {
    const raw = toRecord(entry.data?.conversation_event);
    if (raw) {
      const rawKind = String(raw.event_type ?? raw.kind ?? 'message').trim().toLowerCase();
      const type: DashboardEventType = rawKind === 'ask'
        ? 'collaboration.ask'
        : rawKind === 'reply'
          ? 'collaboration.reply'
          : 'collaboration.message';
      return {
        type,
        fields: sanitizeData({
          conversation_path: entry.target,
          ...raw,
        }),
      };
    }
  }

  if (entry.type === 'thread' && entry.op === 'heartbeat') {
    return {
      type: 'collaboration.heartbeat',
      fields: sanitizeData({
        target_type: 'thread',
        thread_path: entry.target,
        ...entry.data,
      }),
    };
  }

  if (entry.type === 'presence' && entry.op === 'update' && isPresenceHeartbeat(entry)) {
    return {
      type: 'collaboration.heartbeat',
      fields: sanitizeData({
        target_type: 'presence',
        presence_path: entry.target,
        ...entry.data,
      }),
    };
  }
  return null;
}

function isPresenceHeartbeat(entry: LedgerEntry): boolean {
  const changed = entry.data?.changed;
  if (!Array.isArray(changed)) return false;
  return changed.some((field) => String(field).trim() === 'last_seen');
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function sanitizeData(data: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!data) return {};
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}
