import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LocalStorageAdapter, type StorageAdapter } from './storage-adapter.js';

export interface ExportWorkspaceSnapshotOptions {
  storageAdapter?: StorageAdapter;
}

export interface ExportWorkspaceSnapshotResult {
  workspacePath: string;
  snapshotPath: string;
  bytes: number;
  createdAt: string;
  adapterKind: 'local';
}

export interface ImportWorkspaceSnapshotOptions {
  overwrite?: boolean;
  storageAdapter?: StorageAdapter;
}

export interface ImportWorkspaceSnapshotResult {
  workspacePath: string;
  snapshotPath: string;
  filesImported: number;
  importedAt: string;
  adapterKind: 'local';
}

export function exportWorkspaceSnapshot(
  workspacePath: string,
  snapshotPath: string,
  options: ExportWorkspaceSnapshotOptions = {},
): ExportWorkspaceSnapshotResult {
  const adapter = options.storageAdapter ?? new LocalStorageAdapter();
  assertLocalAdapter(adapter, 'export');

  const absoluteWorkspacePath = adapter.resolve(workspacePath);
  if (!adapter.exists(absoluteWorkspacePath)) {
    throw new Error(`Workspace path does not exist: ${absoluteWorkspacePath}`);
  }
  if (!adapter.stat(absoluteWorkspacePath).isDirectory()) {
    throw new Error(`Workspace path must be a directory: ${absoluteWorkspacePath}`);
  }

  const absoluteSnapshotPath = adapter.resolve(snapshotPath);
  adapter.mkdir(path.dirname(absoluteSnapshotPath), { recursive: true });

  // Use tar so snapshots remain standard tar.gz archives across environments.
  runTarCommand([
    '-czf',
    absoluteSnapshotPath,
    '-C',
    absoluteWorkspacePath,
    '.',
  ]);

  const snapshotStats = adapter.stat(absoluteSnapshotPath);
  return {
    workspacePath: absoluteWorkspacePath,
    snapshotPath: absoluteSnapshotPath,
    bytes: snapshotStats.size,
    createdAt: new Date().toISOString(),
    adapterKind: 'local',
  };
}

export function importWorkspaceSnapshot(
  snapshotPath: string,
  workspacePath: string,
  options: ImportWorkspaceSnapshotOptions = {},
): ImportWorkspaceSnapshotResult {
  const adapter = options.storageAdapter ?? new LocalStorageAdapter();
  assertLocalAdapter(adapter, 'import');

  const absoluteSnapshotPath = adapter.resolve(snapshotPath);
  if (!adapter.exists(absoluteSnapshotPath)) {
    throw new Error(`Snapshot file does not exist: ${absoluteSnapshotPath}`);
  }
  if (!adapter.stat(absoluteSnapshotPath).isFile()) {
    throw new Error(`Snapshot path must be a file: ${absoluteSnapshotPath}`);
  }

  const absoluteWorkspacePath = adapter.resolve(workspacePath);
  const overwrite = options.overwrite === true;
  if (adapter.exists(absoluteWorkspacePath) && !overwrite && !isDirectoryEmpty(adapter, absoluteWorkspacePath)) {
    throw new Error(
      `Workspace path already contains files. Use overwrite to replace existing content: ${absoluteWorkspacePath}`,
    );
  }

  const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workgraph-import-'));
  try {
    runTarCommand([
      '-xzf',
      absoluteSnapshotPath,
      '-C',
      extractionRoot,
    ]);

    if (overwrite && adapter.exists(absoluteWorkspacePath)) {
      adapter.rm(absoluteWorkspacePath, { recursive: true, force: true });
    }
    adapter.mkdir(absoluteWorkspacePath, { recursive: true });

    const entries = fs.readdirSync(extractionRoot);
    for (const entry of entries) {
      const sourceEntryPath = path.join(extractionRoot, entry);
      const destinationEntryPath = path.join(absoluteWorkspacePath, entry);
      fs.cpSync(sourceEntryPath, destinationEntryPath, {
        recursive: true,
        force: overwrite,
        errorOnExist: !overwrite,
      });
    }

    return {
      workspacePath: absoluteWorkspacePath,
      snapshotPath: absoluteSnapshotPath,
      filesImported: countFilesRecursively(extractionRoot),
      importedAt: new Date().toISOString(),
      adapterKind: 'local',
    };
  } finally {
    fs.rmSync(extractionRoot, { recursive: true, force: true });
  }
}

function assertLocalAdapter(adapter: StorageAdapter, operation: 'export' | 'import'): void {
  if (adapter.kind !== 'local') {
    throw new Error(`Cloud storage adapter is not yet supported for workspace ${operation}.`);
  }
}

function isDirectoryEmpty(adapter: StorageAdapter, targetPath: string): boolean {
  if (!adapter.exists(targetPath)) return true;
  if (!adapter.stat(targetPath).isDirectory()) return false;
  return adapter.readdir(targetPath).length === 0;
}

function runTarCommand(args: string[]): void {
  const result = spawnSync('tar', args, {
    encoding: 'utf-8',
  });
  if (!result.error && result.status === 0) return;

  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new Error('Failed to execute tar command. Ensure tar is installed and available on PATH.');
  }

  const details = (result.stderr || result.stdout || '').trim();
  throw new Error(`tar command failed: ${details || `exit status ${String(result.status)}`}`);
}

function countFilesRecursively(rootPath: string): number {
  if (!fs.existsSync(rootPath)) return 0;
  const stats = fs.statSync(rootPath);
  if (stats.isFile()) return 1;
  if (!stats.isDirectory()) return 0;

  let total = 0;
  for (const entry of fs.readdirSync(rootPath)) {
    total += countFilesRecursively(path.join(rootPath, entry));
  }
  return total;
}
