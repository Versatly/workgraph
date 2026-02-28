/**
 * Deterministic context lenses for fast, runtime-agnostic orientation.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as dispatch from './dispatch.js';
import * as ledger from './ledger.js';
import * as store from './store.js';
import * as thread from './thread.js';
import type {
  DispatchRun,
  PrimitiveInstance,
  WorkgraphLensDescriptor,
  WorkgraphLensId,
  WorkgraphLensItem,
  WorkgraphLensOptions,
  WorkgraphLensResult,
  WorkgraphLensSection,
  WorkgraphMaterializeLensOptions,
  WorkgraphMaterializedLensResult,
} from './types.js';

const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_STALE_HOURS = 24;
const DEFAULT_LIMIT = 10;
const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};
const HIGH_RISK_PRIORITIES = new Set(['urgent', 'high']);
const HIGH_RISK_SEVERITIES = new Set(['sev0', 'sev1', 'sev2']);

const BUILT_IN_LENSES: WorkgraphLensDescriptor[] = [
  {
    id: 'my-work',
    description: 'Actor workload, blockers, stale claims, and ready-next queue',
  },
  {
    id: 'team-risk',
    description: 'High-risk blockers, stale active claims, failed runs, and incidents',
  },
  {
    id: 'customer-health',
    description: 'Customer-tagged delivery health, blockers, and related incidents',
  },
  {
    id: 'exec-brief',
    description: 'Top priorities, momentum, risks, and recent decisions',
  },
];

export function listContextLenses(): WorkgraphLensDescriptor[] {
  return BUILT_IN_LENSES.map((lens) => ({ ...lens }));
}

export function generateContextLens(
  workspacePath: string,
  lensId: WorkgraphLensId | string,
  options: WorkgraphLensOptions = {},
): WorkgraphLensResult {
  const normalizedLensId = normalizeLensId(lensId);
  const normalizedOptions = normalizeLensOptions(options);
  switch (normalizedLensId) {
    case 'my-work':
      return buildMyWorkLens(workspacePath, normalizedOptions);
    case 'team-risk':
      return buildTeamRiskLens(workspacePath, normalizedOptions);
    case 'customer-health':
      return buildCustomerHealthLens(workspacePath, normalizedOptions);
    case 'exec-brief':
      return buildExecBriefLens(workspacePath, normalizedOptions);
    default:
      return assertNever(normalizedLensId);
  }
}

export function materializeContextLens(
  workspacePath: string,
  lensId: WorkgraphLensId | string,
  options: WorkgraphMaterializeLensOptions,
): WorkgraphMaterializedLensResult {
  const result = generateContextLens(workspacePath, lensId, options);
  const absOutputPath = resolvePathWithinWorkspace(workspacePath, options.outputPath);
  const relOutputPath = path.relative(workspacePath, absOutputPath).replace(/\\/g, '/');
  const parentDir = path.dirname(absOutputPath);
  if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
  const existed = fs.existsSync(absOutputPath);
  fs.writeFileSync(absOutputPath, result.markdown, 'utf-8');
  ledger.append(
    workspacePath,
    options.actor ?? result.actor ?? 'system',
    existed ? 'update' : 'create',
    relOutputPath,
    'lens',
    {
      lens: result.lens,
      sections: result.sections.length,
    },
  );
  return {
    ...result,
    outputPath: relOutputPath,
    created: !existed,
  };
}

function buildMyWorkLens(workspacePath: string, options: NormalizedLensOptions): WorkgraphLensResult {
  const actor = options.actor;
  const nowMs = Date.now();
  const staleCutoffMs = nowMs - (options.staleHours * 60 * 60 * 1000);
  const claims = [...ledger.allClaims(workspacePath).entries()];
  const myClaimedThreads = claims
    .filter(([, owner]) => owner === actor)
    .map(([target]) => store.read(workspacePath, target))
    .filter((instance): instance is PrimitiveInstance => !!instance && instance.type === 'thread')
    .sort(compareThreadsByPriorityThenUpdated);
  const myBlockedThreads = myClaimedThreads
    .filter((instance) => String(instance.fields.status ?? '') === 'blocked')
    .slice(0, options.limit);
  const staleClaims = myClaimedThreads
    .filter((instance) => isStale(instance, staleCutoffMs))
    .slice(0, options.limit);
  const nextReady = thread.listReadyThreads(workspacePath)
    .filter((instance) => !instance.fields.owner)
    .sort(compareThreadsByPriorityThenUpdated)
    .slice(0, options.limit);

  const sections: WorkgraphLensSection[] = [
    {
      id: 'my_claims',
      title: `Claimed Threads (${actor})`,
      items: myClaimedThreads.slice(0, options.limit).map((instance) => toThreadItem(instance, nowMs)),
    },
    {
      id: 'my_blockers',
      title: `Blocked Threads (${actor})`,
      items: myBlockedThreads.map((instance) => toThreadItem(instance, nowMs)),
    },
    {
      id: 'stale_claims',
      title: `Stale Claims (${options.staleHours}h+)`,
      items: staleClaims.map((instance) => toThreadItem(instance, nowMs)),
    },
    {
      id: 'next_ready',
      title: 'Next Ready Threads',
      items: nextReady.map((instance) => toThreadItem(instance, nowMs)),
    },
  ];

  return finalizeLensResult('my-work', {
    actor,
    options,
    metrics: {
      myClaims: myClaimedThreads.length,
      blocked: myBlockedThreads.length,
      staleClaims: staleClaims.length,
      nextReady: nextReady.length,
    },
    sections,
  });
}

function buildTeamRiskLens(workspacePath: string, options: NormalizedLensOptions): WorkgraphLensResult {
  const nowMs = Date.now();
  const staleCutoffMs = nowMs - (options.staleHours * 60 * 60 * 1000);
  const lookbackCutoffMs = nowMs - (options.lookbackHours * 60 * 60 * 1000);
  const threads = store.list(workspacePath, 'thread');
  const blockedHighPriority = threads
    .filter((instance) => String(instance.fields.status ?? '') === 'blocked')
    .filter((instance) => HIGH_RISK_PRIORITIES.has(normalizePriority(instance.fields.priority)))
    .sort(compareThreadsByPriorityThenUpdated)
    .slice(0, options.limit);
  const staleActiveClaims = [...ledger.allClaims(workspacePath).entries()]
    .map(([target, owner]) => ({ owner, instance: store.read(workspacePath, target) }))
    .filter((entry): entry is { owner: string; instance: PrimitiveInstance } => !!entry.instance && entry.instance.type === 'thread')
    .filter((entry) => String(entry.instance.fields.status ?? '') === 'active')
    .filter((entry) => isStale(entry.instance, staleCutoffMs))
    .slice(0, options.limit);
  const failedRuns = dispatch.listRuns(workspacePath, { status: 'failed' })
    .filter((run) => parseTimestamp(run.updatedAt) >= lookbackCutoffMs)
    .slice(0, options.limit);
  const highSeverityIncidents = store.list(workspacePath, 'incident')
    .filter((incident) => String(incident.fields.status ?? '') === 'active')
    .filter((incident) => HIGH_RISK_SEVERITIES.has(normalizeSeverity(incident.fields.severity)))
    .slice(0, options.limit);

  const sections: WorkgraphLensSection[] = [
    {
      id: 'blocked_high_priority_threads',
      title: 'High Priority Blocked Threads',
      items: blockedHighPriority.map((instance) => toThreadItem(instance, nowMs)),
    },
    {
      id: 'stale_active_claims',
      title: `Stale Active Claims (${options.staleHours}h+)`,
      items: staleActiveClaims.map((entry) => ({
        ...toThreadItem(entry.instance, nowMs),
        owner: entry.owner,
      })),
    },
    {
      id: 'failed_runs',
      title: `Failed Runs (${options.lookbackHours}h window)`,
      items: failedRuns.map(toRunItem),
    },
    {
      id: 'active_high_severity_incidents',
      title: 'Active High-Severity Incidents',
      items: highSeverityIncidents.map((incident) => toIncidentItem(incident, nowMs)),
    },
  ];

  return finalizeLensResult('team-risk', {
    actor: options.actor,
    options,
    metrics: {
      blockedHighPriority: blockedHighPriority.length,
      staleActiveClaims: staleActiveClaims.length,
      failedRuns: failedRuns.length,
      activeHighSeverityIncidents: highSeverityIncidents.length,
    },
    sections,
  });
}

function buildCustomerHealthLens(workspacePath: string, options: NormalizedLensOptions): WorkgraphLensResult {
  const nowMs = Date.now();
  const customerThreads = store.list(workspacePath, 'thread')
    .filter(isCustomerLinked)
    .sort(compareThreadsByPriorityThenUpdated);
  const activeCustomerThreads = customerThreads
    .filter((instance) => ['open', 'active'].includes(String(instance.fields.status ?? '')))
    .slice(0, options.limit);
  const blockedCustomerThreads = customerThreads
    .filter((instance) => String(instance.fields.status ?? '') === 'blocked')
    .slice(0, options.limit);
  const customerIncidents = store.list(workspacePath, 'incident')
    .filter((incident) => String(incident.fields.status ?? '') === 'active')
    .filter(isCustomerLinked)
    .slice(0, options.limit);
  const clients = store.list(workspacePath, 'client').slice(0, options.limit);

  const sections: WorkgraphLensSection[] = [
    {
      id: 'active_customer_threads',
      title: 'Active Customer Threads',
      items: activeCustomerThreads.map((instance) => toThreadItem(instance, nowMs)),
    },
    {
      id: 'blocked_customer_threads',
      title: 'Blocked Customer Threads',
      items: blockedCustomerThreads.map((instance) => toThreadItem(instance, nowMs)),
    },
    {
      id: 'customer_incidents',
      title: 'Customer Incidents',
      items: customerIncidents.map((incident) => toIncidentItem(incident, nowMs)),
    },
    {
      id: 'client_records',
      title: 'Client Records',
      items: clients.map((instance) => ({
        title: String(instance.fields.title ?? instance.path),
        path: instance.path,
        status: stringOrUndefined(instance.fields.status),
        detail: stringOrUndefined(instance.fields.health ?? instance.fields.risk),
        ageHours: ageHours(instance, nowMs),
      })),
    },
  ];

  return finalizeLensResult('customer-health', {
    actor: options.actor,
    options,
    metrics: {
      activeCustomerThreads: activeCustomerThreads.length,
      blockedCustomerThreads: blockedCustomerThreads.length,
      customerIncidents: customerIncidents.length,
      clients: clients.length,
    },
    sections,
  });
}

function buildExecBriefLens(workspacePath: string, options: NormalizedLensOptions): WorkgraphLensResult {
  const nowMs = Date.now();
  const lookbackCutoffMs = nowMs - (options.lookbackHours * 60 * 60 * 1000);
  const threads = store.list(workspacePath, 'thread');
  const topPriorities = threads
    .filter((instance) => ['open', 'active'].includes(String(instance.fields.status ?? '')))
    .sort(compareThreadsByPriorityThenUpdated)
    .slice(0, options.limit);
  const momentum = threads
    .filter((instance) => String(instance.fields.status ?? '') === 'done')
    .filter((instance) => parseTimestamp(instance.fields.updated) >= lookbackCutoffMs)
    .sort(compareThreadsByPriorityThenUpdated)
    .slice(0, options.limit);
  const blockedHighPriority = threads
    .filter((instance) => String(instance.fields.status ?? '') === 'blocked')
    .filter((instance) => HIGH_RISK_PRIORITIES.has(normalizePriority(instance.fields.priority)))
    .sort(compareThreadsByPriorityThenUpdated)
    .slice(0, options.limit);
  const failedRuns = dispatch.listRuns(workspacePath, { status: 'failed' })
    .filter((run) => parseTimestamp(run.updatedAt) >= lookbackCutoffMs)
    .slice(0, options.limit);
  const decisions = store.list(workspacePath, 'decision')
    .filter((instance) => ['proposed', 'approved', 'active'].includes(String(instance.fields.status ?? '')))
    .filter((instance) => parseTimestamp(instance.fields.updated ?? instance.fields.date) >= lookbackCutoffMs)
    .slice(0, options.limit);

  const sections: WorkgraphLensSection[] = [
    {
      id: 'top_priorities',
      title: 'Top Priorities',
      items: topPriorities.map((instance) => toThreadItem(instance, nowMs)),
    },
    {
      id: 'momentum',
      title: `Momentum (${options.lookbackHours}h completed)`,
      items: momentum.map((instance) => toThreadItem(instance, nowMs)),
    },
    {
      id: 'key_risks',
      title: 'Key Risks',
      items: [
        ...blockedHighPriority.map((instance) => toThreadItem(instance, nowMs)),
        ...failedRuns.map(toRunItem),
      ].slice(0, options.limit),
    },
    {
      id: 'recent_decisions',
      title: `Decisions (${options.lookbackHours}h window)`,
      items: decisions.map((instance) => ({
        title: String(instance.fields.title ?? instance.path),
        path: instance.path,
        status: stringOrUndefined(instance.fields.status),
        detail: stringOrUndefined(instance.fields.date),
        ageHours: ageHours(instance, nowMs),
      })),
    },
  ];

  return finalizeLensResult('exec-brief', {
    actor: options.actor,
    options,
    metrics: {
      topPriorities: topPriorities.length,
      momentumDone: momentum.length,
      risks: blockedHighPriority.length + failedRuns.length,
      decisions: decisions.length,
    },
    sections,
  });
}

function finalizeLensResult(
  lens: WorkgraphLensId,
  input: {
    actor?: string;
    options: NormalizedLensOptions;
    metrics: Record<string, number>;
    sections: WorkgraphLensSection[];
  },
): WorkgraphLensResult {
  const base = {
    lens,
    generatedAt: new Date().toISOString(),
    actor: input.actor,
    options: {
      lookbackHours: input.options.lookbackHours,
      staleHours: input.options.staleHours,
      limit: input.options.limit,
    },
    metrics: input.metrics,
    sections: input.sections,
  };
  return {
    ...base,
    markdown: renderLensMarkdown(base),
  };
}

function toThreadItem(instance: PrimitiveInstance, nowMs: number): WorkgraphLensItem {
  return {
    title: String(instance.fields.title ?? instance.path),
    path: instance.path,
    status: stringOrUndefined(instance.fields.status),
    priority: stringOrUndefined(instance.fields.priority),
    owner: stringOrUndefined(instance.fields.owner),
    detail: renderThreadDependencies(instance),
    ageHours: ageHours(instance, nowMs),
  };
}

function toIncidentItem(instance: PrimitiveInstance, nowMs: number): WorkgraphLensItem {
  return {
    title: String(instance.fields.title ?? instance.path),
    path: instance.path,
    status: stringOrUndefined(instance.fields.status),
    priority: stringOrUndefined(instance.fields.severity),
    owner: stringOrUndefined(instance.fields.owner),
    ageHours: ageHours(instance, nowMs),
  };
}

function toRunItem(run: DispatchRun): WorkgraphLensItem {
  return {
    title: run.objective,
    path: `runs/${run.id}.md`,
    status: run.status,
    owner: run.actor,
    detail: run.error ?? run.output,
    ageHours: ageHoursFromIso(run.updatedAt),
  };
}

function renderLensMarkdown(input: Omit<WorkgraphLensResult, 'markdown'>): string {
  const lines: string[] = [
    `# Workgraph Context Lens: ${input.lens}`,
    '',
    `Generated: ${input.generatedAt}`,
    ...(input.actor ? [`Actor: ${input.actor}`] : []),
    `Lookback: ${input.options.lookbackHours}h`,
    `Stale threshold: ${input.options.staleHours}h`,
    `Section limit: ${input.options.limit}`,
    '',
    '## Metrics',
    '',
    ...Object.entries(input.metrics).map(([metric, value]) => `- ${metric}: ${value}`),
    '',
  ];

  for (const section of input.sections) {
    lines.push(`## ${section.title}`);
    lines.push('');
    if (section.items.length === 0) {
      lines.push('- None');
      lines.push('');
      continue;
    }
    for (const item of section.items) {
      lines.push(`- ${renderLensItem(item)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function renderLensItem(item: WorkgraphLensItem): string {
  const components: string[] = [item.title];
  if (item.path) components.push(`(\`${item.path}\`)`);
  const metadata: string[] = [];
  if (item.status) metadata.push(`status=${item.status}`);
  if (item.priority) metadata.push(`priority=${item.priority}`);
  if (item.owner) metadata.push(`owner=${item.owner}`);
  if (typeof item.ageHours === 'number') metadata.push(`age=${item.ageHours.toFixed(1)}h`);
  if (metadata.length > 0) components.push(`[${metadata.join(', ')}]`);
  if (item.detail) components.push(`- ${item.detail}`);
  return components.join(' ');
}

function resolvePathWithinWorkspace(workspacePath: string, outputPath: string): string {
  const base = path.resolve(workspacePath);
  const resolved = path.resolve(base, outputPath);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error(`Invalid lens output path: ${outputPath}`);
  }
  return resolved;
}

function normalizeLensId(value: WorkgraphLensId | string): WorkgraphLensId {
  const normalized = String(value).trim().toLowerCase().replace(/^lens:\/\//, '');
  if (normalized === 'my-work') return 'my-work';
  if (normalized === 'team-risk') return 'team-risk';
  if (normalized === 'customer-health') return 'customer-health';
  if (normalized === 'exec-brief') return 'exec-brief';
  const valid = BUILT_IN_LENSES.map((item) => item.id).join(', ');
  throw new Error(`Unknown context lens "${value}". Valid lenses: ${valid}`);
}

interface NormalizedLensOptions {
  actor: string;
  lookbackHours: number;
  staleHours: number;
  limit: number;
}

function normalizeLensOptions(options: WorkgraphLensOptions): NormalizedLensOptions {
  return {
    actor: String(options.actor ?? 'anonymous').trim() || 'anonymous',
    lookbackHours: parsePositiveNumber(options.lookbackHours, 'lookbackHours', DEFAULT_LOOKBACK_HOURS),
    staleHours: parsePositiveNumber(options.staleHours, 'staleHours', DEFAULT_STALE_HOURS),
    limit: parsePositiveInteger(options.limit, 'limit', DEFAULT_LIMIT),
  };
}

function parsePositiveNumber(value: unknown, fieldName: string, defaultValue: number): number {
  if (value === undefined || value === null) return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${fieldName}: expected a positive number.`);
  }
  return parsed;
}

function parsePositiveInteger(value: unknown, fieldName: string, defaultValue: number): number {
  if (value === undefined || value === null) return defaultValue;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${fieldName}: expected a positive integer.`);
  }
  return parsed;
}

function compareThreadsByPriorityThenUpdated(a: PrimitiveInstance, b: PrimitiveInstance): number {
  const priorityDelta = rankPriority(a) - rankPriority(b);
  if (priorityDelta !== 0) return priorityDelta;
  return parseTimestamp(b.fields.updated) - parseTimestamp(a.fields.updated);
}

function rankPriority(instance: PrimitiveInstance): number {
  const priority = normalizePriority(instance.fields.priority);
  return PRIORITY_ORDER[priority] ?? PRIORITY_ORDER.medium;
}

function normalizePriority(value: unknown): string {
  return String(value ?? 'medium').trim().toLowerCase();
}

function normalizeSeverity(value: unknown): string {
  return String(value ?? 'sev4').trim().toLowerCase();
}

function isStale(instance: PrimitiveInstance, staleCutoffMs: number): boolean {
  const updatedAt = parseTimestamp(instance.fields.updated ?? instance.fields.created);
  if (!Number.isFinite(updatedAt)) return false;
  return updatedAt <= staleCutoffMs;
}

function parseTimestamp(value: unknown): number {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function ageHours(instance: PrimitiveInstance, nowMs: number): number | undefined {
  const updatedAt = parseTimestamp(instance.fields.updated ?? instance.fields.created);
  if (!Number.isFinite(updatedAt)) return undefined;
  return Math.max(0, (nowMs - updatedAt) / (60 * 60 * 1000));
}

function ageHoursFromIso(value: string): number | undefined {
  const nowMs = Date.now();
  const ts = parseTimestamp(value);
  if (!Number.isFinite(ts)) return undefined;
  return Math.max(0, (nowMs - ts) / (60 * 60 * 1000));
}

function renderThreadDependencies(instance: PrimitiveInstance): string | undefined {
  const deps = instance.fields.deps;
  if (!Array.isArray(deps) || deps.length === 0) return undefined;
  const visible = deps.slice(0, 3).map((value) => String(value));
  const suffix = deps.length > visible.length ? ` +${deps.length - visible.length} more` : '';
  return `deps: ${visible.join(', ')}${suffix}`;
}

function isCustomerLinked(instance: PrimitiveInstance): boolean {
  const tags = normalizeTags(instance.fields.tags);
  if (tags.includes('customer') || tags.includes('client')) return true;
  const candidateFields = ['client', 'client_ref', 'customer', 'customer_ref', 'account', 'account_ref'];
  return candidateFields.some((key) => {
    const value = instance.fields[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item).trim().toLowerCase())
    .filter(Boolean);
}

function stringOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : undefined;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled lens variant: ${String(value)}`);
}
