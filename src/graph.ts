/**
 * Wiki-link graph indexing and graph-intelligence queries.
 */

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { loadRegistry } from './registry.js';

export type WikiGraphEdgeType =
  | 'wiki'
  | 'context_refs'
  | 'depends_on'
  | 'blocks'
  | 'informs'
  | 'contradicts'
  | 'supports'
  | 'supersedes'
  | 'parent';

export interface WikiGraphEdge {
  from: string;
  to: string;
  type: WikiGraphEdgeType;
  source: 'body' | 'frontmatter';
  field?: string;
}

export interface WikiGraphNode {
  path: string;
  slug: string;
  type: string;
  title?: string;
}

export interface WikiGraphIndex {
  generatedAt: string;
  nodes: string[];
  nodeInfo: Record<string, WikiGraphNode>;
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

export interface WikiGraphNeighborhoodQueryNode extends WikiGraphNode {
  exists: boolean;
  distance: number;
}

export interface WikiGraphNeighborhoodQuery {
  center: WikiGraphNeighborhoodQueryNode;
  depth: number;
  connectedNodes: WikiGraphNeighborhoodQueryNode[];
  edges: WikiGraphEdge[];
}

export interface WikiGraphImpactReference {
  node: WikiGraphNode;
  edgeTypes: WikiGraphEdgeType[];
  referenceCount: number;
}

export interface WikiGraphImpactGroup {
  type: string;
  references: WikiGraphImpactReference[];
  referenceCount: number;
}

export interface WikiGraphImpactAnalysis {
  target: WikiGraphNode & { exists: boolean };
  totalReferences: number;
  incomingEdges: WikiGraphEdge[];
  groups: WikiGraphImpactGroup[];
}

export interface WikiGraphContextSection {
  path: string;
  type: string;
  distance: number;
  chars: number;
  tokens: number;
}

export interface WikiGraphContextAssembly {
  center: WikiGraphNode & { exists: boolean };
  budgetTokens: number;
  usedTokens: number;
  sections: WikiGraphContextSection[];
  markdown: string;
}

export interface WikiGraphTypedEdges {
  node: WikiGraphNode & { exists: boolean };
  outgoing: WikiGraphEdge[];
  incoming: WikiGraphEdge[];
}

export interface WikiGraphExportResult {
  center: WikiGraphNode;
  depth: number;
  format: 'md';
  outputDirectory: string;
  manifestPath: string;
  exportedNodes: string[];
  exportedEdgeCount: number;
}

const GRAPH_INDEX_FILE = '.workgraph/graph-index.json';
const DEFAULT_NEIGHBORHOOD_DEPTH = 2;
const DEFAULT_CONTEXT_BUDGET_TOKENS = 2_000;

const FRONTMATTER_RELATION_FIELDS: Record<string, WikiGraphEdgeType> = {
  context_refs: 'context_refs',
  depends_on: 'depends_on',
  deps: 'depends_on',
  blocks: 'blocks',
  informs: 'informs',
  contradicts: 'contradicts',
  supports: 'supports',
  supersedes: 'supersedes',
  parent: 'parent',
  space: 'context_refs',
  thread_refs: 'context_refs',
};

const DIRECT_CONTEXT_TYPE_PRIORITY: Record<string, number> = {
  decision: 0,
  fact: 1,
  lesson: 2,
};

export function graphIndexPath(workspacePath: string): string {
  return path.join(workspacePath, GRAPH_INDEX_FILE);
}

export function buildWikiLinkGraph(workspacePath: string): WikiGraphIndex {
  const nodes = listMarkdownFiles(workspacePath).sort();
  const nodeSet = new Set(nodes);
  const nodeInfo = buildNodeInfo(workspacePath, nodes);
  const edgeDedupe = new Set<string>();
  const edges: WikiGraphEdge[] = [];
  const backlinksSet = new Map<string, Set<string>>();
  const adjacencyOut = new Map<string, Set<string>>();
  const adjacencyIn = new Map<string, Set<string>>();
  const brokenLinkDedupe = new Set<string>();
  const brokenLinks: Array<{ from: string; to: string }> = [];

  for (const node of nodes) {
    const absPath = path.join(workspacePath, node);
    const raw = fs.readFileSync(absPath, 'utf-8');
    const parsed = matter(raw);

    const bodyRefs = extractBodyEdgeRefs(parsed.content);
    const frontmatterRefs = extractFrontmatterEdgeRefs(parsed.data as Record<string, unknown>);
    const allRefs = [...bodyRefs, ...frontmatterRefs];

    for (const ref of allRefs) {
      const target = normalizeWikiRef(ref.rawRef);
      if (!target) continue;

      const edge: WikiGraphEdge = {
        from: node,
        to: target,
        type: ref.type,
        source: ref.source,
        ...(ref.field ? { field: ref.field } : {}),
      };
      const edgeKey = `${edge.from}|${edge.to}|${edge.type}|${edge.source}|${edge.field ?? ''}`;
      if (edgeDedupe.has(edgeKey)) continue;
      edgeDedupe.add(edgeKey);
      edges.push(edge);

      if (!backlinksSet.has(target)) backlinksSet.set(target, new Set());
      backlinksSet.get(target)!.add(node);

      if (!adjacencyOut.has(node)) adjacencyOut.set(node, new Set());
      adjacencyOut.get(node)!.add(target);

      if (!adjacencyIn.has(target)) adjacencyIn.set(target, new Set());
      adjacencyIn.get(target)!.add(node);

      if (!nodeSet.has(target) && !isExternalRef(target)) {
        const brokenKey = `${node}|${target}`;
        if (!brokenLinkDedupe.has(brokenKey)) {
          brokenLinkDedupe.add(brokenKey);
          brokenLinks.push({ from: node, to: target });
        }
      }
    }
  }

  const backlinks: Record<string, string[]> = {};
  for (const [target, refs] of backlinksSet.entries()) {
    backlinks[target] = [...refs].sort();
  }

  const orphans = nodes
    .filter((node) => {
      const outgoing = adjacencyOut.get(node)?.size ?? 0;
      const incoming = adjacencyIn.get(node)?.size ?? 0;
      return outgoing === 0 && incoming === 0;
    })
    .sort();

  const hubs = nodes
    .map((node) => ({
      node,
      degree: (adjacencyOut.get(node)?.size ?? 0) + (adjacencyIn.get(node)?.size ?? 0),
    }))
    .filter((entry) => entry.degree > 0)
    .sort((a, b) => b.degree - a.degree || a.node.localeCompare(b.node))
    .slice(0, 20);

  return {
    generatedAt: new Date().toISOString(),
    nodes,
    nodeInfo,
    edges: edges.sort(compareEdges),
    backlinks,
    orphans,
    brokenLinks: brokenLinks.sort(compareBrokenLinks),
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
    const parsed = JSON.parse(raw) as Partial<WikiGraphIndex>;
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    if (!parsed.nodeInfo || typeof parsed.nodeInfo !== 'object') return null;
    return parsed as WikiGraphIndex;
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

/**
 * Backward-compatible one-hop direct neighborhood.
 */
export function graphNeighborhood(
  workspacePath: string,
  nodeRef: string,
  options: { refresh?: boolean } = {},
): WikiGraphNeighborhood {
  const graph = loadGraph(workspacePath, options.refresh);
  const resolved = resolveNodePath(graph, nodeRef);
  const node = resolved ?? normalizeWikiRef(nodeRef);
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

export function graphNeighborhoodQuery(
  workspacePath: string,
  nodeRef: string,
  options: { depth?: number; refresh?: boolean } = {},
): WikiGraphNeighborhoodQuery {
  const graph = loadGraph(workspacePath, options.refresh);
  const depth = Math.max(0, options.depth ?? DEFAULT_NEIGHBORHOOD_DEPTH);
  const resolved = resolveNodePath(graph, nodeRef);
  const centerPath = resolved ?? normalizeWikiRef(nodeRef);
  const centerExists = graph.nodes.includes(centerPath);
  const centerNode = toNeighborhoodNode(graph, centerPath, 0, centerExists);

  if (!centerExists) {
    return {
      center: centerNode,
      depth,
      connectedNodes: [],
      edges: [],
    };
  }

  const adjacency = buildUndirectedAdjacency(graph);
  const distances = breadthFirstDistances(adjacency, centerPath, depth);
  const connectedNodes = [...distances.entries()]
    .filter(([node]) => node !== centerPath && graph.nodes.includes(node))
    .map(([node, distance]) => toNeighborhoodNode(graph, node, distance, true))
    .sort((a, b) => a.distance - b.distance || a.path.localeCompare(b.path));
  const nodeSet = new Set<string>([centerPath, ...connectedNodes.map((item) => item.path)]);
  const edges = graph.edges
    .filter((edge) => nodeSet.has(edge.from) && nodeSet.has(edge.to))
    .sort(compareEdges);

  return {
    center: centerNode,
    depth,
    connectedNodes,
    edges,
  };
}

export function graphImpactAnalysis(
  workspacePath: string,
  nodeRef: string,
  options: { refresh?: boolean } = {},
): WikiGraphImpactAnalysis {
  const graph = loadGraph(workspacePath, options.refresh);
  const resolved = resolveNodePath(graph, nodeRef);
  const targetPath = resolved ?? normalizeWikiRef(nodeRef);
  const targetExists = graph.nodes.includes(targetPath);
  const target = toNode(graph, targetPath, targetExists);

  if (!targetExists) {
    return {
      target,
      totalReferences: 0,
      incomingEdges: [],
      groups: [],
    };
  }

  const incomingEdges = graph.edges
    .filter((edge) => edge.to === targetPath && graph.nodes.includes(edge.from))
    .sort(compareEdges);
  const byNode = new Map<string, { edgeTypes: Set<WikiGraphEdgeType>; referenceCount: number }>();
  for (const edge of incomingEdges) {
    if (!byNode.has(edge.from)) {
      byNode.set(edge.from, {
        edgeTypes: new Set<WikiGraphEdgeType>(),
        referenceCount: 0,
      });
    }
    const entry = byNode.get(edge.from)!;
    entry.edgeTypes.add(edge.type);
    entry.referenceCount += 1;
  }

  const references = [...byNode.entries()]
    .map(([nodePath, entry]) => ({
      nodePath,
      type: inferNodeType(graph, nodePath),
      reference: {
        node: toNode(graph, nodePath, true),
        edgeTypes: [...entry.edgeTypes].sort(),
        referenceCount: entry.referenceCount,
      } as WikiGraphImpactReference,
    }))
    .sort((a, b) => b.reference.referenceCount - a.reference.referenceCount || a.nodePath.localeCompare(b.nodePath));

  const groupMap = new Map<string, WikiGraphImpactReference[]>();
  for (const ref of references) {
    if (!groupMap.has(ref.type)) groupMap.set(ref.type, []);
    groupMap.get(ref.type)!.push(ref.reference);
  }

  const groups = [...groupMap.entries()]
    .map(([type, refs]) => ({
      type,
      references: refs,
      referenceCount: refs.reduce((sum, item) => sum + item.referenceCount, 0),
    }))
    .sort((a, b) => b.referenceCount - a.referenceCount || a.type.localeCompare(b.type));

  return {
    target,
    totalReferences: incomingEdges.length,
    incomingEdges,
    groups,
  };
}

export function graphContextAssembly(
  workspacePath: string,
  nodeRef: string,
  options: { budgetTokens?: number; refresh?: boolean } = {},
): WikiGraphContextAssembly {
  const graph = loadGraph(workspacePath, options.refresh);
  const centerPath = resolveNodePath(graph, nodeRef);
  if (!centerPath || !graph.nodes.includes(centerPath)) {
    throw new Error(`Graph node not found: ${nodeRef}`);
  }

  const budgetTokens = Math.max(1, options.budgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS);
  const budgetChars = budgetTokens * 4;
  const adjacency = buildUndirectedAdjacency(graph);
  const allDistances = breadthFirstDistances(adjacency, centerPath, Number.MAX_SAFE_INTEGER);
  const ordered = orderNodesForContext(graph, centerPath, allDistances);

  const markdownParts: string[] = [];
  const sections: WikiGraphContextSection[] = [];
  let usedChars = 0;

  const intro = [
    `# Workgraph context: ${centerPath}`,
    '',
    `- budget_tokens: ${budgetTokens}`,
    '- token_estimation: chars / 4',
    '',
  ].join('\n');
  markdownParts.push(intro);
  usedChars += intro.length;

  for (const candidate of ordered) {
    const remaining = budgetChars - usedChars;
    if (remaining <= 0) break;

    const sectionMarkdown = renderContextSection(workspacePath, candidate.path, candidate.type);
    if (!sectionMarkdown) continue;

    if (sectionMarkdown.length > remaining) {
      if (candidate.path !== centerPath) continue;
      const truncated = truncateSection(sectionMarkdown, remaining);
      if (!truncated) break;
      markdownParts.push(truncated);
      usedChars += truncated.length;
      sections.push({
        path: candidate.path,
        type: candidate.type,
        distance: candidate.distance,
        chars: truncated.length,
        tokens: estimateTokens(truncated.length),
      });
      break;
    }

    markdownParts.push(sectionMarkdown);
    usedChars += sectionMarkdown.length;
    sections.push({
      path: candidate.path,
      type: candidate.type,
      distance: candidate.distance,
      chars: sectionMarkdown.length,
      tokens: estimateTokens(sectionMarkdown.length),
    });
  }

  const markdown = markdownParts.join('');
  return {
    center: { ...toNode(graph, centerPath, true), exists: true },
    budgetTokens,
    usedTokens: estimateTokens(markdown.length),
    sections,
    markdown,
  };
}

export function graphTypedEdges(
  workspacePath: string,
  nodeRef: string,
  options: { refresh?: boolean } = {},
): WikiGraphTypedEdges {
  const graph = loadGraph(workspacePath, options.refresh);
  const resolved = resolveNodePath(graph, nodeRef);
  const nodePath = resolved ?? normalizeWikiRef(nodeRef);
  const exists = graph.nodes.includes(nodePath);
  if (!exists) {
    return {
      node: { ...toNode(graph, nodePath, false), exists: false },
      outgoing: [],
      incoming: [],
    };
  }
  return {
    node: { ...toNode(graph, nodePath, true), exists: true },
    outgoing: graph.edges.filter((edge) => edge.from === nodePath).sort(compareEdges),
    incoming: graph.edges.filter((edge) => edge.to === nodePath).sort(compareEdges),
  };
}

export function graphExportSubgraph(
  workspacePath: string,
  nodeRef: string,
  options: { depth?: number; format?: 'md'; outputDir?: string; refresh?: boolean } = {},
): WikiGraphExportResult {
  const depth = Math.max(0, options.depth ?? DEFAULT_NEIGHBORHOOD_DEPTH);
  const format = options.format ?? 'md';
  if (format !== 'md') {
    throw new Error(`Unsupported export format "${format}". Supported formats: md.`);
  }

  const neighborhood = graphNeighborhoodQuery(workspacePath, nodeRef, {
    depth,
    refresh: options.refresh,
  });
  if (!neighborhood.center.exists) {
    throw new Error(`Graph node not found: ${nodeRef}`);
  }

  const defaultOutputDir = path.join(
    '.workgraph',
    'graph-exports',
    `${neighborhood.center.slug || 'node'}-d${depth}-${timestampForPath()}`,
  );
  const outputDir = options.outputDir ?? defaultOutputDir;
  const absOutputDir = path.isAbsolute(outputDir)
    ? outputDir
    : path.join(workspacePath, outputDir);
  fs.mkdirSync(absOutputDir, { recursive: true });

  const exportNodeSet = new Set<string>([
    neighborhood.center.path,
    ...neighborhood.connectedNodes.map((node) => node.path),
  ]);
  const exportedNodes: string[] = [];
  for (const node of [...exportNodeSet].sort()) {
    const src = path.join(workspacePath, node);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(absOutputDir, node);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    exportedNodes.push(node);
  }

  const exportedEdges = neighborhood.edges.filter((edge) =>
    exportNodeSet.has(edge.from) && exportNodeSet.has(edge.to),
  );
  const manifestPath = path.join(absOutputDir, 'subgraph.json');
  const manifest = {
    generatedAt: new Date().toISOString(),
    center: neighborhood.center.path,
    depth,
    format,
    nodes: exportedNodes,
    edges: exportedEdges,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  return {
    center: toNode(loadGraph(workspacePath, false), neighborhood.center.path, true),
    depth,
    format,
    outputDirectory: absOutputDir,
    manifestPath,
    exportedNodes,
    exportedEdgeCount: exportedEdges.length,
  };
}

function loadGraph(workspacePath: string, refresh = false): WikiGraphIndex {
  if (refresh) return refreshWikiLinkGraphIndex(workspacePath);
  return readWikiLinkGraphIndex(workspacePath) ?? buildWikiLinkGraph(workspacePath);
}

function listMarkdownFiles(workspacePath: string): string[] {
  const output: string[] = [];
  const stack = [workspacePath];
  const ignoredDirs = new Set(['.git', '.workgraph', 'node_modules', 'dist']);

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

function buildNodeInfo(workspacePath: string, nodes: string[]): Record<string, WikiGraphNode> {
  const directoryToType = directoryTypeMap(workspacePath);
  const nodeInfo: Record<string, WikiGraphNode> = {};
  for (const relPath of nodes) {
    const absPath = path.join(workspacePath, relPath);
    let title: string | undefined;
    try {
      const parsed = matter(fs.readFileSync(absPath, 'utf-8'));
      if (typeof parsed.data.title === 'string' && parsed.data.title.trim()) {
        title = parsed.data.title.trim();
      } else {
        title = firstHeading(parsed.content);
      }
    } catch {
      title = undefined;
    }
    const slug = path.basename(relPath, '.md');
    const dir = relPath.split('/')[0] ?? '';
    nodeInfo[relPath] = {
      path: relPath,
      slug,
      type: directoryToType.get(dir) ?? 'unknown',
      ...(title ? { title } : {}),
    };
  }
  return nodeInfo;
}

function directoryTypeMap(workspacePath: string): Map<string, string> {
  const registry = loadRegistry(workspacePath);
  const mapping = new Map<string, string>();
  for (const type of Object.values(registry.types)) {
    mapping.set(type.directory, type.name);
  }
  return mapping;
}

function firstHeading(markdown: string): string | undefined {
  const match = markdown.match(/^\s*#\s+(.+?)\s*$/m);
  return match?.[1]?.trim();
}

function extractBodyEdgeRefs(content: string): Array<{
  rawRef: string;
  type: WikiGraphEdgeType;
  source: 'body';
}> {
  return extractWikiLinks(content).map((rawRef) => ({
    rawRef,
    type: 'wiki',
    source: 'body' as const,
  }));
}

function extractFrontmatterEdgeRefs(frontmatter: Record<string, unknown>): Array<{
  rawRef: string;
  type: WikiGraphEdgeType;
  source: 'frontmatter';
  field: string;
}> {
  const refs: Array<{ rawRef: string; type: WikiGraphEdgeType; source: 'frontmatter'; field: string }> = [];
  for (const [field, value] of Object.entries(frontmatter)) {
    const relationType = FRONTMATTER_RELATION_FIELDS[field];
    if (!relationType) continue;
    const items = collectReferenceStrings(value);
    for (const item of items) {
      const embeddedWikiLinks = extractWikiLinks(item);
      if (embeddedWikiLinks.length > 0) {
        for (const wikiLink of embeddedWikiLinks) {
          refs.push({
            rawRef: wikiLink,
            type: relationType,
            source: 'frontmatter',
            field,
          });
        }
        continue;
      }
      refs.push({
        rawRef: item,
        type: relationType,
        source: 'frontmatter',
        field,
      });
    }
  }
  return refs;
}

function collectReferenceStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectReferenceStrings(item));
  }
  return [];
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
  const trimmed = String(rawRef ?? '').trim();
  if (!trimmed) return '';
  const unwrapped = unwrapWiki(trimmed);
  const withoutAlias = unwrapped.split('|')[0].trim();
  const withoutHeading = withoutAlias.split('#')[0].trim();
  if (!withoutHeading) return '';
  if (isExternalRef(withoutHeading)) return withoutHeading;
  const normalized = withoutHeading.replace(/\\/g, '/').replace(/^\.?\//, '');
  return normalized.endsWith('.md') ? normalized : `${normalized}.md`;
}

function unwrapWiki(rawRef: string): string {
  if (rawRef.startsWith('[[') && rawRef.endsWith(']]')) {
    return rawRef.slice(2, -2).trim();
  }
  return rawRef;
}

function isExternalRef(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}

function resolveNodePath(graph: WikiGraphIndex, nodeRef: string): string | null {
  const normalized = normalizeWikiRef(nodeRef);
  if (!normalized) return null;
  if (graph.nodes.includes(normalized)) return normalized;

  const nodeRefNoExt = stripMdExtension(normalized);
  const directCandidates = graph.nodes.filter((node) => stripMdExtension(node) === nodeRefNoExt);
  if (directCandidates.length === 1) return directCandidates[0];

  const slugInput = path.basename(nodeRefNoExt);
  const slugMatches = graph.nodes.filter((node) => path.basename(stripMdExtension(node)) === slugInput);
  if (slugMatches.length === 1) return slugMatches[0];
  if (slugMatches.length > 1) {
    throw new Error(
      `Ambiguous graph ref "${nodeRef}". Matches: ${slugMatches.slice(0, 10).join(', ')}${
        slugMatches.length > 10 ? ' ...' : ''
      }`,
    );
  }

  return null;
}

function stripMdExtension(value: string): string {
  return value.endsWith('.md') ? value.slice(0, -3) : value;
}

function buildUndirectedAdjacency(graph: WikiGraphIndex): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const node of graph.nodes) adjacency.set(node, new Set());
  for (const edge of graph.edges) {
    if (!graph.nodes.includes(edge.from) || !graph.nodes.includes(edge.to)) continue;
    adjacency.get(edge.from)!.add(edge.to);
    adjacency.get(edge.to)!.add(edge.from);
  }
  return adjacency;
}

function breadthFirstDistances(
  adjacency: Map<string, Set<string>>,
  start: string,
  maxDepth: number,
): Map<string, number> {
  const distances = new Map<string, number>();
  if (!adjacency.has(start)) return distances;
  const queue: string[] = [start];
  distances.set(start, 0);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentDepth = distances.get(current)!;
    if (currentDepth >= maxDepth) continue;
    const neighbors = adjacency.get(current);
    if (!neighbors) continue;
    for (const neighbor of neighbors) {
      if (distances.has(neighbor)) continue;
      distances.set(neighbor, currentDepth + 1);
      queue.push(neighbor);
    }
  }

  return distances;
}

function inferNodeType(graph: WikiGraphIndex, nodePath: string): string {
  return graph.nodeInfo[nodePath]?.type ?? 'unknown';
}

function toNode(graph: WikiGraphIndex, nodePath: string, exists: boolean): WikiGraphNode {
  const fromIndex = graph.nodeInfo[nodePath];
  if (fromIndex) return fromIndex;
  return {
    path: nodePath,
    slug: path.basename(nodePath, '.md'),
    type: 'unknown',
    ...(exists ? {} : {}),
  };
}

function toNeighborhoodNode(
  graph: WikiGraphIndex,
  nodePath: string,
  distance: number,
  exists: boolean,
): WikiGraphNeighborhoodQueryNode {
  const base = toNode(graph, nodePath, exists);
  return {
    ...base,
    exists,
    distance,
  };
}

function orderNodesForContext(
  graph: WikiGraphIndex,
  centerPath: string,
  distances: Map<string, number>,
): Array<{ path: string; type: string; distance: number }> {
  const directNeighbors: Array<{ path: string; type: string; distance: number }> = [];
  const expanded: Array<{ path: string; type: string; distance: number }> = [];

  for (const [nodePath, distance] of distances.entries()) {
    if (!graph.nodes.includes(nodePath)) continue;
    if (nodePath === centerPath) continue;
    const item = {
      path: nodePath,
      type: inferNodeType(graph, nodePath),
      distance,
    };
    if (distance === 1) directNeighbors.push(item);
    else expanded.push(item);
  }

  directNeighbors.sort((a, b) => {
    const aRank = DIRECT_CONTEXT_TYPE_PRIORITY[a.type] ?? 100;
    const bRank = DIRECT_CONTEXT_TYPE_PRIORITY[b.type] ?? 100;
    return aRank - bRank || a.path.localeCompare(b.path);
  });

  expanded.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    const aRank = DIRECT_CONTEXT_TYPE_PRIORITY[a.type] ?? 100;
    const bRank = DIRECT_CONTEXT_TYPE_PRIORITY[b.type] ?? 100;
    return aRank - bRank || a.path.localeCompare(b.path);
  });

