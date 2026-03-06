import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import * as query from './query.js';
import * as store from './store.js';
import type { PrimitiveInstance } from './types.js';

const FEDERATION_CONFIG_FILE = '.workgraph/federation.yaml';
const FEDERATION_LINK_INDEX_FILE = '.workgraph/federation-links.yaml';
const FEDERATION_CACHE_DIR = '.workgraph/federation-cache';
const FEDERATION_CACHE_VERSION = 1;
const FEDERATION_LINKS_VERSION = 1;
const FEDERATION_CONFIG_VERSION = 1;
const FEDERATED_ID_PATTERN = /^([a-z0-9][a-z0-9_-]*):(.+)$/i;

export interface FederationRemoteWorkspace {
  name: string;
  target: string;
  readOnly: boolean;
  addedAt: string;
  updatedAt: string;
}

export interface FederationConfig {
  version: number;
  remotes: FederationRemoteWorkspace[];
}

export interface FederationThreadLinkRecord {
  localThreadPath: string;
  localFederatedId: string;
  remoteFederatedId: string;
  remoteWorkspace: string;
  remoteThreadId: string;
  remoteThreadPath?: string;
  linkedAt: string;
  linkedBy: string;
  backlinks: string[];
}

export interface FederationLinkIndex {
  version: number;
  updatedAt: string;
  links: FederationThreadLinkRecord[];
  backlinks: Record<string, string[]>;
}

export interface FederationSyncSnapshot {
  version: number;
  remote: string;
  target: string;
  syncedAt: string;
  threadCount: number;
  ledgerEntries: number;
  ledgerLastHash: string;
  threads: Array<{
    path: string;
    tid: string;
    title: string;
    status: string;
    updated: string;
  }>;
}

export interface FederationSyncResult {
  remote: FederationRemoteWorkspace;
  cachePath: string;
  snapshot: FederationSyncSnapshot;
  backlinksRefreshed: number;
}

export interface FederatedSearchWorkspaceResult {
  workspace: string;
  target: string;
  readOnly: boolean;
  results: PrimitiveInstance[];
  error?: string;
}

export interface LinkFederatedThreadResult {
  thread: PrimitiveInstance;
  link: FederationThreadLinkRecord;
  backlinksTracked: number;
}

interface ParsedFederatedRef {
  workspace: string;
  threadId: string;
}

interface ResolvedRemoteWorkspace {
  remote: FederationRemoteWorkspace;
  kind: 'path' | 'url';
  resolvedPath?: string;
}

export function federationConfigPath(workspacePath: string): string {
  return path.join(workspacePath, FEDERATION_CONFIG_FILE);
}

export function federationLinkIndexPath(workspacePath: string): string {
  return path.join(workspacePath, FEDERATION_LINK_INDEX_FILE);
}

