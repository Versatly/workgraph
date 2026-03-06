import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initWorkspace } from './workspace.js';
import * as thread from './thread.js';
import { exportWorkspace, importWorkspace } from './portability.js';

describe('workspace portability', () => {
  let tempRoot: string;
  let sourceWorkspace: string;
  let targetWorkspace: string;
  let archivePath: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-portability-'));
    sourceWorkspace = path.join(tempRoot, 'source');
    targetWorkspace = path.join(tempRoot, 'target');
    archivePath = path.join(tempRoot, 'workspace-snapshot.tar.gz');
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('round-trips workspace content through export/import archive', () => {
    initWorkspace(sourceWorkspace);
    const created = thread.createThread(
      sourceWorkspace,
      'Portable Thread',
      'Validate export/import parity',
      'agent-portable',
    );

    const exported = exportWorkspace(sourceWorkspace, archivePath);
    expect(fs.existsSync(exported.archivePath)).toBe(true);
    expect(exported.entryCount).toBeGreaterThan(0);

    const imported = importWorkspace(targetWorkspace, archivePath);
    expect(imported.entryCount).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(targetWorkspace, '.workgraph', 'ledger.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(targetWorkspace, '.workgraph', 'registry.json'))).toBe(true);
    expect(fs.existsSync(path.join(targetWorkspace, '.workgraph.json'))).toBe(true);
    expect(fs.existsSync(path.join(targetWorkspace, 'policies', 'thread-lifecycle.md'))).toBe(true);

    const sourceThread = fs.readFileSync(path.join(sourceWorkspace, created.path), 'utf-8');
    const importedThread = fs.readFileSync(path.join(targetWorkspace, created.path), 'utf-8');
    expect(importedThread).toBe(sourceThread);
  });
});
