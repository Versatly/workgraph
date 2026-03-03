/**
 * Command center generator for human + agent operational visibility.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as ledger from './ledger.js';
import * as store from './store.js';

export interface CommandCenterOptions {
  outputPath?: string;
  actor?: string;
  recentCount?: number;
}

export interface CommandCenterResult {
  outputPath: string;
  stats: {
    totalThreads: number;
    openThreads: number;
    activeThreads: number;
    blockedThreads: number;
    doneThreads: number;
    activeClaims: number;
    recentEvents: number;
  };
  content: string;
}

export function generateCommandCenter(workspacePath: string, options: CommandCenterOptions = {}): CommandCenterResult {
  const actor = options.actor ?? 'system';
  const recentCount = options.recentCount ?? 15;
  const relOutputPath = options.outputPath ?? 'Command Center.md';
  const absOutputPath = resolvePathWithinWorkspace(workspacePath, relOutputPath);
  const normalizedOutputPath = path.relative(workspacePath, absOutputPath).replace(/\\/g, '/');

  const allThreads = store.list(workspacePath, 'thread');
  const openThreads = allThreads.filter(thread => thread.fields.status === 'open');
  const activeThreads = allThreads.filter(thread => thread.fields.status === 'active');
  const blockedThreads = allThreads.filter(thread => thread.fields.status === 'blocked');
  const doneThreads = allThreads.filter(thread => thread.fields.status === 'done');
  const claims = ledger.allClaims(workspacePath);
  const recentEvents = ledger.recent(workspacePath, recentCount);

  const content = renderCommandCenter({
    generatedAt: new Date().toISOString(),
    openThreads,
    activeThreads,
    blockedThreads,
    doneThreads,
    claims: [...claims.entries()].map(([target, owner]) => ({ target, owner })),
    recentEvents,
  });

  const parentDir = path.dirname(absOutputPath);
  if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
  const existed = fs.existsSync(absOutputPath);
  fs.writeFileSync(absOutputPath, content, 'utf-8');

  ledger.append(
    workspacePath,
    actor,
    existed ? 'update' : 'create',
    normalizedOutputPath,
    'command-center',
    {
      generated: true,
      open_threads: openThreads.length,
      active_claims: claims.size,
      recent_events: recentEvents.length,
    }
  );

  return {
    outputPath: normalizedOutputPath,
    stats: {
      totalThreads: allThreads.length,
      openThreads: openThreads.length,
      activeThreads: activeThreads.length,
      blockedThreads: blockedThreads.length,
      doneThreads: doneThreads.length,
      activeClaims: claims.size,
      recentEvents: recentEvents.length,
    },
    content,
  };
}

function resolvePathWithinWorkspace(workspacePath: string, outputPath: string): string {
  const base = path.resolve(workspacePath);
  const resolved = path.resolve(base, outputPath);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error(`Invalid command-center output path: ${outputPath}`);
  }
  return resolved;
}

function renderCommandCenter(input: {
  generatedAt: string;
  openThreads: Array<{ path: string; fields: Record<string, unknown> }>;
  activeThreads: Array<{ path: string; fields: Record<string, unknown> }>;
  blockedThreads: Array<{ path: string; fields: Record<string, unknown> }>;
  doneThreads: Array<{ path: string; fields: Record<string, unknown> }>;
  claims: Array<{ target: string; owner: string }>;
  recentEvents: Array<{ ts: string; op: string; actor: string; target: string }>;
}): string {
  const header = [
    '# Workgraph Command Center',
    '',
    `Generated: ${input.generatedAt}`,
    '',
  ];

  const statusBlock = [
    '## Thread Status',
    '',
    `- Open: ${input.openThreads.length}`,
    `- Active: ${input.activeThreads.length}`,
    `- Blocked: ${input.blockedThreads.length}`,
    `- Done: ${input.doneThreads.length}`,
    '',
  ];

  const openTable = [
    '## Open Threads',
    '',
    '| Priority | Title | Path |',
    '|---|---|---|',
    ...(input.openThreads.length > 0
      ? input.openThreads.map(thread =>
          `| ${String(thread.fields.priority ?? 'medium')} | ${String(thread.fields.title ?? 'Untitled')} | \`${thread.path}\` |`)
      : ['| - | None | - |']),
    '',
  ];

  const claimsSection = [
    '## Active Claims',
    '',
    ...(input.claims.length > 0
      ? input.claims.map(claim => `- ${claim.owner} -> \`${claim.target}\``)
      : ['- None']),
    '',
  ];

  const blockedSection = [
    '## Blocked Threads',
    '',
    ...(input.blockedThreads.length > 0
      ? input.blockedThreads.map(thread => {
          const deps = Array.isArray(thread.fields.deps) ? thread.fields.deps.join(', ') : '';
          return `- ${String(thread.fields.title ?? thread.path)} (\`${thread.path}\`)${deps ? ` blocked by: ${deps}` : ''}`;
        })
      : ['- None']),
    '',
  ];

  const recentSection = [
    '## Recent Ledger Activity',
    '',
    ...(input.recentEvents.length > 0
      ? input.recentEvents.map(event => `- ${event.ts} ${event.op} ${event.actor} -> \`${event.target}\``)
      : ['- No activity']),
    '',
  ];

  return [
    ...header,
    ...statusBlock,
    ...openTable,
    ...claimsSection,
    ...blockedSection,
    ...recentSection,
  ].join('\n');
}
