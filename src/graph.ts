/**
 * Wiki-link graph indexing and hygiene reports.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface WikiGraphEdge {
  from: string;
  to: string;
}

export interface WikiGraphIndex {
  generatedAt: string;
  nodes: string[];
  edges: WikiGraphEdge[];
  backlinks: Record<string, string[]>;
  orphans: string[];
  brokenLinks: Array<{ from: string; to: string }>;
  hubs: Array<{ node: string; degree: number }>;
}

export interface WikiGraphNeighborhood {
  node: string;
  exists: boolean;
  outgoing: string[];
  incoming: string[];
}

const GRAPH_INDEX_FILE = '.workgraph/graph-index.json';

export function graphIndexPath(workspacePath: string): string {
  return path.join(workspacePath, GRAPH_INDEX_FILE);
}

export function buildWikiLinkGraph(workspacePath: string): WikiGraphIndex {
  const nodes = listMarkdownFiles(workspacePath);
  const nodeSet = new Set(nodes);
  const edges: WikiGraphEdge[] = [];
  const backlinks: Record<string, string[]> = {};
  const outDegree = new Map<string, number>();
  const inDegree = new Map<string, number>();
  const brokenLinks: Array<{ from: string; to: string }> = [];

  for (const node of nodes) {
    const content = fs.readFileSync(path.join(workspacePath, node), 'utf-8');
    const links = extractWikiLinks(content);
    outDegree.set(node, links.length);

    for (const rawLink of links) {
      const target = normalizeWikiRef(rawLink);
      edges.push({ from: node, to: target });

      if (!backlinks[target]) backlinks[target] = [];
      backlinks[target].push(node);
      inDegree.set(target, (inDegree.get(target) ?? 0) + 1);

      if (!nodeSet.has(target) && !target.startsWith('http')) {
        brokenLinks.push({ from: node, to: target });
      }
    }
  }

  const orphans = nodes.filter((node) => (outDegree.get(node) ?? 0) === 0 && (inDegree.get(node) ?? 0) === 0);
  const hubs = nodes
    .map((node) => ({
      node,
      degree: (outDegree.get(node) ?? 0) + (inDegree.get(node) ?? 0),
    }))
    .filter((entry) => entry.degree > 0)
    .sort((a, b) => b.degree - a.degree || a.node.localeCompare(b.node))
    .slice(0, 20);

  return {
    generatedAt: new Date().toISOString(),
    nodes: nodes.sort(),
    edges,
    backlinks,
    orphans: orphans.sort(),
    brokenLinks,
    hubs,
  };
}

export function refreshWikiLinkGraphIndex(workspacePath: string): WikiGraphIndex {
  const graph = buildWikiLinkGraph(workspacePath);
  const indexPath = graphIndexPath(workspacePath);
  const dir = path.dirname(indexPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(graph, null, 2) + '\n', 'utf-8');
  return graph;
}

export function readWikiLinkGraphIndex(workspacePath: string): WikiGraphIndex | null {
  const indexPath = graphIndexPath(workspacePath);
  if (!fs.existsSync(indexPath)) return null;
  try {
    const raw = fs.readFileSync(indexPath, 'utf-8');
    return JSON.parse(raw) as WikiGraphIndex;
  } catch {
    return null;
  }
}

export function graphHygieneReport(workspacePath: string): {
  generatedAt: string;
  nodeCount: number;
  edgeCount: number;
  orphanCount: number;
  brokenLinkCount: number;
  hubs: Array<{ node: string; degree: number }>;
  orphans: string[];
  brokenLinks: Array<{ from: string; to: string }>;
} {
  const graph = buildWikiLinkGraph(workspacePath);
  return {
    generatedAt: graph.generatedAt,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    orphanCount: graph.orphans.length,
    brokenLinkCount: graph.brokenLinks.length,
    hubs: graph.hubs,
    orphans: graph.orphans,
    brokenLinks: graph.brokenLinks,
  };
}

export function graphNeighborhood(
  workspacePath: string,
  nodeRef: string,
  options: { refresh?: boolean } = {},
): WikiGraphNeighborhood {
  const graph = options.refresh
    ? refreshWikiLinkGraphIndex(workspacePath)
    : (readWikiLinkGraphIndex(workspacePath) ?? buildWikiLinkGraph(workspacePath));
  const node = normalizeWikiRef(nodeRef);
  const outgoing = graph.edges
    .filter((edge) => edge.from === node)
    .map((edge) => edge.to)
    .sort();
  const incoming = (graph.backlinks[node] ?? []).slice().sort();
  return {
    node,
    exists: graph.nodes.includes(node),
    outgoing,
    incoming,
  };
}

function listMarkdownFiles(workspacePath: string): string[] {
  const output: string[] = [];
  const stack = [workspacePath];
  const ignoredDirs = new Set(['.git', 'node_modules', 'dist']);

  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = path.join(current, entry.name);
      const relPath = path.relative(workspacePath, absPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) continue;
        stack.push(absPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      output.push(relPath);
    }
  }

  return output;
}

function extractWikiLinks(content: string): string[] {
  const matches = content.matchAll(/\[\[([^[\]]+)\]\]/g);
  const refs: string[] = [];
  for (const match of matches) {
    if (match[1]) refs.push(match[1].trim());
  }
  return refs;
}

function normalizeWikiRef(rawRef: string): string {
  const primary = rawRef.split('|')[0].trim();
  if (!primary) return primary;
  if (/^https?:\/\//i.test(primary)) return primary;
  const withoutAnchor = primary.split('#')[0].trim();
  if (!withoutAnchor) return withoutAnchor;
  return withoutAnchor.endsWith('.md') ? withoutAnchor : `${withoutAnchor}.md`;
}
