import * as ledger from '../ledger.js';
import { buildPrimitiveWikiGraph, loadPrimitiveInventory, type PrimitiveNode } from './primitives.js';

export interface VaultStats {
  generatedAt: string;
  workspacePath: string;
  primitives: {
    total: number;
    byType: Record<string, number>;
  };
  links: {
    total: number;
    wikiLinkDensity: number;
    graphDensityRatio: number;
    orphanCount: number;
    orphanNodeCount: number;
    mostConnectedNodes: Array<{ path: string; degree: number }>;
  };
  frontmatter: {
    averageCompleteness: number;
    byType: Record<string, number>;
  };
  ledger: {
    totalEvents: number;
    eventRatePerDay: {
      average: number;
      byDay: Array<{ day: string; count: number }>;
    };
  };
  threads: {
    completedCount: number;
    averageOpenToDoneHours: number;
  };
}

export function computeVaultStats(workspacePath: string): VaultStats {
  const inventory = loadPrimitiveInventory(workspacePath);
  const primitiveGraph = buildPrimitiveWikiGraph(workspacePath, inventory);
  const byType = buildPrimitiveCountByType(inventory.primitives);
  const frontmatter = computeFrontmatterStats(inventory.primitives);
  const allEntries = ledger.readAll(workspacePath);
  const eventRate = computeEventRatePerDay(allEntries);
  const threadVelocity = computeThreadVelocity(workspacePath, inventory.byType.get('thread') ?? []);
  const nodeCount = primitiveGraph.nodes.length;
  const edgeCount = primitiveGraph.edges.length;
  const possibleDirectedEdges = nodeCount > 1 ? nodeCount * (nodeCount - 1) : 0;

  return {
    generatedAt: new Date().toISOString(),
    workspacePath,
    primitives: {
      total: inventory.primitives.length,
      byType,
    },
    links: {
      total: edgeCount,
      wikiLinkDensity: nodeCount > 0 ? edgeCount / nodeCount : 0,
      graphDensityRatio: possibleDirectedEdges > 0 ? edgeCount / possibleDirectedEdges : 0,
      orphanCount: primitiveGraph.missingLinks.length,
      orphanNodeCount: primitiveGraph.orphanNodes.length,
      mostConnectedNodes: primitiveGraph.hubs.slice(0, 10),
    },
    frontmatter,
    ledger: {
      totalEvents: allEntries.length,
      eventRatePerDay: eventRate,
    },
    threads: threadVelocity,
  };
}

function buildPrimitiveCountByType(primitives: PrimitiveNode[]): Record<string, number> {
  const byType = primitives.reduce<Record<string, number>>((acc, primitive) => {
    acc[primitive.type] = (acc[primitive.type] ?? 0) + 1;
    return acc;
  }, {});
  return Object.keys(byType)
    .sort((a, b) => a.localeCompare(b))
    .reduce<Record<string, number>>((acc, typeName) => {
      acc[typeName] = byType[typeName];
      return acc;
    }, {});
}

function computeFrontmatterStats(primitives: PrimitiveNode[]): VaultStats['frontmatter'] {
  if (primitives.length === 0) {
    return {
      averageCompleteness: 1,
      byType: {},
    };
  }

  const totalsByType = new Map<string, { sum: number; count: number }>();
  let sum = 0;
  for (const primitive of primitives) {
    sum += primitive.frontmatterCompleteness;
    const current = totalsByType.get(primitive.type) ?? { sum: 0, count: 0 };
    current.sum += primitive.frontmatterCompleteness;
    current.count += 1;
    totalsByType.set(primitive.type, current);
  }

  const byType = [...totalsByType.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .reduce<Record<string, number>>((acc, [typeName, stats]) => {
      acc[typeName] = stats.count > 0 ? stats.sum / stats.count : 1;
      return acc;
    }, {});

  return {
    averageCompleteness: sum / primitives.length,
    byType,
  };
}

function computeEventRatePerDay(entries: ReturnType<typeof ledger.readAll>): VaultStats['ledger']['eventRatePerDay'] {
  if (entries.length === 0) {
    return {
      average: 0,
      byDay: [],
    };
  }
  const byDay = new Map<string, number>();
  for (const entry of entries) {
    const day = entry.ts.slice(0, 10);
    if (!day) continue;
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const dayCounts = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, count]) => ({ day, count }));
  const totalCount = dayCounts.reduce((acc, item) => acc + item.count, 0);
  return {
    average: dayCounts.length > 0 ? totalCount / dayCounts.length : 0,
    byDay: dayCounts,
  };
}

function computeThreadVelocity(
  workspacePath: string,
  threads: PrimitiveNode[],
): VaultStats['threads'] {
  const durationsHours: number[] = [];
  for (const thread of threads) {
    const history = ledger.historyOf(workspacePath, thread.path);
    const createEntry = history.find((entry) => entry.op === 'create');
    const completionEntry = history.find((entry) =>
      entry.op === 'done' ||
      (entry.op === 'update' && String(entry.data?.to_status ?? '') === 'done')
    );
    if (!createEntry || !completionEntry) continue;
    const start = Date.parse(createEntry.ts);
    const end = Date.parse(completionEntry.ts);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    durationsHours.push((end - start) / (1000 * 60 * 60));
  }

  const sum = durationsHours.reduce((acc, value) => acc + value, 0);
  return {
    completedCount: durationsHours.length,
    averageOpenToDoneHours: durationsHours.length > 0 ? sum / durationsHours.length : 0,
  };
}
