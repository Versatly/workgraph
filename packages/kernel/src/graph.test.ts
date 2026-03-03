import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, saveRegistry } from './registry.js';
import {
  buildWikiLinkGraph,
  graphContextAssembly,
  graphExportSubgraph,
  graphHygieneReport,
  graphIndexPath,
  graphNeighborhood,
  graphNeighborhoodQuery,
  graphTypedEdges,
  readWikiLinkGraphIndex,
  refreshWikiLinkGraphIndex,
} from './graph.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-graph-core-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('graph core module', () => {
  it('builds graph edges from body and frontmatter, including broken links', () => {
    writeMarkdown('threads/plan-api.md', [
      '---',
      'title: Plan API',
      'context_refs:',
      '  - decisions/auth-approach',
      'depends_on: [[threads/setup-db]]',
      'supports:',
      '  - facts/p95-latency',
      '---',
      '',
      '# Plan API',
      '',
      'Need [[threads/setup-db|DB setup]] and docs [[https://example.com/api]].',
    ]);
    writeMarkdown('threads/setup-db.md', ['# Setup DB', '', 'Ready.']);
    writeMarkdown('decisions/auth-approach.md', ['# Auth Decision', '', 'Use token auth.']);

    const graph = buildWikiLinkGraph(workspacePath);
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        'threads/plan-api.md',
        'threads/setup-db.md',
        'decisions/auth-approach.md',
      ]),
    );
    expect(
      graph.edges.some((edge) =>
        edge.from === 'threads/plan-api.md' &&
        edge.to === 'threads/setup-db.md' &&
        edge.type === 'wiki' &&
        edge.source === 'body'),
    ).toBe(true);
    expect(
      graph.edges.some((edge) =>
        edge.from === 'threads/plan-api.md' &&
        edge.to === 'threads/setup-db.md' &&
        edge.type === 'depends_on' &&
        edge.source === 'frontmatter'),
    ).toBe(true);
    expect(
      graph.edges.some((edge) =>
        edge.from === 'threads/plan-api.md' &&
        edge.to === 'decisions/auth-approach.md' &&
        edge.type === 'context_refs'),
    ).toBe(true);
    expect(graph.brokenLinks).toContainEqual({
      from: 'threads/plan-api.md',
      to: 'facts/p95-latency.md',
    });
    expect(graph.brokenLinks.some((entry) => entry.to.includes('https://example.com'))).toBe(false);
  });

  it('refreshes and reads graph index; malformed index reads as null', () => {
    writeMarkdown('threads/root.md', ['# Root', '', 'Links [[threads/child]].']);
    writeMarkdown('threads/child.md', ['# Child', '', 'No outgoing links.']);

    const refreshed = refreshWikiLinkGraphIndex(workspacePath);
    expect(refreshed.nodes).toContain('threads/root.md');

    const readBack = readWikiLinkGraphIndex(workspacePath);
    expect(readBack?.edges.length).toBe(refreshed.edges.length);

    fs.writeFileSync(graphIndexPath(workspacePath), '{ invalid json', 'utf-8');
    expect(readWikiLinkGraphIndex(workspacePath)).toBeNull();
  });

  it('resolves unique slug refs and reports missing neighborhood nodes', () => {
    writeMarkdown('threads/alpha.md', ['# Alpha', '', 'See [[threads/beta]].']);
    writeMarkdown('threads/beta.md', ['# Beta', '', 'See [[threads/alpha]].']);

    const found = graphNeighborhood(workspacePath, 'alpha');
    expect(found.exists).toBe(true);
    expect(found.node).toBe('threads/alpha.md');
    expect(found.outgoing).toContain('threads/beta.md');
    expect(found.incoming).toContain('threads/beta.md');

    const missing = graphNeighborhood(workspacePath, 'no-such-node');
    expect(missing.exists).toBe(false);
    expect(missing.outgoing).toEqual([]);
    expect(missing.incoming).toEqual([]);
  });

  it('throws on ambiguous graph refs that map to multiple slugs', () => {
    writeMarkdown('threads/shared.md', ['# Thread Shared']);
    writeMarkdown('facts/shared.md', ['# Fact Shared']);

    expect(() => graphNeighborhood(workspacePath, 'shared')).toThrow('Ambiguous graph ref "shared"');
  });

  it('returns empty neighborhood query for missing center and supports typed-edge miss', () => {
    writeMarkdown('threads/a.md', ['# A', '', '[[threads/b]]']);
    writeMarkdown('threads/b.md', ['# B']);

    const missingQuery = graphNeighborhoodQuery(workspacePath, 'missing-thread', { depth: 2 });
    expect(missingQuery.center.exists).toBe(false);
    expect(missingQuery.connectedNodes).toEqual([]);
    expect(missingQuery.edges).toEqual([]);

    const typedMissing = graphTypedEdges(workspacePath, 'missing-thread');
    expect(typedMissing.node.exists).toBe(false);
    expect(typedMissing.outgoing).toEqual([]);
    expect(typedMissing.incoming).toEqual([]);
  });

  it('assembles context with truncation marker under constrained budget', () => {
    writeMarkdown('threads/center.md', [
      '# Center',
      '',
      repeatSentence('Very long body content for budget checks.', 80),
      '',
      'Ref [[threads/neighbor]].',
    ]);
    writeMarkdown('threads/neighbor.md', ['# Neighbor', '', 'Neighbor body.']);

    const assembly = graphContextAssembly(workspacePath, 'threads/center.md', {
      budgetTokens: 80,
    });

    expect(assembly.center.path).toBe('threads/center.md');
    expect(assembly.sections.length).toBeGreaterThan(0);
    expect(assembly.markdown).toContain('# Workgraph context: threads/center.md');
    expect(assembly.markdown).toContain('...[truncated for budget]');
  });

  it('exports a subgraph and rejects unsupported export formats', () => {
    writeMarkdown('threads/root.md', ['# Root', '', 'Links [[threads/child]].']);
    writeMarkdown('threads/child.md', ['# Child', '', 'No links.']);

    const exportResult = graphExportSubgraph(workspacePath, 'threads/root.md', {
      depth: 1,
      outputDir: 'tmp/subgraph-export',
    });

    expect(exportResult.format).toBe('md');
    expect(exportResult.exportedNodes).toContain('threads/root.md');
    expect(fs.existsSync(path.join(exportResult.outputDirectory, 'threads/root.md'))).toBe(true);
    expect(fs.existsSync(exportResult.manifestPath)).toBe(true);

    expect(() =>
      graphExportSubgraph(workspacePath, 'threads/root.md', { format: 'json' as 'md' }),
    ).toThrow('Unsupported export format "json"');

    expect(() => graphExportSubgraph(workspacePath, 'threads/missing.md')).toThrow(
      'Graph node not found: threads/missing.md',
    );
  });

  it('summarizes hygiene report counts from indexed graph', () => {
    writeMarkdown('threads/linked-a.md', ['# A', '', '[[threads/linked-b]]']);
    writeMarkdown('threads/linked-b.md', ['# B']);
    writeMarkdown('threads/orphan.md', ['# Orphan']);

    const hygiene = graphHygieneReport(workspacePath);
    expect(hygiene.nodeCount).toBe(3);
    expect(hygiene.edgeCount).toBeGreaterThanOrEqual(1);
    expect(hygiene.orphans).toContain('threads/orphan.md');
  });
});

function writeMarkdown(relPath: string, lines: string[]): void {
  const absPath = path.join(workspacePath, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, lines.join('\n') + '\n', 'utf-8');
}

function repeatSentence(sentence: string, count: number): string {
  return new Array(count).fill(sentence).join(' ');
}
