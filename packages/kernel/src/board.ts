/**
 * Obsidian Kanban board generation and sync helpers.
 */

import path from 'node:path';
import fs from './storage-fs.js';
import * as store from './store.js';
import type { PrimitiveInstance } from './types.js';

export interface BoardOptions {
  outputPath?: string;
  includeCancelled?: boolean;
}

export interface BoardResult {
  outputPath: string;
  generatedAt: string;
  counts: {
    backlog: number;
    inProgress: number;
    blocked: number;
    done: number;
    cancelled: number;
  };
  content: string;
}

export function generateKanbanBoard(workspacePath: string, options: BoardOptions = {}): BoardResult {
  const threads = store.list(workspacePath, 'thread');
  const grouped = groupThreads(threads);
  const includeCancelled = options.includeCancelled === true;

  const lanes: Array<{ title: string; items: PrimitiveInstance[]; checkChar: string }> = [
    { title: 'Backlog', items: grouped.open, checkChar: ' ' },
    { title: 'In Progress', items: grouped.active, checkChar: ' ' },
    { title: 'Blocked', items: grouped.blocked, checkChar: ' ' },
    { title: 'Done', items: grouped.done, checkChar: 'x' },
  ];
  if (includeCancelled) {
    lanes.push({ title: 'Cancelled', items: grouped.cancelled, checkChar: 'x' });
  }

  const content = renderKanbanMarkdown(lanes);
  const relOutputPath = options.outputPath ?? 'ops/Workgraph Board.md';
  const absOutputPath = resolvePathWithinWorkspace(workspacePath, relOutputPath);
  const parentDir = path.dirname(absOutputPath);
  if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(absOutputPath, content, 'utf-8');

  return {
    outputPath: path.relative(workspacePath, absOutputPath).replace(/\\/g, '/'),
    generatedAt: new Date().toISOString(),
    counts: {
      backlog: grouped.open.length,
      inProgress: grouped.active.length,
      blocked: grouped.blocked.length,
      done: grouped.done.length,
      cancelled: grouped.cancelled.length,
    },
    content,
  };
}

export function syncKanbanBoard(workspacePath: string, options: BoardOptions = {}): BoardResult {
  return generateKanbanBoard(workspacePath, options);
}

function groupThreads(threads: PrimitiveInstance[]): Record<'open' | 'active' | 'blocked' | 'done' | 'cancelled', PrimitiveInstance[]> {
  const groups = {
    open: [] as PrimitiveInstance[],
    active: [] as PrimitiveInstance[],
    blocked: [] as PrimitiveInstance[],
    done: [] as PrimitiveInstance[],
    cancelled: [] as PrimitiveInstance[],
  };

  for (const thread of threads) {
    const status = String(thread.fields.status ?? 'open');
    switch (status) {
      case 'active':
        groups.active.push(thread);
        break;
      case 'blocked':
        groups.blocked.push(thread);
        break;
      case 'done':
        groups.done.push(thread);
        break;
      case 'cancelled':
        groups.cancelled.push(thread);
        break;
      case 'open':
      default:
        groups.open.push(thread);
        break;
    }
  }

  const byPriority = (a: PrimitiveInstance, b: PrimitiveInstance): number => {
    const rank = (value: unknown): number => {
      switch (String(value ?? 'medium')) {
        case 'urgent': return 0;
        case 'high': return 1;
        case 'medium': return 2;
        case 'low': return 3;
        default: return 4;
      }
    };
    return rank(a.fields.priority) - rank(b.fields.priority) || String(a.fields.title).localeCompare(String(b.fields.title));
  };

  groups.open.sort(byPriority);
  groups.active.sort(byPriority);
  groups.blocked.sort(byPriority);
  groups.done.sort(byPriority);
  groups.cancelled.sort(byPriority);
  return groups;
}

function renderKanbanMarkdown(lanes: Array<{ title: string; items: PrimitiveInstance[]; checkChar: string }>): string {
  const settings = {
    'kanban-plugin': 'board',
  };
  const lines: string[] = [
    '---',
    'kanban-plugin: board',
    '---',
    '',
  ];

  for (const lane of lanes) {
    lines.push(`## ${lane.title}`);
    lines.push('');
    for (const thread of lane.items) {
      const title = String(thread.fields.title ?? thread.path);
      const priority = String(thread.fields.priority ?? 'medium');
      lines.push(`- [${lane.checkChar}] [[${thread.path}|${title}]] (#${priority})`);
    }
    lines.push('');
    lines.push('');
    lines.push('');
  }

  lines.push('%% kanban:settings');
  lines.push('```');
  lines.push(JSON.stringify(settings));
  lines.push('```');
  lines.push('%%');
  lines.push('');
  return lines.join('\n');
}

function resolvePathWithinWorkspace(workspacePath: string, outputPath: string): string {
  const base = path.resolve(workspacePath);
  const resolved = path.resolve(base, outputPath);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error(`Invalid board output path: ${outputPath}`);
  }
  return resolved;
}
