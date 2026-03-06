import path from 'node:path';
import { spawnSync } from 'node:child_process';
import fs from './storage-fs.js';

export interface WorkspaceArchiveResult {
  workspacePath: string;
  archivePath: string;
  entryCount: number;
}

export interface ImportWorkspaceOptions {
  replaceExisting?: boolean;
}

export function exportWorkspace(workspacePath: string, archivePath: string): WorkspaceArchiveResult {
  const resolvedWorkspace = path.resolve(workspacePath);
  const resolvedArchive = path.resolve(archivePath);

  if (!fs.existsSync(resolvedWorkspace)) {
    throw new Error(`Workspace not found: ${resolvedWorkspace}`);
  }
  if (!isDirectory(resolvedWorkspace)) {
    throw new Error(`Workspace path must be a directory: ${resolvedWorkspace}`);
  }
  if (isPathWithinWorkspace(resolvedArchive, resolvedWorkspace)) {
    throw new Error('Archive output must be outside the workspace directory.');
  }

  ensureParentDir(resolvedArchive);
  runTarCommand(['-czf', resolvedArchive, '-C', resolvedWorkspace, '.'], 'workspace export failed');

  return {
    workspacePath: resolvedWorkspace,
    archivePath: resolvedArchive,
    entryCount: countWorkspaceEntries(resolvedWorkspace),
  };
}

export function importWorkspace(
  workspacePath: string,
  archivePath: string,
  options: ImportWorkspaceOptions = {},
): WorkspaceArchiveResult {
  const resolvedWorkspace = path.resolve(workspacePath);
  const resolvedArchive = path.resolve(archivePath);
  const replaceExisting = options.replaceExisting !== false;

  if (!fs.existsSync(resolvedArchive)) {
    throw new Error(`Archive not found: ${resolvedArchive}`);
  }
  if (!isFile(resolvedArchive)) {
    throw new Error(`Archive path must be a file: ${resolvedArchive}`);
  }

  if (!fs.existsSync(resolvedWorkspace)) {
    fs.mkdirSync(resolvedWorkspace, { recursive: true });
  } else if (!isDirectory(resolvedWorkspace)) {
    throw new Error(`Workspace path must be a directory: ${resolvedWorkspace}`);
  }

  if (replaceExisting) {
    if (isPathWithinWorkspace(resolvedArchive, resolvedWorkspace)) {
      throw new Error('Cannot replace workspace when archive file is inside the workspace.');
    }
    clearDirectory(resolvedWorkspace);
  }

  runTarCommand(['-xzf', resolvedArchive, '-C', resolvedWorkspace], 'workspace import failed');

  return {
    workspacePath: resolvedWorkspace,
    archivePath: resolvedArchive,
    entryCount: countWorkspaceEntries(resolvedWorkspace),
  };
}

function runTarCommand(args: string[], prefix: string): void {
  const result = spawnSync('tar', args, {
    encoding: 'utf-8',
  });
  if (result.error) {
    throw new Error(`${prefix}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? '').trim();
    throw new Error(`${prefix}: ${stderr || 'tar exited non-zero'}`);
  }
}

function clearDirectory(dirPath: string): void {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    fs.rmSync(path.join(dirPath, entry.name), { recursive: true, force: true });
  }
}

function countWorkspaceEntries(workspacePath: string): number {
  let count = 0;
  const stack = [workspacePath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      count += 1;
      if (entry.isDirectory()) {
        stack.push(path.join(current, entry.name));
      }
    }
  }
  return count;
}

function ensureParentDir(targetPath: string): void {
  const parentDir = path.dirname(targetPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }
}

function isDirectory(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function isFile(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isFile();
  } catch {
    return false;
  }
}

function isPathWithinWorkspace(candidatePath: string, workspacePath: string): boolean {
  const relative = path.relative(workspacePath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
