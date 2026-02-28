import path from 'node:path';
import { colorize, dim, parsePositiveInt, supportsColor } from './format.js';
import { buildPrimitiveWikiGraph, loadPrimitiveInventory, type PrimitiveInventory } from './primitives.js';

export interface VizOptions {
  focus?: string;
  depth?: number;
  top?: number;
  color?: boolean;
}

export interface VizReport {
  generatedAt: string;
  workspacePath: string;
  nodeCount: number;
  edgeCount: number;
  hubs: Array<{ path: string; degree: number }>;
  focus?: string;
  rendered: string;
}

const TYPE_COLORS = ['cyan', 'magenta', 'yellow', 'green', 'blue', 'red'] as const;

export function visualizeVaultGraph(workspacePath: string, options: VizOptions = {}): VizReport {
  const inventory = loadPrimitiveInventory(workspacePath);
  const primitiveGraph = buildPrimitiveWikiGraph(workspacePath, inventory);
  const depth = normalizeDepth(options.depth);
  const top = normalizeTop(options.top);
  const colorEnabled = supportsColor(options.color !== false);
  const typeColorMap = buildTypeColorMap(inventory);
  const labelForNode = (nodePath: string): string => {
    const primitive = inventory.byPath.get(nodePath);
    const typeName = primitive?.type ?? 'unknown';
    const base = `${nodePath} [${typeName}]`;
    const typeColor = typeColorMap.get(typeName) ?? 'gray';
    return colorize(base, typeColor, colorEnabled);
  };

  let rendered = '';
  let focusPath: string | undefined;
  if (options.focus) {
    focusPath = resolveFocusPath(options.focus, inventory);
    rendered = renderFocusedGraph(focusPath, primitiveGraph, depth, labelForNode, colorEnabled);
  } else {
    rendered = renderTopHubGraph(primitiveGraph, depth, top, labelForNode, colorEnabled);
  }

  return {
    generatedAt: new Date().toISOString(),
    workspacePath,
    nodeCount: primitiveGraph.nodes.length,
    edgeCount: primitiveGraph.edges.length,
    hubs: primitiveGraph.hubs,
    ...(focusPath ? { focus: focusPath } : {}),
    rendered,
  };
}

function renderFocusedGraph(
  focusPath: string,
  graph: ReturnType<typeof buildPrimitiveWikiGraph>,
  depth: number,
  labelForNode: (nodePath: string) => string,
  colorEnabled: boolean,
): string {
  const outgoing = graph.outgoing[focusPath] ?? [];
  const incoming = graph.incoming[focusPath] ?? [];
  const lines: string[] = [];
  lines.push(labelForNode(focusPath));

  const hasOutgoing = outgoing.length > 0;
  const hasIncoming = incoming.length > 0;
  if (!hasOutgoing && !hasIncoming) {
    lines.push(`└─ ${dim('(no links)', colorEnabled)}`);
    return lines.join('\n');
  }

  const sections: Array<{ title: string; neighbors: string[]; map: Record<string, string[]>; arrow: '▶' | '◀' }> = [
    { title: 'Outgoing', neighbors: outgoing, map: graph.outgoing, arrow: '▶' },
    { title: 'Incoming', neighbors: incoming, map: graph.incoming, arrow: '◀' },
  ].filter((section) => section.neighbors.length > 0);

  sections.forEach((section, index) => {
    const isLastSection = index === sections.length - 1;
    lines.push(`${isLastSection ? '└' : '├'}─ ${section.title}`);
    renderNeighbors({
      lines,
      map: section.map,
      neighbors: section.neighbors,
      depthRemaining: depth,
      prefix: isLastSection ? '   ' : '│  ',
      arrow: section.arrow,
      labelForNode,
      colorEnabled,
      ancestors: new Set([focusPath]),
    });
  });

  return lines.join('\n');
}

