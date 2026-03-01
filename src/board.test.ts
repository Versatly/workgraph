import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, saveRegistry } from './registry.js';
import { generateKanbanBoard, syncKanbanBoard } from './board.js';
import * as thread from './thread.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-board-core-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('board core module', () => {
  it('groups thread statuses into board counts and default lanes', () => {
    thread.createThread(workspacePath, 'Backlog item', 'pending', 'agent-a');

    thread.createThread(workspacePath, 'Active item', 'doing', 'agent-a');
    thread.claim(workspacePath, 'threads/active-item.md', 'agent-a');

    thread.createThread(workspacePath, 'Blocked item', 'waiting', 'agent-a');
    thread.claim(workspacePath, 'threads/blocked-item.md', 'agent-a');
    thread.block(workspacePath, 'threads/blocked-item.md', 'agent-a', 'external/dependency');

    thread.createThread(workspacePath, 'Done item', 'done', 'agent-a');
    thread.claim(workspacePath, 'threads/done-item.md', 'agent-a');
    thread.done(workspacePath, 'threads/done-item.md', 'agent-a', 'finished https://github.com/versatly/workgraph/pull/26');

    thread.createThread(workspacePath, 'Cancelled item', 'cancelled', 'agent-a');
    thread.cancel(workspacePath, 'threads/cancelled-item.md', 'agent-a', 'not needed');

    const result = generateKanbanBoard(workspacePath, {
      outputPath: 'ops/Board.md',
    });

    expect(result.counts).toEqual({
      backlog: 1,
      inProgress: 1,
      blocked: 1,
      done: 1,
      cancelled: 1,
    });
    expect(result.content).toContain('## Backlog');
    expect(result.content).toContain('## In Progress');
    expect(result.content).toContain('## Blocked');
    expect(result.content).toContain('## Done');
    expect(result.content).not.toContain('## Cancelled');
    expect(fs.existsSync(path.join(workspacePath, 'ops/Board.md'))).toBe(true);
  });

  it('includes cancelled lane when includeCancelled is enabled', () => {
    thread.createThread(workspacePath, 'Cancelled item', 'cancel me', 'agent-a');
    thread.cancel(workspacePath, 'threads/cancelled-item.md', 'agent-a', 'out of scope');

    const result = generateKanbanBoard(workspacePath, {
      includeCancelled: true,
      outputPath: 'ops/BoardWithCancelled.md',
    });

    expect(result.content).toContain('## Cancelled');
    expect(result.content).toContain('- [x] [[threads/cancelled-item.md|Cancelled item]]');
  });

  it('orders lane items by priority rank and title fallback', () => {
    thread.createThread(workspacePath, 'Low task', 'low', 'agent-a', { priority: 'low' });
    thread.createThread(workspacePath, 'High task', 'high', 'agent-a', { priority: 'high' });
    thread.createThread(workspacePath, 'Urgent task', 'urgent', 'agent-a', { priority: 'urgent' });

    const result = generateKanbanBoard(workspacePath, {
      outputPath: 'ops/PriorityBoard.md',
    });

    const urgentIndex = result.content.indexOf('Urgent task');
    const highIndex = result.content.indexOf('High task');
    const lowIndex = result.content.indexOf('Low task');
    expect(urgentIndex).toBeGreaterThanOrEqual(0);
    expect(highIndex).toBeGreaterThanOrEqual(0);
    expect(lowIndex).toBeGreaterThanOrEqual(0);
    expect(urgentIndex).toBeLessThan(highIndex);
    expect(highIndex).toBeLessThan(lowIndex);
  });

  it('syncKanbanBoard delegates to generation and writes output', () => {
    thread.createThread(workspacePath, 'Sync item', 'sync this board', 'agent-a');

    const result = syncKanbanBoard(workspacePath, {
      outputPath: 'ops/SyncBoard.md',
    });
    const boardPath = path.join(workspacePath, 'ops/SyncBoard.md');

    expect(result.outputPath).toBe('ops/SyncBoard.md');
    expect(fs.existsSync(boardPath)).toBe(true);
    expect(fs.readFileSync(boardPath, 'utf-8')).toContain('Sync item');
  });

  it('defaults output path to ops/Workgraph Board.md', () => {
    thread.createThread(workspacePath, 'Default path item', 'default output', 'agent-a');

    const result = generateKanbanBoard(workspacePath);
    expect(result.outputPath).toBe('ops/Workgraph Board.md');
    expect(fs.existsSync(path.join(workspacePath, 'ops/Workgraph Board.md'))).toBe(true);
  });

  it('rejects output paths that escape workspace root', () => {
    expect(() =>
      generateKanbanBoard(workspacePath, {
        outputPath: '../outside-board.md',
      }),
    ).toThrow('Invalid board output path');
  });
});
