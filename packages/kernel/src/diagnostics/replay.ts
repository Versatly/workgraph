import * as ledger from '../ledger.js';
import type { LedgerEntry } from '../types.js';
import { colorize, dim, parseDateToTimestamp, supportsColor } from './format.js';

export type ReplayEventTypeFilter = 'create' | 'update' | 'transition';

export interface ReplayOptions {
  type?: ReplayEventTypeFilter;
  actor?: string;
  primitive?: string;
  since?: string;
  until?: string;
  color?: boolean;
}

export interface ReplayUpdateDiff {
  changedFields: string[];
  statusTransition?: {
    from: string | null;
    to: string | null;
  };
}

export interface ReplayEvent {
  ts: string;
  actor: string;
  op: string;
  target: string;
  primitiveType?: string;
  category: ReplayEventTypeFilter;
  diff?: ReplayUpdateDiff;
}

export interface ReplayReport {
  generatedAt: string;
  workspacePath: string;
  filters: {
    type?: ReplayEventTypeFilter;
    actor?: string;
    primitive?: string;
    since?: string;
    until?: string;
  };
  totalEvents: number;
  events: ReplayEvent[];
}

export function replayLedger(workspacePath: string, options: ReplayOptions = {}): ReplayReport {
  const sinceTs = options.since ? parseDateToTimestamp(options.since, '--since') : null;
  const untilTs = options.until ? parseDateToTimestamp(options.until, '--until') : null;
  if (options.type && !isReplayTypeFilter(options.type)) {
    throw new Error(`Invalid --type "${options.type}". Expected create|update|transition.`);
  }

  const allEntries = ledger.readAll(workspacePath);
  const ordered = allEntries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const aTs = Date.parse(a.entry.ts);
      const bTs = Date.parse(b.entry.ts);
      const safeA = Number.isFinite(aTs) ? aTs : Number.MAX_SAFE_INTEGER;
      const safeB = Number.isFinite(bTs) ? bTs : Number.MAX_SAFE_INTEGER;
      return safeA - safeB || a.index - b.index;
    })
    .map((item) => item.entry);

  const events = ordered
    .filter((entry) => matchesReplayFilters(entry, options, sinceTs, untilTs))
    .map((entry) => mapReplayEvent(entry));

  return {
    generatedAt: new Date().toISOString(),
    workspacePath,
    filters: {
      ...(options.type ? { type: options.type } : {}),
      ...(options.actor ? { actor: options.actor } : {}),
      ...(options.primitive ? { primitive: options.primitive } : {}),
      ...(options.since ? { since: options.since } : {}),
      ...(options.until ? { until: options.until } : {}),
    },
    totalEvents: allEntries.length,
    events,
  };
}

export function renderReplayText(report: ReplayReport, options: { color?: boolean } = {}): string[] {
  if (report.events.length === 0) {
    return ['No ledger events matched the provided filters.'];
  }

  const colorEnabled = supportsColor(options.color !== false);
  const lines: string[] = [];
  for (const event of report.events) {
    const categoryColor = event.category === 'create'
      ? 'green'
      : event.category === 'update'
        ? 'yellow'
        : 'cyan';
    const categoryTag = colorize(event.category.toUpperCase().padEnd(10, ' '), categoryColor, colorEnabled);
    const ts = dim(event.ts, colorEnabled);
    lines.push(`${ts} ${categoryTag} ${event.op.padEnd(8, ' ')} ${event.actor} -> ${event.target}`);
    if (event.diff) {
      if (event.diff.changedFields.length > 0) {
        lines.push(`  ${dim('Δ changed', colorEnabled)}: ${event.diff.changedFields.join(', ')}`);
      }
      if (event.diff.statusTransition) {
        lines.push(
          `  ${dim('Δ status', colorEnabled)}: ${String(event.diff.statusTransition.from)} -> ${String(event.diff.statusTransition.to)}`,
        );
      }
    }
  }
  return lines;
}

function mapReplayEvent(entry: LedgerEntry): ReplayEvent {
  const category = categoryForOp(entry.op);
  const diff = entry.op === 'update' ? summarizeUpdateDiff(entry) : undefined;
  return {
    ts: entry.ts,
    actor: entry.actor,
    op: entry.op,
    target: entry.target,
    primitiveType: entry.type,
    category,
    ...(diff ? { diff } : {}),
  };
}

function summarizeUpdateDiff(entry: LedgerEntry): ReplayUpdateDiff | undefined {
  const changed = Array.isArray(entry.data?.changed)
    ? entry.data?.changed.map((field) => String(field))
    : [];
  const fromStatus = toNullableString(entry.data?.from_status);
  const toStatus = toNullableString(entry.data?.to_status);
  if (changed.length === 0 && fromStatus === undefined && toStatus === undefined) {
    return undefined;
  }
  return {
    changedFields: changed,
    ...(fromStatus !== undefined || toStatus !== undefined
      ? {
          statusTransition: {
            from: fromStatus ?? null,
            to: toStatus ?? null,
          },
        }
      : {}),
  };
}

function matchesReplayFilters(
  entry: LedgerEntry,
  options: ReplayOptions,
  sinceTs: number | null,
  untilTs: number | null,
): boolean {
  if (options.type && categoryForOp(entry.op) !== options.type) return false;
  if (options.actor && entry.actor !== options.actor) return false;
  if (options.primitive) {
    const primitiveFilter = options.primitive.toLowerCase();
    const target = entry.target.toLowerCase();
    const type = String(entry.type ?? '').toLowerCase();
    if (!target.includes(primitiveFilter) && type !== primitiveFilter) return false;
  }
  if (sinceTs !== null || untilTs !== null) {
    const eventTs = Date.parse(entry.ts);
    if (!Number.isFinite(eventTs)) return false;
    if (sinceTs !== null && eventTs < sinceTs) return false;
    if (untilTs !== null && eventTs > untilTs) return false;
  }
  return true;
}

function categoryForOp(op: string): ReplayEventTypeFilter {
  if (op === 'create') return 'create';
  if (op === 'update') return 'update';
  return 'transition';
}

function isReplayTypeFilter(value: string): value is ReplayEventTypeFilter {
  return value === 'create' || value === 'update' || value === 'transition';
}

function toNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return String(value);
}
