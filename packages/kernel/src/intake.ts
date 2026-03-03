import * as store from './store.js';
import { mintThreadId } from './thread.js';
import type { PrimitiveInstance } from './types.js';

export interface ThreadIntakeInput {
  title: string;
  actor: string;
  priority?: string;
  space?: string;
  parent?: string;
}

export function intake(
  workspacePath: string,
  input: ThreadIntakeInput,
): PrimitiveInstance {
  const title = String(input.title ?? '').trim();
  if (!title) {
    throw new Error('Thread intake requires a non-empty title.');
  }
  const actor = String(input.actor ?? '').trim();
  if (!actor) {
    throw new Error('Thread intake requires a non-empty actor.');
  }

  const tid = mintAvailableThreadId(workspacePath, title);
  const normalizedSpace = input.space ? normalizeWorkspaceRef(input.space) : undefined;
  const normalizedParent = input.parent ? normalizeThreadRef(input.parent) : undefined;
  const contextRefs = normalizedSpace ? [normalizedSpace] : [];

  return store.create(
    workspacePath,
    'thread',
    {
      tid,
      title,
      goal: title,
      status: 'open',
      priority: input.priority ?? 'medium',
      deps: [],
      ...(normalizedParent ? { parent: normalizedParent } : {}),
      ...(normalizedSpace ? { space: normalizedSpace } : {}),
      context_refs: contextRefs,
      tags: [],
      terminalLock: true,
    },
    `## Goal\n\n${title}\n`,
    actor,
    {
      pathOverride: `threads/${tid}.md`,
    },
  );
}

function mintAvailableThreadId(workspacePath: string, title: string): string {
  const base = mintThreadId(title) || 'thread';
  const threads = store.list(workspacePath, 'thread');
  const usedIds = new Set(
    threads.map((entry) => String(entry.fields.tid ?? fileSlug(entry.path)).trim()).filter(Boolean),
  );

  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate) || store.read(workspacePath, `threads/${candidate}.md`)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function fileSlug(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/');
  const basename = normalized.split('/').pop() ?? '';
  return basename.endsWith('.md') ? basename.slice(0, -3) : basename;
}

function normalizeThreadRef(value: string): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';
  const unwrapped = trimmed.startsWith('[[') && trimmed.endsWith(']]')
    ? trimmed.slice(2, -2)
    : trimmed;
  const noAnchor = unwrapped.split('|')[0]?.split('#')[0]?.trim() ?? '';
  if (!noAnchor) return '';
  if (noAnchor.includes('/')) {
    return noAnchor.endsWith('.md') ? noAnchor : `${noAnchor}.md`;
  }
  const withPrefix = noAnchor.startsWith('threads/') ? noAnchor : `threads/${noAnchor}`;
  return withPrefix.endsWith('.md') ? withPrefix : `${withPrefix}.md`;
}

function normalizeWorkspaceRef(value: string): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';
  const unwrapped = trimmed.startsWith('[[') && trimmed.endsWith(']]')
    ? trimmed.slice(2, -2)
    : trimmed;
  return unwrapped.endsWith('.md') ? unwrapped : `${unwrapped}.md`;
}
