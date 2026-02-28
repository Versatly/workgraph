import * as ledger from '../ledger.js';
import type { LedgerEntry } from '../types.js';
import { inferPrimitiveTypeFromPath, parseDateToTimestamp } from './format.js';

export interface ChangelogOptions {
  since: string;
  until?: string;
}

export interface ChangelogItem {
  ts: string;
  actor: string;
  op: string;
  target: string;
  summary?: string;
}

export interface ChangelogTypeGroup {
  primitiveType: string;
  items: ChangelogItem[];
}

export interface ChangelogDayGroup {
  day: string;
  created: ChangelogTypeGroup[];
  updated: ChangelogTypeGroup[];
  completed: ChangelogTypeGroup[];
}

export interface ChangelogReport {
  generatedAt: string;
  workspacePath: string;
  since: string;
  until?: string;
  totalEvents: number;
  days: ChangelogDayGroup[];
}

type ChangelogAction = 'created' | 'updated' | 'completed';

export function generateLedgerChangelog(workspacePath: string, options: ChangelogOptions): ChangelogReport {
  const sinceTs = parseDateToTimestamp(options.since, '--since');
  const untilTs = options.until ? parseDateToTimestamp(options.until, '--until') : null;
  const allEntries = ledger.readAll(workspacePath);

  const grouped = new Map<string, Record<ChangelogAction, Map<string, ChangelogItem[]>>>();
  let matchedEventCount = 0;
  for (const entry of allEntries) {
    const eventTs = Date.parse(entry.ts);
    if (!Number.isFinite(eventTs)) continue;
    if (eventTs < sinceTs) continue;
    if (untilTs !== null && eventTs > untilTs) continue;

    const action = categorizeEntry(entry);
    if (!action) continue;
    matchedEventCount += 1;

    const day = entry.ts.slice(0, 10);
    const primitiveType = entry.type ?? inferPrimitiveTypeFromPath(entry.target) ?? 'unknown';
    const dayGroup = grouped.get(day) ?? {
      created: new Map<string, ChangelogItem[]>(),
      updated: new Map<string, ChangelogItem[]>(),
      completed: new Map<string, ChangelogItem[]>(),
    };
    const byType = dayGroup[action];
    const items = byType.get(primitiveType) ?? [];
    items.push({
      ts: entry.ts,
      actor: entry.actor,
      op: entry.op,
      target: entry.target,
      summary: buildEntrySummary(entry),
    });
    byType.set(primitiveType, items);
    grouped.set(day, dayGroup);
  }

  const days = [...grouped.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, dayGroup]) => ({
      day,
      created: normalizeTypeGroups(dayGroup.created),
      updated: normalizeTypeGroups(dayGroup.updated),
      completed: normalizeTypeGroups(dayGroup.completed),
    }));

  return {
    generatedAt: new Date().toISOString(),
    workspacePath,
    since: options.since,
    ...(options.until ? { until: options.until } : {}),
    totalEvents: matchedEventCount,
    days,
  };
}

export function renderChangelogText(report: ChangelogReport): string[] {
  if (report.days.length === 0) {
    return [`No changelog activity found since ${report.since}.`];
  }

  const lines: string[] = [];
  lines.push(`Changelog since ${report.since}${report.until ? ` until ${report.until}` : ''}`);
  lines.push('');

  for (const day of report.days) {
    lines.push(`${day.day}`);
    lines.push(...renderActionGroup('Created', day.created));
    lines.push(...renderActionGroup('Updated', day.updated));
    lines.push(...renderActionGroup('Completed', day.completed));
    lines.push('');
  }
  return lines;
}

function renderActionGroup(title: string, groups: ChangelogTypeGroup[]): string[] {
  if (groups.length === 0) {
    return [`  ${title}: none`];
  }
  const lines: string[] = [`  ${title}:`];
  for (const group of groups) {
    lines.push(`    - ${group.primitiveType}:`);
    for (const item of group.items) {
      const time = item.ts.slice(11, 19);
      const summarySuffix = item.summary ? ` — ${item.summary}` : '';
      lines.push(`      - [${time}] ${item.target} (${item.actor})${summarySuffix}`);
    }
  }
  return lines;
}

function normalizeTypeGroups(byType: Map<string, ChangelogItem[]>): ChangelogTypeGroup[] {
  return [...byType.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([primitiveType, items]) => ({
      primitiveType,
      items: items.slice().sort((a, b) => a.ts.localeCompare(b.ts) || a.target.localeCompare(b.target)),
    }));
}

function categorizeEntry(entry: LedgerEntry): ChangelogAction | null {
  if (entry.op === 'create') return 'created';
  if (entry.op === 'done') return 'completed';
  if (entry.op === 'update') {
    const toStatus = String(entry.data?.to_status ?? '');
    if (isCompletedStatus(toStatus)) return 'completed';
    return 'updated';
  }
  return null;
}

function isCompletedStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return normalized === 'done' || normalized === 'succeeded' || normalized === 'completed' || normalized === 'closed';
}

function buildEntrySummary(entry: LedgerEntry): string | undefined {
  if (entry.op === 'create') {
    return entry.data?.title ? `title: ${String(entry.data.title)}` : undefined;
  }
  if (entry.op === 'update') {
    const changed = Array.isArray(entry.data?.changed) ? entry.data?.changed.map((value) => String(value)) : [];
    if (changed.length > 0) return `changed: ${changed.join(', ')}`;
    if (entry.data?.to_status) return `status: ${String(entry.data?.to_status)}`;
    return undefined;
  }
  if (entry.op === 'done' && entry.data?.output) {
    return `output: ${String(entry.data.output)}`;
  }
  return undefined;
}