function renderTopHubGraph(
  graph: ReturnType<typeof buildPrimitiveWikiGraph>,
  depth: number,
  top: number,
  labelForNode: (nodePath: string) => string,
  colorEnabled: boolean,
): string {
  const lines: string[] = [];
  const hubs = graph.hubs.slice(0, top);
  const roots = graph.nodes.length > top
    ? hubs.map((hub) => hub.path)
    : graph.nodes.slice().sort((a, b) => a.localeCompare(b));
  const isTruncated = graph.nodes.length > top;

  roots.forEach((root, rootIndex) => {
    lines.push(labelForNode(root));
    const neighbors = graph.outgoing[root] ?? [];
    if (neighbors.length === 0) {
      lines.push(`└─ ${dim('(no outgoing links)', colorEnabled)}`);
    } else {
      renderNeighbors({
        lines,
        map: graph.outgoing,
        neighbors,
        depthRemaining: depth,
        prefix: '',
        arrow: '▶',
        labelForNode,
        colorEnabled,
        ancestors: new Set([root]),
      });
    }
    if (rootIndex !== roots.length - 1) {
      lines.push('');
    }
  });

  if (isTruncated) {
    lines.push('');
    lines.push(dim(`Showing top ${roots.length} most-connected nodes of ${graph.nodes.length}.`, colorEnabled));
  }

  return lines.join('\n');
}

function renderNeighbors(params: {
  lines: string[];
  map: Record<string, string[]>;
  neighbors: string[];
  depthRemaining: number;
  prefix: string;
  arrow: '▶' | '◀';
  labelForNode: (nodePath: string) => string;
  colorEnabled: boolean;
  ancestors: Set<string>;
}): void {
  if (params.depthRemaining <= 0) return;
  const sortedNeighbors = params.neighbors.slice().sort((a, b) => a.localeCompare(b));
  sortedNeighbors.forEach((neighbor, index) => {
    const isLast = index === sortedNeighbors.length - 1;
    const branch = isLast ? '└' : '├';
    const cycle = params.ancestors.has(neighbor);
    const cycleTag = cycle ? ` ${dim('(cycle)', params.colorEnabled)}` : '';
    params.lines.push(`${params.prefix}${branch}─${params.arrow} ${params.labelForNode(neighbor)}${cycleTag}`);
    if (cycle || params.depthRemaining <= 1) return;
    const nextPrefix = `${params.prefix}${isLast ? '   ' : '│  '}`;
    const nextAncestors = new Set(params.ancestors);
    nextAncestors.add(neighbor);
    renderNeighbors({
      ...params,
      neighbors: params.map[neighbor] ?? [],
      depthRemaining: params.depthRemaining - 1,
      prefix: nextPrefix,
      ancestors: nextAncestors,
    });
  });
}

function normalizeDepth(depth: number | undefined): number {
  if (depth === undefined) return 2;
  return parsePositiveInt(String(depth), 2, '--depth');
}

function normalizeTop(top: number | undefined): number {
  if (top === undefined) return 10;
  return parsePositiveInt(String(top), 10, '--top');
}

function resolveFocusPath(focusInput: string, inventory: PrimitiveInventory): string {
  const normalized = focusInput.replace(/\\/g, '/').trim();
  if (!normalized) {
    throw new Error('--focus value cannot be empty.');
  }
  const directCandidate = normalized.endsWith('.md') ? normalized : `${normalized}.md`;
  if (inventory.byPath.has(normalized)) return normalized;
  if (inventory.byPath.has(directCandidate)) return directCandidate;

  const slug = path.basename(normalized, '.md');
  const candidates = inventory.slugToPaths.get(slug) ?? [];
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error(`Focus slug "${focusInput}" is ambiguous: ${candidates.join(', ')}`);
  }
  throw new Error(`Focus node "${focusInput}" was not found.`);
}

function buildTypeColorMap(inventory: PrimitiveInventory): Map<string, 'gray' | typeof TYPE_COLORS[number]> {
  const map = new Map<string, 'gray' | typeof TYPE_COLORS[number]>();
  const typeNames = [...inventory.typeDefs.keys()].sort((a, b) => a.localeCompare(b));
  typeNames.forEach((typeName, index) => {
    map.set(typeName, TYPE_COLORS[index % TYPE_COLORS.length]);
  });
  return map;
}
