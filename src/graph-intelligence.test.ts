import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, saveRegistry } from './registry.js';
import * as graph from './graph.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-graph-intel-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
  seedGraphWorkspace(workspacePath);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('graph intelligence features', () => {
  it('finds multi-hop neighborhoods and includes typed edges from frontmatter', () => {
    const neighborhood = graph.graphNeighborhoodQuery(workspacePath, 'ship-feature', { depth: 2 });

    expect(neighborhood.center.path).toBe('threads/ship-feature.md');
    expect(neighborhood.center.exists).toBe(true);
    expect(neighborhood.depth).toBe(2);
    expect(neighborhood.connectedNodes.map((node) => node.path)).toContain('agents/platform-agent.md');
    expect(
      neighborhood.edges.some((edge) =>
        edge.from === 'threads/ship-feature.md' &&
        edge.to === 'threads/collect-metrics.md' &&
        edge.type === 'depends_on'),
    ).toBe(true);
    expect(
      neighborhood.edges.some((edge) =>
        edge.from === 'threads/ship-feature.md' &&
        edge.to === 'lessons/cache-rollout.md' &&
        edge.type === 'wiki'),
    ).toBe(true);
  });

  it('performs impact analysis and groups reverse links by primitive type', () => {
    const impact = graph.graphImpactAnalysis(workspacePath, 'cache-latency');
    const groupTypes = impact.groups.map((group) => group.type);

    expect(impact.target.path).toBe('facts/cache-latency.md');
    expect(impact.target.exists).toBe(true);
    expect(impact.totalReferences).toBeGreaterThanOrEqual(2);
    expect(groupTypes).toContain('thread');
    expect(groupTypes).toContain('decision');
  });

  it('assembles context within token budget using direct neighbor priority', () => {
    const context = graph.graphContextAssembly(workspacePath, 'threads/ship-feature.md', {
      budgetTokens: 220,
    });
    const sectionPaths = context.sections.map((section) => section.path);

    expect(context.center.path).toBe('threads/ship-feature.md');
    expect(context.usedTokens).toBeLessThanOrEqual(220);
    expect(sectionPaths[0]).toBe('threads/ship-feature.md');
    expect(sectionPaths).toContain('decisions/use-cache.md');
    expect(sectionPaths).toContain('facts/cache-latency.md');
    expect(sectionPaths).toContain('lessons/cache-rollout.md');
    expect(sectionPaths).not.toContain('threads/collect-metrics.md');
    expect(context.markdown).toContain('## threads/ship-feature.md');
  });

  it('returns typed incoming and outgoing edges for one node', () => {
    const edges = graph.graphTypedEdges(workspacePath, 'ship-feature');

    expect(edges.node.path).toBe('threads/ship-feature.md');
    expect(edges.node.exists).toBe(true);
    expect(edges.outgoing.some((edge) => edge.type === 'context_refs' && edge.to === 'decisions/use-cache.md')).toBe(true);
    expect(edges.outgoing.some((edge) => edge.type === 'depends_on' && edge.to === 'threads/collect-metrics.md')).toBe(true);
    expect(edges.outgoing.some((edge) => edge.type === 'supports' && edge.to === 'facts/cache-latency.md')).toBe(true);
    expect(edges.incoming.some((edge) => edge.from === 'lessons/cache-rollout.md')).toBe(true);
  });

  it('exports a markdown subgraph directory for sharing', () => {
    const outputDir = path.join(workspacePath, 'exports', 'cache-subgraph');
    const result = graph.graphExportSubgraph(workspacePath, 'ship-feature', {
      depth: 1,
      format: 'md',
      outputDir,
    });

    expect(result.format).toBe('md');
    expect(result.center.path).toBe('threads/ship-feature.md');
    expect(result.exportedNodes).toContain('threads/ship-feature.md');
    expect(result.exportedNodes).toContain('decisions/use-cache.md');
    expect(fs.existsSync(path.join(result.outputDirectory, 'threads/ship-feature.md'))).toBe(true);
    expect(fs.existsSync(path.join(result.outputDirectory, 'decisions/use-cache.md'))).toBe(true);
    expect(fs.existsSync(path.join(result.outputDirectory, 'agents/platform-agent.md'))).toBe(false);
    expect(fs.existsSync(result.manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf-8')) as {
      nodes: string[];
      edges: Array<{ from: string; to: string; type: string }>;
    };
    expect(manifest.nodes).toContain('threads/ship-feature.md');
    expect(
      manifest.edges.some((edge) =>
        edge.from === 'threads/ship-feature.md' &&
        edge.to === 'facts/cache-latency.md' &&
        edge.type === 'supports'),
    ).toBe(true);
  });
});

function seedGraphWorkspace(workspace: string): void {
  writeMarkdown(
    workspace,
    'threads/ship-feature.md',
    [
      '---',
      'title: Ship Feature',
      'context_refs:',
      '  - decisions/use-cache',
      'depends_on:',
      '  - threads/collect-metrics',
      'supports:',
      '  - facts/cache-latency',
      '---',
      '',
      '# Ship Feature',
      '',
      'Main thread body references [[lessons/cache-rollout]].',
    ],
  );

  writeMarkdown(
    workspace,
    'decisions/use-cache.md',
    [
      '---',
      'title: Use Cache',
      'informs:',
      '  - threads/ship-feature',
      'contradicts:',
      '  - facts/no-cache',
      '---',
      '',
      '# Use Cache',
      '',
      'Decision details and data [[facts/cache-latency]].',
    ],
  );

  writeMarkdown(
    workspace,
    'facts/cache-latency.md',
    [
      '---',
      'title: Cache Latency Fact',
      'supersedes:',
      '  - facts/no-cache',
      '---',
      '',
      '# Cache Latency',
      '',
      'Measured p95 latency with cache enabled.',
    ],
  );

  writeMarkdown(
    workspace,
    'facts/no-cache.md',
    [
      '---',
      'title: No Cache Fact',
      '---',
      '',
      '# No Cache',
      '',
      'Historical baseline without caching.',
    ],
  );

  writeMarkdown(
    workspace,
    'lessons/cache-rollout.md',
    [
      '---',
      'title: Cache Rollout Lesson',
      '---',
      '',
      '# Cache Rollout Lesson',
      '',
      'Rollout lesson references [[threads/ship-feature]].',
    ],
  );

  writeMarkdown(
    workspace,
    'threads/collect-metrics.md',
    [
      '---',
      'title: Collect Metrics',
      '---',
      '',
      '# Collect Metrics',
      '',
      'This is an intentionally long context file to force budget decisions.',
      '',
      longBodyParagraph(40),
      '',
      'See [[agents/platform-agent]].',
    ],
  );

  writeMarkdown(
    workspace,
    'agents/platform-agent.md',
    [
      '---',
      'name: platform-agent',
      '---',
      '',
      '# Platform Agent',
      '',
      'Maintains platform-level quality and operations.',
    ],
  );
}

function writeMarkdown(workspace: string, relPath: string, lines: string[]): void {
  const absPath = path.join(workspace, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, lines.join('\n') + '\n', 'utf-8');
}

function longBodyParagraph(repetitions: number): string {
  const sentence = 'Collect and verify metrics for cache readiness across environments.';
  return new Array(repetitions).fill(sentence).join(' ');
}
