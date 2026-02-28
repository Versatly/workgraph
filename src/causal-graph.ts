/**
 * Causal dependency graph derived from wiki-links inside thread bodies.
 */

import * as store from './store.js';

export interface CausalGraphNode {
  path: string;
  title: string;
  status: string;
}

export interface CausalGraphEdge {
  from: string;
  to: string;
  source: 'body-wiki-link';
  rawRef: string;
}

export interface CausalGraphMissingReference {
  from: string;
  rawRef: string;
  normalizedRef: string;
}

export interface CausalDependencyGraph {
  generatedAt: string;
  nodes: CausalGraphNode[];
  edges: CausalGraphEdge[];
  missingReferences: CausalGraphMissingReference[];
  roots: string[];
  leaves: string[];
  cycles: string[][];
}

export function buildCausalDependencyGraph(workspacePath: string): CausalDependencyGraph {
  const threads = store
    .list(workspacePath, 'thread')
    .map((thread) => ({
      path: thread.path,
      title: String(thread.fields.title ?? thread.path),
      status: String(thread.fields.status ?? 'open'),
      body: thread.body ?? '',
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const nodePaths = new Set<string>(threads.map((thread) => thread.path));
  const nodes: CausalGraphNode[] = threads.map((thread) => ({
    path: thread.path,
    title: thread.title,
    status: thread.status,
  }));

  const edgeDedupe = new Set<string>();
  const missingDedupe = new Set<string>();
  const edges: CausalGraphEdge[] = [];
  const missingReferences: CausalGraphMissingReference[] = [];

  for (const thread of threads) {
    const refs = extractWikiRefsFromBody(thread.body);
    for (const rawRef of refs) {
      const normalizedRef = normalizeThreadRef(rawRef);
      if (!normalizedRef) continue;
      if (!nodePaths.has(normalizedRef)) {
        const missingKey = `${thread.path}|${normalizedRef}|${rawRef}`;
        if (missingDedupe.has(missingKey)) continue;
        missingDedupe.add(missingKey);
        missingReferences.push({
          from: thread.path,
          rawRef,
          normalizedRef,
        });
        continue;
      }
      const edgeKey = `${thread.path}|${normalizedRef}`;
      if (edgeDedupe.has(edgeKey)) continue;
      edgeDedupe.add(edgeKey);
      edges.push({
        from: thread.path,
        to: normalizedRef,
        source: 'body-wiki-link',
        rawRef,
      });
    }
  }

  const outgoingCount = new Map<string, number>();
  const incomingCount = new Map<string, number>();
  for (const node of nodes) {
    outgoingCount.set(node.path, 0);
    incomingCount.set(node.path, 0);
  }
  for (const edge of edges) {
    outgoingCount.set(edge.from, (outgoingCount.get(edge.from) ?? 0) + 1);
    incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
  }

  const roots = nodes
    .filter((node) => (outgoingCount.get(node.path) ?? 0) === 0)
    .map((node) => node.path)
    .sort((a, b) => a.localeCompare(b));
  const leaves = nodes
    .filter((node) => (incomingCount.get(node.path) ?? 0) === 0)
    .map((node) => node.path)
    .sort((a, b) => a.localeCompare(b));

  return {
    generatedAt: new Date().toISOString(),
    nodes,
    edges: edges.sort((a, b) =>
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to),
    ),
    missingReferences: missingReferences.sort((a, b) =>
      a.from.localeCompare(b.from) ||
      a.normalizedRef.localeCompare(b.normalizedRef),
    ),
    roots,
    leaves,
    cycles: findCycles(nodes.map((node) => node.path), edges),
  };
}

export function causalDependencies(graph: CausalDependencyGraph, threadRef: string): string[] {
  const resolved = resolveThreadPath(graph, threadRef);
  if (!resolved) return [];
  return graph.edges
    .filter((edge) => edge.from === resolved)
    .map((edge) => edge.to)
    .sort((a, b) => a.localeCompare(b));
}

export function causalDependents(graph: CausalDependencyGraph, threadRef: string): string[] {
  const resolved = resolveThreadPath(graph, threadRef);
  if (!resolved) return [];
  return graph.edges
    .filter((edge) => edge.to === resolved)
    .map((edge) => edge.from)
    .sort((a, b) => a.localeCompare(b));
}

function extractWikiRefsFromBody(body: string): string[] {
  const refs: string[] = [];
  const matches = body.matchAll(/\[\[([^[\]]+)\]\]/g);
  for (const match of matches) {
    const rawRef = match[1]?.trim();
    if (rawRef) refs.push(rawRef);
  }
  return refs;
}

function normalizeThreadRef(rawRef: string): string {
  const trimmed = String(rawRef ?? '').trim();
  if (!trimmed) return '';
  const withoutAlias = trimmed.split('|')[0]?.trim() ?? '';
  const withoutHeading = withoutAlias.split('#')[0]?.trim() ?? '';
  if (!withoutHeading) return '';
  if (!withoutHeading.startsWith('threads/')) return '';
  return withoutHeading.endsWith('.md') ? withoutHeading : `${withoutHeading}.md`;
}

function resolveThreadPath(graph: CausalDependencyGraph, threadRef: string): string | null {
  const normalized = normalizeThreadRef(threadRef);
  if (normalized && graph.nodes.some((node) => node.path === normalized)) {
    return normalized;
  }
  const slugRef = threadRef.trim().replace(/\.md$/i, '');
  const slug = slugRef.split('/').pop() ?? slugRef;
  const matches = graph.nodes
    .map((node) => node.path)
    .filter((path) => path === threadRef || path === `${threadRef}.md` || path.endsWith(`/${slug}.md`));
  if (matches.length === 1) return matches[0];
  return null;
}

function findCycles(nodes: string[], edges: CausalGraphEdge[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node, []);
  for (const edge of edges) {
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
    adjacency.get(edge.from)!.push(edge.to);
  }
  for (const [node, neighbors] of adjacency.entries()) {
    adjacency.set(node, neighbors.sort((a, b) => a.localeCompare(b)));
  }

  const cycles = new Map<string, string[]>();
  const path: string[] = [];
  const active = new Set<string>();
  const visited = new Set<string>();

  const dfs = (node: string): void => {
    visited.add(node);
    active.add(node);
    path.push(node);
    for (const neighbor of adjacency.get(node) ?? []) {
      const activeIndex = path.indexOf(neighbor);
      if (activeIndex !== -1) {
        const cycle = [...path.slice(activeIndex), neighbor];
        const key = canonicalCycleKey(cycle);
        if (!cycles.has(key)) cycles.set(key, cycle);
        continue;
      }
      if (!visited.has(neighbor)) dfs(neighbor);
    }
    path.pop();
    active.delete(node);
  };

  for (const node of nodes) {
    if (!visited.has(node)) dfs(node);
  }

  return [...cycles.values()].sort((a, b) => a.join('>').localeCompare(b.join('>')));
}

function canonicalCycleKey(cycle: string[]): string {
  const closed = cycle.length > 1 && cycle[0] === cycle[cycle.length - 1]
    ? cycle.slice(0, -1)
    : cycle.slice();
  if (closed.length === 0) return '';
  const rotations: string[] = [];
  for (let idx = 0; idx < closed.length; idx++) {
    const rotated = [...closed.slice(idx), ...closed.slice(0, idx)];
    rotations.push(rotated.join('>'));
  }
  rotations.sort((a, b) => a.localeCompare(b));
  return rotations[0];
}
