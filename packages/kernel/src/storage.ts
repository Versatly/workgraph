import fs from 'node:fs';
import path from 'node:path';

export type StorageMode = 'local' | 'cloud';

export interface StorageAdapter {
  readonly kind: StorageMode;
  existsSync: (...args: any[]) => boolean;
  readFileSync: (...args: any[]) => any;
  writeFileSync: (...args: any[]) => void;
  appendFileSync: (...args: any[]) => void;
  mkdirSync: (...args: any[]) => any;
  rmSync: (...args: any[]) => any;
  renameSync: (...args: any[]) => void;
  readdirSync: (...args: any[]) => any;
  openSync: (...args: any[]) => number;
  closeSync: (...args: any[]) => void;
  statSync: (...args: any[]) => fs.Stats;
  lstatSync: (...args: any[]) => fs.Stats;
  mkdtempSync: (...args: any[]) => string;
  cpSync: (...args: any[]) => void;
  copyFileSync: (...args: any[]) => void;
}

export interface CloudStorageAdapter extends StorageAdapter {
  readonly kind: 'cloud';
  readonly provider: string;
  queueOperation?: (operation: {
    ts: string;
    op: string;
    target?: string;
    data?: Record<string, unknown>;
  }) => void;
  replayQueuedOperations?: () => number;
}

export class LocalStorageAdapter implements StorageAdapter {
  public readonly kind: StorageMode = 'local';
  public existsSync(...args: any[]): boolean { return fs.existsSync(args[0]); }
  public readFileSync(...args: any[]): any { return fs.readFileSync(args[0], args[1]); }
  public writeFileSync(...args: any[]): void { fs.writeFileSync(args[0], args[1], args[2]); }
  public appendFileSync(...args: any[]): void { fs.appendFileSync(args[0], args[1], args[2]); }
  public mkdirSync(...args: any[]): any { return fs.mkdirSync(args[0], args[1]); }
  public rmSync(...args: any[]): any { return fs.rmSync(args[0], args[1]); }
  public renameSync(...args: any[]): void { fs.renameSync(args[0], args[1]); }
  public readdirSync(...args: any[]): any { return fs.readdirSync(args[0], args[1]); }
  public openSync(...args: any[]): number { return fs.openSync(args[0], args[1], args[2]); }
  public closeSync(...args: any[]): void { fs.closeSync(args[0]); }
  public statSync(...args: any[]): fs.Stats { return fs.statSync(args[0], args[1]); }
  public lstatSync(...args: any[]): fs.Stats { return fs.lstatSync(args[0], args[1]); }
  public mkdtempSync(...args: any[]): string { return fs.mkdtempSync(args[0], args[1]); }
  public cpSync(...args: any[]): void { fs.cpSync(args[0], args[1], args[2]); }
  public copyFileSync(...args: any[]): void { fs.copyFileSync(args[0], args[1], args[2]); }
}

class DefaultCloudStorageAdapter extends LocalStorageAdapter implements CloudStorageAdapter {
  public readonly kind = 'cloud' as const;
  public readonly provider = 'future-cloud-adapter';
}

const LOCAL_ADAPTER = new LocalStorageAdapter();
const workspaceAdapters = new Map<string, StorageAdapter>();

export function registerStorageAdapter(workspacePath: string, adapter: StorageAdapter): void {
  workspaceAdapters.set(path.resolve(workspacePath), adapter);
}

export function clearStorageAdapter(workspacePath: string): void {
  workspaceAdapters.delete(path.resolve(workspacePath));
}

export function getStorageAdapter(workspacePath: string): StorageAdapter {
  const key = path.resolve(workspacePath);
  const existing = workspaceAdapters.get(key);
  if (existing) return existing;
  const created = createDefaultAdapter(key);
  workspaceAdapters.set(key, created);
  return created;
}

export function getStorageAdapterForPath(targetPath: string | number): StorageAdapter {
  if (typeof targetPath !== 'string') return LOCAL_ADAPTER;
  const resolved = path.resolve(targetPath);
  const explicit = resolveExplicitWorkspaceAdapter(resolved);
  if (explicit) return explicit;

  const inferredWorkspace = inferWorkspaceRoot(resolved);
  if (inferredWorkspace) {
    return getStorageAdapter(inferredWorkspace);
  }
  return LOCAL_ADAPTER;
}

export function detectStorageMode(workspacePath?: string): StorageMode {
  const envMode = normalizeStorageMode(process.env.WORKGRAPH_STORAGE_MODE)
    ?? normalizeStorageMode(process.env.WORKGRAPH_MODE);
  if (envMode) return envMode;
  if (!workspacePath) return 'local';
  const configMode = readStorageModeFromConfig(path.resolve(workspacePath));
  return configMode ?? 'local';
}

function createDefaultAdapter(workspacePath: string): StorageAdapter {
  const mode = detectStorageMode(workspacePath);
  if (mode === 'cloud') {
    return new DefaultCloudStorageAdapter();
  }
  return LOCAL_ADAPTER;
}

function resolveExplicitWorkspaceAdapter(targetPath: string): StorageAdapter | undefined {
  let bestMatch: { prefix: string; adapter: StorageAdapter } | undefined;
  for (const [workspaceRoot, adapter] of workspaceAdapters.entries()) {
    if (!isPathWithinWorkspace(targetPath, workspaceRoot)) continue;
    if (!bestMatch || workspaceRoot.length > bestMatch.prefix.length) {
      bestMatch = { prefix: workspaceRoot, adapter };
    }
  }
  return bestMatch?.adapter;
}

function inferWorkspaceRoot(targetPath: string): string | null {
  let current = targetPath;
  try {
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      current = path.dirname(targetPath);
    }
  } catch {
    current = path.dirname(targetPath);
  }

  while (true) {
    const configPath = path.join(current, '.workgraph.json');
    const metadataDir = path.join(current, '.workgraph');
    if (fs.existsSync(configPath) || fs.existsSync(metadataDir)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function readStorageModeFromConfig(workspacePath: string): StorageMode | undefined {
  const configPath = path.join(workspacePath, '.workgraph.json');
  if (!fs.existsSync(configPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const mode = normalizeStorageMode(parsed.storageMode);
    if (mode) return mode;
    if (parsed.cloud && typeof parsed.cloud === 'object') {
      return 'cloud';
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function normalizeStorageMode(value: unknown): StorageMode | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'local' || normalized === 'cloud') return normalized;
  return undefined;
}

function isPathWithinWorkspace(targetPath: string, workspaceRoot: string): boolean {
  const relative = path.relative(workspaceRoot, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
