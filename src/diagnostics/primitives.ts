import path from 'node:path';
import * as query from '../query.js';
import { loadRegistry } from '../registry.js';
import type { PrimitiveInstance, PrimitiveTypeDefinition, Registry } from '../types.js';

export interface PrimitiveNode extends PrimitiveInstance {
  slug: string;
  requiredFields: string[];
  frontmatterCompleteness: number;
}

export interface PrimitiveInventory {
  registry: Registry;
  primitives: PrimitiveNode[];
  byPath: Map<string, PrimitiveNode>;
  byType: Map<string, PrimitiveNode[]>;
  slugToPaths: Map<string, string[]>;
  typeByDirectory: Map<string, string>;
  typeDefs: Map<string, PrimitiveTypeDefinition>;
}

export interface WikiLinkMatch {
  token: string;
  rawTarget: string;
}

export interface PrimitiveEdge {
  from: string;
  to: string;
}

export interface MissingWikiLink {
  from: string;
  token: string;
  rawTarget: string;
  normalizedTarget: string;
}

export interface AmbiguousWikiLink {
  from: string;
  token: string;
  rawTarget: string;
  normalizedTarget: string;
  candidates: string[];
}

export interface PrimitiveWikiGraph {
  generatedAt: string;
  nodes: string[];
  edges: PrimitiveEdge[];
  outgoing: Record<string, string[]>;
  incoming: Record<string, string[]>;
  hubs: Array<{ path: string; degree: number }>;
  orphanNodes: string[];
  missingLinks: MissingWikiLink[];
  ambiguousLinks: AmbiguousWikiLink[];
}

type PrimitiveTargetResolution =
  | { status: 'external'; normalizedTarget: string }
  | { status: 'resolved'; normalizedTarget: string; path: string }
  | { status: 'ambiguous'; normalizedTarget: string; candidates: string[] }
  | { status: 'missing'; normalizedTarget: string }
  | { status: 'non-primitive'; normalizedTarget: string };

export function loadPrimitiveInventory(workspacePath: string): PrimitiveInventory {
  const registry = loadRegistry(workspacePath);
  const allPrimitives = query.queryPrimitives(workspacePath);
  const byPath = new Map<string, PrimitiveNode>();
  const byType = new Map<string, PrimitiveNode[]>();
  const slugToPaths = new Map<string, string[]>();
  const typeByDirectory = new Map<string, string>();
  const typeDefs = new Map<string, PrimitiveTypeDefinition>();

  for (const typeDef of Object.values(registry.types)) {
    typeByDirectory.set(typeDef.directory, typeDef.name);
    typeDefs.set(typeDef.name, typeDef);
  }

  const primitives: PrimitiveNode[] = allPrimitives.map((instance) => {
    const typeDef = typeDefs.get(instance.type);
    const requiredFields = Object.entries(typeDef?.fields ?? {})
      .filter(([, fieldDef]) => fieldDef.required === true)
      .map(([fieldName]) => fieldName);
    const presentCount = requiredFields.filter((fieldName) => hasRequiredValue(instance.fields[fieldName])).length;
    const frontmatterCompleteness = requiredFields.length === 0 ? 1 : presentCount / requiredFields.length;
    const slug = path.basename(instance.path, '.md');
    return {
      ...instance,
      slug,
      requiredFields,
      frontmatterCompleteness,
    };
  });

  for (const primitive of primitives) {
    byPath.set(primitive.path, primitive);
    const existingByType = byType.get(primitive.type) ?? [];
    existingByType.push(primitive);
    byType.set(primitive.type, existingByType);

    const existingBySlug = slugToPaths.get(primitive.slug) ?? [];
    existingBySlug.push(primitive.path);
    slugToPaths.set(primitive.slug, existingBySlug);
  }

  for (const list of byType.values()) {
    list.sort((a, b) => a.path.localeCompare(b.path));
  }
  for (const [slug, pathsForSlug] of slugToPaths.entries()) {
    slugToPaths.set(slug, pathsForSlug.slice().sort((a, b) => a.localeCompare(b)));
  }

  return {
    registry,
    primitives: primitives.slice().sort((a, b) => a.path.localeCompare(b.path)),
    byPath,
    byType,
    slugToPaths,
    typeByDirectory,
    typeDefs,
  };
}

