import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, saveRegistry } from './registry.js';
import * as thread from './thread.js';
import {
  buildCausalDependencyGraph,
  causalDependencies,
  causalDependents,
} from './causal-graph.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-causal-graph-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('causal dependency graph', () => {
  it('builds thread dependency edges from wiki-links in body content', () => {
    const dep = thread.createThread(workspacePath, 'Schema', 'Create schema', 'lead');
    const impl = thread.createThread(
      workspacePath,
      'Implement API',
      `Depends on [[${dep.path.replace(/\.md$/, '')}|schema]] and [[${dep.path}#details]].`,
      'lead',
    );

    const graph = buildCausalDependencyGraph(workspacePath);

    expect(graph.nodes.map((node) => node.path)).toEqual(
      [dep.path, impl.path].sort((a, b) => a.localeCompare(b)),
    );
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({
      from: impl.path,
      to: dep.path,
      source: 'body-wiki-link',
    });
  });

  it('deduplicates repeated wiki-link edges in the same thread', () => {
    const dep = thread.createThread(workspacePath, 'Dep', 'dep', 'lead');
    const parentRef = dep.path.replace(/\.md$/, '');
    thread.createThread(
      workspacePath,
      'Noisy Thread',
      `[[${parentRef}]] [[${parentRef}]] [[${dep.path}|alias]]`,
      'lead',
    );

    const graph = buildCausalDependencyGraph(workspacePath);

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].to).toBe(dep.path);
  });

  it('captures unresolved thread wiki-links as missing references', () => {
    const source = thread.createThread(
      workspacePath,
      'Source',
      'Investigate [[threads/missing-dependency]].',
      'lead',
    );

    const graph = buildCausalDependencyGraph(workspacePath);

    expect(graph.missingReferences).toHaveLength(1);
    expect(graph.missingReferences[0]).toEqual({
      from: source.path,
      rawRef: 'threads/missing-dependency',
      normalizedRef: 'threads/missing-dependency.md',
    });
  });

  it('returns dependency and dependent lookups from the graph', () => {
    const a = thread.createThread(workspacePath, 'A', 'start', 'lead');
    const b = thread.createThread(workspacePath, 'B', `[[${a.path.replace(/\.md$/, '')}]]`, 'lead');
    const c = thread.createThread(workspacePath, 'C', `[[${a.path}]] and [[${b.path}]]`, 'lead');
    const graph = buildCausalDependencyGraph(workspacePath);

    expect(causalDependencies(graph, c.path)).toEqual([a.path, b.path]);
    expect(causalDependents(graph, a.path)).toEqual([b.path, c.path]);
  });

  it('detects cycles in wiki-link dependency chains', () => {
    const a = thread.createThread(workspacePath, 'A', 'ref [[threads/b]]', 'lead');
    const b = thread.createThread(workspacePath, 'B', 'ref [[threads/a]]', 'lead');

    const graph = buildCausalDependencyGraph(workspacePath);

    expect(graph.cycles.length).toBeGreaterThan(0);
    const cycleMembers = new Set(graph.cycles[0]);
    expect(cycleMembers.has(a.path)).toBe(true);
    expect(cycleMembers.has(b.path)).toBe(true);
  });
});