  return [
    {
      path: centerPath,
      type: inferNodeType(graph, centerPath),
      distance: 0,
    },
    ...directNeighbors,
    ...expanded,
  ];
}

function renderContextSection(workspacePath: string, nodePath: string, nodeType: string): string {
  const absPath = path.join(workspacePath, nodePath);
  if (!fs.existsSync(absPath)) return '';
  const content = fs.readFileSync(absPath, 'utf-8').trim();
  if (!content) return '';
  return [
    `## ${nodePath} (${nodeType})`,
    '',
    content,
    '',
    '',
  ].join('\n');
}

function truncateSection(sectionMarkdown: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (sectionMarkdown.length <= maxChars) return sectionMarkdown;
  const suffix = '\n\n...[truncated for budget]\n';
  if (maxChars <= suffix.length) return '';
  return sectionMarkdown.slice(0, maxChars - suffix.length) + suffix;
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function timestampForPath(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

function compareEdges(a: WikiGraphEdge, b: WikiGraphEdge): number {
  if (a.from !== b.from) return a.from.localeCompare(b.from);
  if (a.to !== b.to) return a.to.localeCompare(b.to);
  if (a.type !== b.type) return a.type.localeCompare(b.type);
  if (a.source !== b.source) return a.source.localeCompare(b.source);
  return String(a.field ?? '').localeCompare(String(b.field ?? ''));
}

function compareBrokenLinks(a: { from: string; to: string }, b: { from: string; to: string }): number {
  if (a.from !== b.from) return a.from.localeCompare(b.from);
  return a.to.localeCompare(b.to);
}
