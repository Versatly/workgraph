import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRegistry, saveRegistry } from './registry.js';
import * as thread from './thread.js';
import * as threadContext from './thread-context.js';

let workspacePath: string;
let threadPath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-thread-context-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
  threadPath = thread.createThread(
    workspacePath,
    'Thread Context Fixture',
    'Validate thread context operations',
    'agent-seed',
  ).path;
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('thread context store', () => {
  it('adds entries and lists metadata/content', () => {
    const first = threadContext.addThreadContextEntry(workspacePath, threadPath, {
      title: 'Architecture note',
      content: 'We should keep context local to a thread for retrieval.',
      source: 'adr-001',
      addedBy: 'agent-a',
      relevanceScore: 0.9,
    });
    const second = threadContext.addThreadContextEntry(workspacePath, threadPath, {
      title: 'Research snippet',
      content: 'BM25 ranking is robust for keyword retrieval tasks.',
      addedBy: 'agent-b',
      relevanceScore: 0.4,
    });

    expect(first.path).toContain('.workgraph/thread-context/thread-context-fixture/context/');
    expect(second.path).toContain('.workgraph/thread-context/thread-context-fixture/context/');

    const listed = threadContext.listThreadContextEntries(workspacePath, threadPath);
    expect(listed).toHaveLength(2);
    expect(listed[0].title).toBe('Architecture note');
    expect(listed[0].source).toBe('adr-001');
    expect(listed[1].title).toBe('Research snippet');
  });

  it('searches entries with BM25 ranking', () => {
    threadContext.addThreadContextEntry(workspacePath, threadPath, {
      title: 'Webhook dedup design',
      content: 'Use payload digest and delivery id dedup in the webhook gateway.',
      addedBy: 'agent-a',
      relevanceScore: 0.8,
    });
    threadContext.addThreadContextEntry(workspacePath, threadPath, {
      title: 'Standalone threads',
      content: 'Add a top-level thread creation tool with idempotency support.',
      addedBy: 'agent-a',
      relevanceScore: 0.6,
    });
    threadContext.addThreadContextEntry(workspacePath, threadPath, {
      title: 'Unrelated note',
      content: 'Color palette and spacing tweaks for dashboard.',
      addedBy: 'agent-a',
      relevanceScore: 0.9,
    });

    const results = threadContext.searchThreadContextEntries(
      workspacePath,
      threadPath,
      'webhook delivery dedup',
      { limit: 2 },
    );

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Webhook dedup design');
    expect(results[0].bm25_score).toBeGreaterThan(0);
    expect(results[0].snippet.toLowerCase()).toContain('dedup');
  });

  it('prunes stale and low relevance entries', () => {
    const stale = threadContext.addThreadContextEntry(workspacePath, threadPath, {
      title: 'Old context',
      content: 'This note is no longer fresh.',
      addedBy: 'agent-a',
      relevanceScore: 0.9,
    });
    const low = threadContext.addThreadContextEntry(workspacePath, threadPath, {
      title: 'Low signal',
      content: 'This entry should be removed by relevance.',
      addedBy: 'agent-a',
      relevanceScore: 0.1,
    });
    const keep = threadContext.addThreadContextEntry(workspacePath, threadPath, {
      title: 'Keep context',
      content: 'High relevance and recent entry.',
      addedBy: 'agent-a',
      relevanceScore: 0.95,
    });

    const staleAbsPath = path.join(workspacePath, stale.path);
    const staleParsed = matter(fs.readFileSync(staleAbsPath, 'utf-8'));
    staleParsed.data.added_at = '2000-01-01T00:00:00.000Z';
    fs.writeFileSync(staleAbsPath, matter.stringify(staleParsed.content, staleParsed.data), 'utf-8');

    const pruned = threadContext.pruneThreadContextEntries(workspacePath, threadPath, {
      maxAgeMinutes: 60,
      minRelevance: 0.5,
      now: new Date('2026-03-11T00:00:00.000Z'),
    });

    expect(pruned.removedCount).toBe(2);
    expect(pruned.keptCount).toBe(1);
    expect(pruned.removed.map((entry) => entry.path).sort()).toEqual([low.path, stale.path].sort());
    const remaining = threadContext.listThreadContextEntries(workspacePath, threadPath);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].path).toBe(keep.path);
  });
});
