import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadRegistry, saveRegistry } from './registry.js';
import * as thread from './thread.js';
import * as board from './board.js';
import * as graph from './graph.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-graph-board-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('graph index and board generation', () => {
  it('generates obsidian kanban-compatible board markdown', () => {
    thread.createThread(workspacePath, 'Backlog item', 'todo', 'agent-a');
    thread.createThread(workspacePath, 'Active item', 'in progress', 'agent-a');
    thread.claim(workspacePath, 'threads/active-item.md', 'agent-a');
    thread.createThread(workspacePath, 'Done item', 'done', 'agent-a');
    thread.claim(workspacePath, 'threads/done-item.md', 'agent-a');
    thread.done(workspacePath, 'threads/done-item.md', 'agent-a', 'done');

    const result = board.generateKanbanBoard(workspacePath, {
      outputPath: 'ops/Kanban.md',
    });
    const boardFile = path.join(workspacePath, 'ops/Kanban.md');
    expect(fs.existsSync(boardFile)).toBe(true);
    expect(result.outputPath).toBe('ops/Kanban.md');

    const content = fs.readFileSync(boardFile, 'utf-8');
    expect(content).toContain('kanban-plugin: board');
    expect(content).toContain('## Backlog');
    expect(content).toContain('## In Progress');
    expect(content).toContain('## Done');
    expect(content).toContain('%% kanban:settings');
  });

  it('indexes wiki-links and reports hygiene findings', () => {
    fs.writeFileSync(
      path.join(workspacePath, 'alpha.md'),
      '# Alpha\n\nLinks: [[beta#Section]] [[missing-note|Missing Note]]\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(workspacePath, 'beta.md'),
      '# Beta\n\nBacklink [[alpha]]\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(workspacePath, 'orphan.md'),
      '# Orphan\n\nNo links.\n',
      'utf-8',
    );

    const index = graph.refreshWikiLinkGraphIndex(workspacePath);
    expect(index.nodes).toContain('alpha.md');
    expect(index.edges.length).toBeGreaterThanOrEqual(3);
    expect(index.brokenLinks.some((entry) => entry.to === 'missing-note.md')).toBe(true);

    const hygiene = graph.graphHygieneReport(workspacePath);
    expect(hygiene.orphans).toContain('orphan.md');
    expect(hygiene.brokenLinkCount).toBeGreaterThan(0);

    const neighborhood = graph.graphNeighborhood(workspacePath, 'alpha.md');
    expect(neighborhood.exists).toBe(true);
    expect(neighborhood.outgoing).toContain('beta.md');
    expect(neighborhood.outgoing).toContain('missing-note.md');
    expect(neighborhood.outgoing).not.toContain('beta#Section.md');
    expect(neighborhood.incoming).toContain('beta.md');
  });
});