export function buildPrimitiveWikiGraph(workspacePath: string, inventoryInput?: PrimitiveInventory): PrimitiveWikiGraph {
  const inventory = inventoryInput ?? loadPrimitiveInventory(workspacePath);
  const edgeSet = new Set<string>();
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  const missingLinks: MissingWikiLink[] = [];
  const ambiguousLinks: AmbiguousWikiLink[] = [];

  for (const primitive of inventory.primitives) {
    if (!outgoing.has(primitive.path)) outgoing.set(primitive.path, new Set<string>());
    if (!incoming.has(primitive.path)) incoming.set(primitive.path, new Set<string>());

    for (const link of extractWikiLinks(primitive.body)) {
      const resolved = resolvePrimitiveWikiTarget(link.rawTarget, inventory);
      if (resolved.status === 'resolved') {
        const key = `${primitive.path}=>${resolved.path}`;
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        outgoing.get(primitive.path)!.add(resolved.path);
        if (!incoming.has(resolved.path)) incoming.set(resolved.path, new Set<string>());
        incoming.get(resolved.path)!.add(primitive.path);
      } else if (resolved.status === 'missing') {
        missingLinks.push({
          from: primitive.path,
          token: link.token,
          rawTarget: link.rawTarget,
          normalizedTarget: resolved.normalizedTarget,
        });
      } else if (resolved.status === 'ambiguous') {
        ambiguousLinks.push({
          from: primitive.path,
          token: link.token,
          rawTarget: link.rawTarget,
          normalizedTarget: resolved.normalizedTarget,
          candidates: resolved.candidates,
        });
      }
    }
  }

  const edges = [...edgeSet]
    .map((key) => {
      const [from, to] = key.split('=>');
      return { from, to };
    })
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  const outgoingRecord = mapToSortedRecord(outgoing);
  const incomingRecord = mapToSortedRecord(incoming);

  const hubs = inventory.primitives
    .map((primitive) => ({
      path: primitive.path,
      degree: (outgoingRecord[primitive.path]?.length ?? 0) + (incomingRecord[primitive.path]?.length ?? 0),
    }))
    .filter((entry) => entry.degree > 0)
    .sort((a, b) => b.degree - a.degree || a.path.localeCompare(b.path));

  const orphanNodes = inventory.primitives
    .map((primitive) => primitive.path)
    .filter((nodePath) => (outgoingRecord[nodePath]?.length ?? 0) === 0 && (incomingRecord[nodePath]?.length ?? 0) === 0)
    .sort((a, b) => a.localeCompare(b));

  return {
    generatedAt: new Date().toISOString(),
    nodes: inventory.primitives.map((primitive) => primitive.path),
    edges,
    outgoing: outgoingRecord,
    incoming: incomingRecord,
    hubs,
    orphanNodes,
    missingLinks: missingLinks.slice().sort((a, b) => a.from.localeCompare(b.from) || a.token.localeCompare(b.token)),
    ambiguousLinks: ambiguousLinks
      .slice()
      .sort((a, b) => a.from.localeCompare(b.from) || a.token.localeCompare(b.token)),
  };
}

export function extractWikiLinks(markdown: string): WikiLinkMatch[] {
  const matches = markdown.matchAll(/\[\[([^[\]]+)\]\]/g);
  const links: WikiLinkMatch[] = [];
  for (const match of matches) {
    const token = match[0];
    const rawTarget = match[1]?.trim();
    if (!token || !rawTarget) continue;
    links.push({ token, rawTarget });
  }
  return links;
}

function resolvePrimitiveWikiTarget(rawTarget: string, inventory: PrimitiveInventory): PrimitiveTargetResolution {
  const primary = rawTarget.split('|')[0]?.split('#')[0]?.trim() ?? '';
  if (!primary) {
    return { status: 'non-primitive', normalizedTarget: '' };
  }
  if (/^https?:\/\//i.test(primary)) {
    return { status: 'external', normalizedTarget: primary };
  }

  const normalized = normalizeWikiTarget(primary);
  if (normalized.includes('/')) {
    if (inventory.byPath.has(normalized)) {
      return { status: 'resolved', normalizedTarget: normalized, path: normalized };
    }
    const directory = normalized.split('/')[0];
    if (inventory.typeByDirectory.has(directory)) {
      return { status: 'missing', normalizedTarget: normalized };
    }
    return { status: 'non-primitive', normalizedTarget: normalized };
  }

  const slug = normalized.replace(/\.md$/i, '');
  const candidates = inventory.slugToPaths.get(slug) ?? [];
  if (candidates.length === 1) {
    return { status: 'resolved', normalizedTarget: normalized, path: candidates[0] };
  }
  if (candidates.length > 1) {
    return { status: 'ambiguous', normalizedTarget: normalized, candidates };
  }
  return { status: 'missing', normalizedTarget: normalized };
}

function normalizeWikiTarget(value: string): string {
  const normalized = value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .trim();
  if (!normalized) return normalized;
  return normalized.endsWith('.md') ? normalized : `${normalized}.md`;
}

function hasRequiredValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function mapToSortedRecord(source: Map<string, Set<string>>): Record<string, string[]> {
  const output: Record<string, string[]> = {};
  const sortedKeys = [...source.keys()].sort((a, b) => a.localeCompare(b));
  for (const key of sortedKeys) {
    output[key] = [...(source.get(key) ?? new Set<string>())].sort((a, b) => a.localeCompare(b));
  }
  return output;
}
