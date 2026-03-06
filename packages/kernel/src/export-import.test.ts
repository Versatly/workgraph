import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initWorkspace } from './workspace.js';
import { exportWorkspaceSnapshot, importWorkspaceSnapshot } from './export-import.js';

let tempRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-export-import-'));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const portabilityTest = hasTarCommand() ? it : it.skip;

describe('workspace export/import', () => {
  portabilityTest('exports a workspace to tar.gz and imports into a new path', () => {
    const sourceWorkspacePath = path.join(tempRoot, 'source-workspace');
    initWorkspace(sourceWorkspacePath);
    fs.mkdirSync(path.join(sourceWorkspacePath, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(sourceWorkspacePath, 'docs', 'note.md'), '# Snapshot smoke test\n', 'utf-8');

    const snapshotPath = path.join(tempRoot, 'snapshots', 'workspace.tar.gz');
    const exportResult = exportWorkspaceSnapshot(sourceWorkspacePath, snapshotPath);
    expect(fs.existsSync(snapshotPath)).toBe(true);
    expect(exportResult.bytes).toBeGreaterThan(0);

    const importedWorkspacePath = path.join(tempRoot, 'imported-workspace');
    const importResult = importWorkspaceSnapshot(snapshotPath, importedWorkspacePath);
    expect(importResult.filesImported).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(importedWorkspacePath, '.workgraph.json'))).toBe(true);
    expect(fs.readFileSync(path.join(importedWorkspacePath, 'docs', 'note.md'), 'utf-8')).toContain('Snapshot');
  });

  portabilityTest('rejects importing into non-empty workspace unless overwrite is enabled', () => {
    const sourceWorkspacePath = path.join(tempRoot, 'source-workspace');
    initWorkspace(sourceWorkspacePath);
    const snapshotPath = path.join(tempRoot, 'snapshots', 'workspace.tar.gz');
    exportWorkspaceSnapshot(sourceWorkspacePath, snapshotPath);

    const existingWorkspacePath = path.join(tempRoot, 'existing-workspace');
    initWorkspace(existingWorkspacePath);

    expect(() => importWorkspaceSnapshot(snapshotPath, existingWorkspacePath)).toThrow(
      /already contains files/i,
    );
  });

  portabilityTest('supports overwriting an existing workspace on import', () => {
    const sourceWorkspacePath = path.join(tempRoot, 'source-workspace');
    initWorkspace(sourceWorkspacePath);
    fs.mkdirSync(path.join(sourceWorkspacePath, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(sourceWorkspacePath, 'docs', 'overwrite.md'), 'from source\n', 'utf-8');

    const snapshotPath = path.join(tempRoot, 'snapshots', 'workspace.tar.gz');
    exportWorkspaceSnapshot(sourceWorkspacePath, snapshotPath);

    const existingWorkspacePath = path.join(tempRoot, 'existing-workspace');
    initWorkspace(existingWorkspacePath);
    fs.mkdirSync(path.join(existingWorkspacePath, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(existingWorkspacePath, 'docs', 'old.md'), 'stale\n', 'utf-8');

    importWorkspaceSnapshot(snapshotPath, existingWorkspacePath, { overwrite: true });
    expect(fs.existsSync(path.join(existingWorkspacePath, 'docs', 'overwrite.md'))).toBe(true);
  });
});

function hasTarCommand(): boolean {
  const result = spawnSync('tar', ['--version'], { encoding: 'utf-8' });
  if (result.error) return false;
  return result.status === 0;
}
