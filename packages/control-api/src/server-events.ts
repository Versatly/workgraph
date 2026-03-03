import { ledger as ledgerModule, type LedgerEntry, type LedgerOp } from '@versatly/workgraph-kernel';

const ledger = ledgerModule;

export type DashboardEventType =
  | 'thread.created'
  | 'thread.updated'
  | 'thread.claimed'
  | 'thread.done'
  | 'thread.blocked'
  | 'thread.released'
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
  const id = readEventId(entry);
  const base = {
    id,
    path: entry.target,
    actor: entry.actor,
    ts: entry.ts,
  };

  const events: DashboardEvent[] = [];
  if (entry.type === 'thread') {
    const threadEventType = toThreadEventType(entry.op);
    if (threadEventType) {
      events.push({
        ...base,
        type: threadEventType,
        fields: deriveEventFields(entry),
      });
    }
  }

  if (shouldEmitPrimitiveChanged(entry)) {
    events.push({
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
  const entries = ledger.readAll(workspacePath);
  const startIdx = resolveReplayStartIndex(entries, lastEventId);
  return entries
    .slice(startIdx)
    .flatMap((entry) => mapLedgerEntryToDashboardEvents(entry));
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

function resolveReplayStartIndex(entries: LedgerEntry[], lastEventId: string | undefined): number {
  if (!lastEventId) return 0;
  const idx = entries.findIndex((entry) => entry.hash === lastEventId);
  if (idx < 0) return 0;
  return idx + 1;
}

function sanitizeData(data: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!data) return {};
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}