export function readFederationConfig(workspacePath: string): FederationConfig {
  const configPath = federationConfigPath(workspacePath);
  if (!fs.existsSync(configPath)) {
    return {
      version: FEDERATION_CONFIG_VERSION,
      remotes: [],
    };
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = YAML.parse(raw) as Partial<FederationConfig> | null;
  const remotesRaw = Array.isArray(parsed?.remotes) ? parsed.remotes : [];
  return {
    version: FEDERATION_CONFIG_VERSION,
    remotes: remotesRaw
      .map((entry) => sanitizeRemoteWorkspace(entry))
      .filter((entry): entry is FederationRemoteWorkspace => !!entry)
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function listRemoteWorkspaces(workspacePath: string): FederationRemoteWorkspace[] {
  return readFederationConfig(workspacePath).remotes;
}

export function addRemoteWorkspace(
  workspacePath: string,
  remoteName: string,
  target: string,
  options: { readOnly?: boolean } = {},
): { remote: FederationRemoteWorkspace; created: boolean; updated: boolean; configPath: string } {
  const name = normalizeRemoteName(remoteName);
  const normalizedTarget = normalizeRemoteTarget(target);
  const readOnly = options.readOnly !== false;
  const config = readFederationConfig(workspacePath);
  const now = new Date().toISOString();
  const existingIndex = config.remotes.findIndex((entry) => entry.name === name);
  const nextRemote: FederationRemoteWorkspace = {
    name,
    target: normalizedTarget,
    readOnly,
    addedAt: existingIndex >= 0 ? config.remotes[existingIndex].addedAt : now,
    updatedAt: now,
  };
  let created = false;
  let updated = false;
  if (existingIndex === -1) {
    config.remotes.push(nextRemote);
    created = true;
  } else {
    const existing = config.remotes[existingIndex];
    updated = existing.target !== normalizedTarget || existing.readOnly !== readOnly;
    config.remotes[existingIndex] = nextRemote;
  }
  writeFederationConfig(workspacePath, config);
  return {
    remote: nextRemote,
    created,
    updated,
    configPath: FEDERATION_CONFIG_FILE,
  };
}

export function removeRemoteWorkspace(
  workspacePath: string,
  remoteName: string,
): { removed: boolean; remote?: FederationRemoteWorkspace; configPath: string } {
  const name = normalizeRemoteName(remoteName);
  const config = readFederationConfig(workspacePath);
  const index = config.remotes.findIndex((entry) => entry.name === name);
  if (index === -1) {
    return {
      removed: false,
      configPath: FEDERATION_CONFIG_FILE,
    };
  }
  const [removed] = config.remotes.splice(index, 1);
  writeFederationConfig(workspacePath, config);
  return {
    removed: true,
    remote: removed,
    configPath: FEDERATION_CONFIG_FILE,
  };
}

export function readFederationLinkIndex(workspacePath: string): FederationLinkIndex {
  const indexPath = federationLinkIndexPath(workspacePath);
  if (!fs.existsSync(indexPath)) {
    return {
      version: FEDERATION_LINKS_VERSION,
      updatedAt: new Date(0).toISOString(),
      links: [],
      backlinks: {},
    };
  }
  const raw = fs.readFileSync(indexPath, 'utf-8');
  const parsed = YAML.parse(raw) as Partial<FederationLinkIndex> | null;
  const linksRaw = Array.isArray(parsed?.links) ? parsed.links : [];
  const links = linksRaw
    .map((entry) => sanitizeLinkRecord(entry))
    .filter((entry): entry is FederationThreadLinkRecord => !!entry);
  const backlinksRaw = parsed?.backlinks && typeof parsed.backlinks === 'object'
    ? parsed.backlinks
    : {};
  const backlinks: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(backlinksRaw)) {
    if (!isFederatedRef(key)) continue;
    backlinks[normalizeFederatedRef(key)] = toStringList(value)
      .filter((entry) => isFederatedRef(entry))
      .map((entry) => normalizeFederatedRef(entry));
  }
  return {
    version: FEDERATION_LINKS_VERSION,
    updatedAt: readIsoOrFallback(parsed?.updatedAt, new Date(0).toISOString()),
    links: links.sort((a, b) => a.localThreadPath.localeCompare(b.localThreadPath)),
    backlinks,
  };
}

export function linkFederatedThread(
  workspacePath: string,
  localThreadRef: string,
  remoteFederatedRef: string,
  actor: string,
): LinkFederatedThreadResult {
  const parsedRef = parseFederatedRef(remoteFederatedRef);
  const remote = resolveRemoteWorkspace(workspacePath, parsedRef.workspace);
  const localThread = resolveThreadRef(workspacePath, localThreadRef, 'local thread');
  const localThreadId = threadIdentifier(localThread);
  const localWorkspaceId = workspaceIdentity(workspacePath);
  const localFederatedId = `${localWorkspaceId}:${localThreadId}`;

  let remoteThreadId = parsedRef.threadId;
  let remoteThreadPath: string | undefined;
  if (remote.kind === 'path' && remote.resolvedPath) {
    const remoteThread = resolveThreadRef(remote.resolvedPath, parsedRef.threadId, 'remote thread');
    remoteThreadId = threadIdentifier(remoteThread);
    remoteThreadPath = remoteThread.path;
  }
  const remoteFederatedId = `${remote.remote.name}:${remoteThreadId}`;
  const updatedThread = writeFederatedRefToThread(
    workspacePath,
    localThread,
    remoteFederatedId,
    actor,
  );

  const backlinks = remote.kind === 'path' && remote.resolvedPath
    ? collectBacklinksForLocalThread(remote.resolvedPath, remote.remote.name, localFederatedId)
    : [];

  const index = readFederationLinkIndex(workspacePath);
  const now = new Date().toISOString();
  const nextRecord: FederationThreadLinkRecord = {
    localThreadPath: localThread.path,
    localFederatedId,
    remoteFederatedId,
    remoteWorkspace: remote.remote.name,
    remoteThreadId,
    ...(remoteThreadPath ? { remoteThreadPath } : {}),
    linkedAt: now,
    linkedBy: actor,
    backlinks,
  };
  upsertLinkRecord(index, nextRecord);
  index.updatedAt = now;
  writeFederationLinkIndex(workspacePath, index);

  return {
    thread: updatedThread,
    link: nextRecord,
    backlinksTracked: backlinks.length,
  };
}

export function syncRemoteWorkspace(
  workspacePath: string,
  remoteName: string,
): FederationSyncResult {
  const remote = resolveRemoteWorkspace(workspacePath, remoteName);
  if (remote.kind !== 'path' || !remote.resolvedPath) {
    throw new Error(`Remote workspace "${remote.remote.name}" uses URL target and cannot be synced via local pull.`);
  }
  const remoteThreads = store.list(remote.resolvedPath, 'thread');
  const ledgerPath = path.join(remote.resolvedPath, '.workgraph', 'ledger.jsonl');
  const chainPath = path.join(remote.resolvedPath, '.workgraph', 'ledger-chain.json');
  const ledgerEntries = readLedgerLineCount(ledgerPath);
  const ledgerLastHash = readChainHash(chainPath);
  const snapshot: FederationSyncSnapshot = {
    version: FEDERATION_CACHE_VERSION,
    remote: remote.remote.name,
    target: remote.remote.target,
    syncedAt: new Date().toISOString(),
    threadCount: remoteThreads.length,
    ledgerEntries,
    ledgerLastHash,
    threads: remoteThreads
      .map((thread) => ({
        path: thread.path,
        tid: threadIdentifier(thread),
        title: String(thread.fields.title ?? thread.path),
        status: String(thread.fields.status ?? 'unknown'),
        updated: String(thread.fields.updated ?? ''),
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };

  const cacheFileName = `${remote.remote.name}.json`;
  const cacheAbsDir = path.join(workspacePath, FEDERATION_CACHE_DIR);
  ensureDirectory(cacheAbsDir);
  const cacheAbsPath = path.join(cacheAbsDir, cacheFileName);
  fs.writeFileSync(cacheAbsPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');

  const backlinksRefreshed = refreshBacklinksForRemote(workspacePath, remote.remote.name, remote.resolvedPath);
  return {
    remote: remote.remote,
    cachePath: path.join(FEDERATION_CACHE_DIR, cacheFileName).replace(/\\/g, '/'),
    snapshot,
    backlinksRefreshed,
  };
}

export function searchFederatedWorkspaces(
  workspacePath: string,
  text: string,
  options: {
    type?: string;
    limit?: number;
  } = {},
): FederatedSearchWorkspaceResult[] {
  const remotes = listRemoteWorkspaces(workspacePath);
  return remotes.map((remote) => {
    const resolved = resolveRemoteWorkspace(workspacePath, remote.name);
    if (resolved.kind !== 'path' || !resolved.resolvedPath) {
      return {
        workspace: remote.name,
        target: remote.target,
        readOnly: remote.readOnly,
        results: [],
        error: 'URL targets are not searchable via local filesystem federation.',
      };
    }
    if (!fs.existsSync(resolved.resolvedPath)) {
      return {
        workspace: remote.name,
        target: remote.target,
        readOnly: remote.readOnly,
        results: [],
        error: `Remote path does not exist: ${resolved.resolvedPath}`,
      };
    }
    try {
      const results = query.keywordSearch(resolved.resolvedPath, text, {
        type: options.type,
        limit: options.limit,
      });
      return {
        workspace: remote.name,
        target: remote.target,
        readOnly: remote.readOnly,
        results,
      };
    } catch (error) {
      return {
        workspace: remote.name,
        target: remote.target,
        readOnly: remote.readOnly,
        results: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

function writeFederationConfig(workspacePath: string, config: FederationConfig): void {
  const configPath = federationConfigPath(workspacePath);
  ensureDirectory(path.dirname(configPath));
  const sorted = {
    version: FEDERATION_CONFIG_VERSION,
    remotes: [...config.remotes].sort((a, b) => a.name.localeCompare(b.name)),
  };
  fs.writeFileSync(configPath, YAML.stringify(sorted), 'utf-8');
}

function writeFederationLinkIndex(workspacePath: string, index: FederationLinkIndex): void {
  const indexPath = federationLinkIndexPath(workspacePath);
  ensureDirectory(path.dirname(indexPath));
  const sortedLinks = [...index.links]
    .sort((a, b) => a.localThreadPath.localeCompare(b.localThreadPath));
  const normalizedBacklinks: Record<string, string[]> = {};
  for (const key of Object.keys(index.backlinks).sort()) {
    normalizedBacklinks[key] = [...new Set(index.backlinks[key])]
      .sort((a, b) => a.localeCompare(b));
  }
  const serialized: FederationLinkIndex = {
    version: FEDERATION_LINKS_VERSION,
    updatedAt: index.updatedAt,
    links: sortedLinks,
    backlinks: normalizedBacklinks,
  };
  fs.writeFileSync(indexPath, YAML.stringify(serialized), 'utf-8');
}

function resolveRemoteWorkspace(workspacePath: string, remoteName: string): ResolvedRemoteWorkspace {
  const name = normalizeRemoteName(remoteName);
  const remote = listRemoteWorkspaces(workspacePath).find((entry) => entry.name === name);
  if (!remote) {
    throw new Error(`Unknown remote workspace "${remoteName}". Use \`workgraph federation list\` to inspect remotes.`);
  }
  if (isUrlTarget(remote.target)) {
    return { remote, kind: 'url' };
  }
  return {
    remote,
    kind: 'path',
    resolvedPath: resolvePathTarget(workspacePath, remote.target),
  };
}

function resolvePathTarget(workspacePath: string, target: string): string {
  if (target.startsWith('file://')) {
    return path.resolve(fileUrlToPath(target));
  }
  return path.resolve(workspacePath, target);
}

function parseFederatedRef(value: string): ParsedFederatedRef {
  const normalized = normalizeFederatedRef(value);
  const match = normalized.match(FEDERATED_ID_PATTERN);
  if (!match) {
    throw new Error(`Invalid federated thread reference "${value}". Expected "<workspace>:<thread-id>".`);
  }
  return {
    workspace: normalizeRemoteName(match[1]),
    threadId: normalizeThreadIdToken(match[2]),
  };
}

function normalizeFederatedRef(value: string): string {
  const stripped = stripWikiLink(value);
  const match = stripped.match(FEDERATED_ID_PATTERN);
  if (!match) return stripped;
  return `${normalizeRemoteName(match[1])}:${normalizeThreadIdToken(match[2])}`;
}

function isFederatedRef(value: string): boolean {
  return FEDERATED_ID_PATTERN.test(stripWikiLink(value));
}

function resolveThreadRef(workspacePath: string, threadRef: string, label: string): PrimitiveInstance {
  const normalized = normalizeThreadRefToken(threadRef);
  const threadList = store.list(workspacePath, 'thread');
  const byTid = threadList.find((thread) => threadIdentifier(thread) === normalizeThreadIdToken(normalized));
  if (byTid) return byTid;

  const pathCandidates = buildThreadPathCandidates(normalized);
  for (const candidate of pathCandidates) {
    const thread = store.read(workspacePath, candidate);
    if (thread && thread.type === 'thread') return thread;
  }
  throw new Error(`Unable to resolve ${label} "${threadRef}".`);
}

function buildThreadPathCandidates(rawRef: string): string[] {
  const candidates: string[] = [];
  const cleaned = normalizeThreadRefToken(rawRef);
  if (!cleaned) return candidates;
  if (cleaned.endsWith('.md')) {
    candidates.push(cleaned);
  } else if (cleaned.includes('/')) {
    candidates.push(`${cleaned}.md`);
  } else {
    candidates.push(`threads/${cleaned}.md`);
  }
  const deduped = new Set(
    candidates.map((entry) => entry.replace(/\\/g, '/').replace(/^\.\//, ''))
  );
  return [...deduped];
}

function writeFederatedRefToThread(
  workspacePath: string,
  thread: PrimitiveInstance,
  remoteFederatedId: string,
  actor: string,
): PrimitiveInstance {
  const existingRefs = toStringList(thread.fields.federated_refs)
    .filter((value) => isFederatedRef(value))
    .map((value) => normalizeFederatedRef(value));
  const nextRefs = [...new Set([...existingRefs, normalizeFederatedRef(remoteFederatedId)])]
    .sort((a, b) => a.localeCompare(b));
  return store.update(
    workspacePath,
    thread.path,
    { federated_refs: nextRefs },
    undefined,
    actor,
    {
      action: 'federation.thread-link',
      requiredCapabilities: ['thread:update', 'thread:manage'],
    },
  );
}

function collectBacklinksForLocalThread(
  remoteWorkspacePath: string,
  remoteWorkspaceName: string,
  localFederatedId: string,
): string[] {
  const target = normalizeFederatedRef(localFederatedId);
  const backlinks = new Set<string>();
  const remoteThreads = store.list(remoteWorkspacePath, 'thread');
  for (const remoteThread of remoteThreads) {
    const refs = extractFederatedRefsFromThread(remoteThread);
    if (refs.includes(target)) {
      backlinks.add(`${remoteWorkspaceName}:${threadIdentifier(remoteThread)}`);
    }
  }
  return [...backlinks].sort((a, b) => a.localeCompare(b));
}

function refreshBacklinksForRemote(
  workspacePath: string,
  remoteWorkspaceName: string,
  remoteWorkspacePath: string,
): number {
  const index = readFederationLinkIndex(workspacePath);
  const targetRemoteName = normalizeRemoteName(remoteWorkspaceName);
  let refreshed = 0;
  for (let idx = 0; idx < index.links.length; idx++) {
    const link = index.links[idx];
    if (link.remoteWorkspace !== targetRemoteName) continue;
    const backlinks = collectBacklinksForLocalThread(
      remoteWorkspacePath,
      targetRemoteName,
      link.localFederatedId,
    );
    index.links[idx] = {
      ...link,
      backlinks,
    };
    refreshed += 1;
  }
  index.backlinks = {};
  for (const link of index.links) {
    if (!index.backlinks[link.remoteFederatedId]) {
      index.backlinks[link.remoteFederatedId] = [];
    }
    index.backlinks[link.remoteFederatedId].push(link.localFederatedId);
  }
  for (const key of Object.keys(index.backlinks)) {
    index.backlinks[key] = [...new Set(index.backlinks[key])].sort((a, b) => a.localeCompare(b));
  }
  if (refreshed > 0) {
    index.updatedAt = new Date().toISOString();
    writeFederationLinkIndex(workspacePath, index);
  }
  return refreshed;
}

function upsertLinkRecord(index: FederationLinkIndex, link: FederationThreadLinkRecord): void {
  const existingIndex = index.links.findIndex((entry) =>
    entry.localThreadPath === link.localThreadPath &&
    entry.remoteFederatedId === link.remoteFederatedId
  );
  if (existingIndex >= 0) {
    index.links[existingIndex] = {
      ...index.links[existingIndex],
      ...link,
      linkedAt: index.links[existingIndex].linkedAt,
    };
  } else {
    index.links.push(link);
  }
  if (!index.backlinks[link.remoteFederatedId]) {
    index.backlinks[link.remoteFederatedId] = [];
  }
  index.backlinks[link.remoteFederatedId].push(link.localFederatedId);
  index.backlinks[link.remoteFederatedId] = [...new Set(index.backlinks[link.remoteFederatedId])];
}

function extractFederatedRefsFromThread(thread: PrimitiveInstance): string[] {
  const refs = new Set<string>();
  for (const value of toStringList(thread.fields.deps)) {
    if (isFederatedRef(value)) refs.add(normalizeFederatedRef(value));
  }
  for (const value of toStringList(thread.fields.federated_refs)) {
    if (isFederatedRef(value)) refs.add(normalizeFederatedRef(value));
  }
  for (const value of toStringList(thread.fields.context_refs)) {
    if (isFederatedRef(value)) refs.add(normalizeFederatedRef(value));
  }
  const bodyMatches = thread.body.matchAll(/\b[a-z0-9][a-z0-9_-]*:[a-z0-9._/-]+\b/gi);
  for (const match of bodyMatches) {
    const value = String(match[0] ?? '').trim();
    if (!value || !isFederatedRef(value)) continue;
    refs.add(normalizeFederatedRef(value));
  }
  return [...refs];
}

function sanitizeRemoteWorkspace(value: unknown): FederationRemoteWorkspace | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Partial<FederationRemoteWorkspace>;
  const name = readString(item.name);
  const target = readString(item.target);
  if (!name || !target) return null;
  const now = new Date().toISOString();
  return {
    name: normalizeRemoteName(name),
    target: normalizeRemoteTarget(target),
    readOnly: item.readOnly !== false,
    addedAt: readIsoOrFallback(item.addedAt, now),
    updatedAt: readIsoOrFallback(item.updatedAt, now),
  };
}

function sanitizeLinkRecord(value: unknown): FederationThreadLinkRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Partial<FederationThreadLinkRecord>;
  const localThreadPath = readString(item.localThreadPath);
  const localFederatedId = readString(item.localFederatedId);
  const remoteFederatedId = readString(item.remoteFederatedId);
  const remoteWorkspace = readString(item.remoteWorkspace);
  const remoteThreadId = readString(item.remoteThreadId);
  const linkedAt = readString(item.linkedAt);
  const linkedBy = readString(item.linkedBy);
  if (
    !localThreadPath ||
    !localFederatedId ||
    !remoteFederatedId ||
    !remoteWorkspace ||
    !remoteThreadId ||
    !linkedAt ||
    !linkedBy
  ) {
    return null;
  }
  return {
    localThreadPath,
    localFederatedId: normalizeFederatedRef(localFederatedId),
    remoteFederatedId: normalizeFederatedRef(remoteFederatedId),
    remoteWorkspace: normalizeRemoteName(remoteWorkspace),
    remoteThreadId: normalizeThreadIdToken(remoteThreadId),
    ...(readString(item.remoteThreadPath) ? { remoteThreadPath: normalizeThreadRefToken(item.remoteThreadPath!) } : {}),
    linkedAt: readIsoOrFallback(linkedAt, linkedAt),
    linkedBy,
    backlinks: toStringList(item.backlinks)
      .filter((entry) => isFederatedRef(entry))
      .map((entry) => normalizeFederatedRef(entry)),
  };
}

function normalizeRemoteName(value: string): string {
  const normalized = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) {
    throw new Error('Remote workspace name must be a non-empty identifier.');
  }
  return normalized;
}

function normalizeRemoteTarget(value: string): string {
  const normalized = String(value).trim();
  if (!normalized) {
    throw new Error('Remote workspace target must be a non-empty path or URL.');
  }
  return normalized;
}

function workspaceIdentity(workspacePath: string): string {
  const configPath = path.join(workspacePath, '.workgraph.json');
  if (!fs.existsSync(configPath)) {
    return normalizeRemoteName(path.basename(path.resolve(workspacePath)));
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { name?: unknown };
    if (typeof raw.name === 'string' && raw.name.trim().length > 0) {
      return normalizeRemoteName(raw.name);
    }
  } catch {
    // Ignore and fallback to directory basename.
  }
  return normalizeRemoteName(path.basename(path.resolve(workspacePath)));
}

function threadIdentifier(thread: PrimitiveInstance): string {
  const fromTid = readString(thread.fields.tid);
  if (fromTid) return normalizeThreadIdToken(fromTid);
  const fallback = path.basename(thread.path, '.md');
  return normalizeThreadIdToken(fallback);
}

function normalizeThreadIdToken(value: string): string {
  const cleaned = normalizeThreadRefToken(value)
    .replace(/^threads\//, '')
    .replace(/\.md$/, '')
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  if (!cleaned) {
    throw new Error(`Invalid thread identifier "${value}".`);
  }
  return cleaned;
}

function normalizeThreadRefToken(value: string): string {
  const stripped = stripWikiLink(value);
  return stripped
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .trim();
}

function stripWikiLink(value: string): string {
  const raw = String(value ?? '').trim();
  const withoutWrapper = raw.startsWith('[[') && raw.endsWith(']]')
    ? raw.slice(2, -2)
    : raw;
  return withoutWrapper.split('|')[0].split('#')[0].trim();
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry).trim())
    .filter(Boolean);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readIsoOrFallback(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return fallback;
  return new Date(parsed).toISOString();
}

function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function isUrlTarget(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'file:';
  } catch {
    return false;
  }
}

function fileUrlToPath(fileUrl: string): string {
  const url = new URL(fileUrl);
  if (url.protocol !== 'file:') {
    throw new Error(`Unsupported URL protocol "${url.protocol}".`);
  }
  return decodeURIComponent(url.pathname);
}

function readLedgerLineCount(ledgerFilePath: string): number {
  if (!fs.existsSync(ledgerFilePath)) return 0;
  const raw = fs.readFileSync(ledgerFilePath, 'utf-8');
  if (!raw.trim()) return 0;
  return raw.split('\n').filter((line) => line.trim().length > 0).length;
}

function readChainHash(chainFilePath: string): string {
  if (!fs.existsSync(chainFilePath)) return '';
  try {
    const parsed = JSON.parse(fs.readFileSync(chainFilePath, 'utf-8')) as { lastHash?: unknown };
    return typeof parsed.lastHash === 'string' ? parsed.lastHash : '';
  } catch {
    return '';
  }
}
