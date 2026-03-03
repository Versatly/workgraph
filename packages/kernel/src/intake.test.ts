import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as ledger from './ledger.js';
import { intake } from './intake.js';
import * as registry from './registry.js';
import * as thread from './thread.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-intake-'));
  registry.saveRegistry(workspacePath, registry.loadRegistry(workspacePath));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('thread intake', () => {
  it('creates a thread with minted T-ID and create ledger event', () => {
    const created = intake(workspacePath, {
      title: 'Implement Auth Service',
      actor: 'agent-intake',
    });
    expect(created.path).toBe('threads/implement-auth-service.md');
    expect(created.fields.tid).toBe('implement-auth-service');

    const entries = ledger.historyOf(workspacePath, created.path);
    expect(entries.some((entry) => entry.op === 'create')).toBe(true);
  });

  it('mints unique T-IDs for duplicate titles', () => {
    const first = intake(workspacePath, {
      title: 'Duplicate title',
      actor: 'agent-intake',
    });
    const second = intake(workspacePath, {
      title: 'Duplicate title',
      actor: 'agent-intake',
    });
    expect(first.fields.tid).toBe('duplicate-title');
    expect(second.fields.tid).toBe('duplicate-title-2');
    expect(second.path).toBe('threads/duplicate-title-2.md');
  });

  it('normalizes parent references when provided', () => {
    const parent = thread.createThread(workspacePath, 'Parent task', 'parent goal', 'agent-root');
    const child = intake(workspacePath, {
      title: 'Child task',
      actor: 'agent-intake',
      parent: parent.path,
    });
    expect(child.fields.parent).toBe(parent.path);
  });

  it('supports bare parent slugs and normalizes to threads/*.md', () => {
    const parent = thread.createThread(workspacePath, 'Parent slug task', 'parent goal', 'agent-root');
    const bareParent = String(parent.fields.tid);
    const child = intake(workspacePath, {
      title: 'Child by slug',
      actor: 'agent-intake',
      parent: bareParent,
    });
    expect(child.fields.parent).toBe(parent.path);
  });

  it('normalizes space refs and adds them to context_refs', () => {
    const created = intake(workspacePath, {
      title: 'Space-scoped task',
      actor: 'agent-intake',
      space: 'spaces/platform',
    });
    expect(created.fields.space).toBe('spaces/platform.md');
    expect(created.fields.context_refs).toEqual(['spaces/platform.md']);
  });

  it('sets priority default and allows override', () => {
    const defaultPriority = intake(workspacePath, {
      title: 'Default priority task',
      actor: 'agent-intake',
    });
    const highPriority = intake(workspacePath, {
      title: 'High priority task',
      actor: 'agent-intake',
      priority: 'high',
    });
    expect(defaultPriority.fields.priority).toBe('medium');
    expect(highPriority.fields.priority).toBe('high');
  });

  it('sets terminal lock true by default', () => {
    const created = intake(workspacePath, {
      title: 'Terminal lock default',
      actor: 'agent-intake',
    });
    expect(created.fields.terminalLock).toBe(true);
  });

  it('rejects empty title and empty actor inputs', () => {
    expect(() =>
      intake(workspacePath, { title: '   ', actor: 'agent-intake' }),
    ).toThrow('non-empty title');
    expect(() =>
      intake(workspacePath, { title: 'Valid title', actor: '   ' }),
    ).toThrow('non-empty actor');
  });
});
