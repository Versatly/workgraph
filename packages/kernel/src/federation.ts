import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  DEFAULT_FEDERATION_CAPABILITIES,
  FEDERATION_PROTOCOL_VERSION,
  asRecord,
  buildFederatedPrimitiveRef,
  buildLegacyFederationLink,
  deriveWorkspaceId,
  normalizeCapabilitySet,
  normalizeFederatedPrimitiveRef,
  normalizeFederationWorkspaceIdentity,
  normalizeOptionalString,
  normalizePrimitivePath,
  normalizeProtocolVersion,
  normalizeTransportKind,
  normalizeTrustLevel,
  parseFederatedRef,
  primitiveSlugFromPath,
  primitiveTypeFromPath,
  type FederatedPrimitiveRef,
  type FederationTransportKind,
  type FederationTrustLevel,
  type FederationWorkspaceIdentity,
} from './federation-helpers.js';
import * as query from './query.js';
import * as store from './store.js';
import type { PrimitiveInstance } from './types.js';

const FEDERATION_CONFIG_FILE = '.workgraph/federation.yaml';

export interface RemoteWorkspaceRef {
  id: string;
  workspaceId: string;
  name: string;
  path: string;
  enabled: boolean;
  tags: string[];
  protocolVersion: string;
  capabilities: string[];
  trustLevel: FederationTrustLevel;
  transport: FederationTransportKind;
  addedAt: string;
  lastHandshakeAt?: string;
  lastSyncedAt?: string;
  lastSyncStatus?: 'synced' | 'error';
  lastSyncError?: string;
}

export interface FederationConfig {
  version: number;
  updatedAt: string;
  workspace: FederationWorkspaceIdentity;
  remotes: RemoteWorkspaceRef[];
}

export interface AddRemoteWorkspaceInput {
  id: string;
  path: string;
  name?: string;
  enabled?: boolean;
  tags?: string[];
}

export interface AddRemoteWorkspaceResult {
  configPath: string;
  created: boolean;
  remote: RemoteWorkspaceRef;
  config: FederationConfig;
}

export interface RemoveRemoteWorkspaceResult {
  configPath: string;
  changed: boolean;
  removed?: RemoteWorkspaceRef;
  config: FederationConfig;
}

export interface LinkFederatedThreadResult {
  thread: PrimitiveInstance;
  created: boolean;
  link: string;
  ref: FederatedPrimitiveRef;
}

export interface FederatedSearchOptions {
  type?: string;
  limit?: number;
  remoteIds?: string[];
  includeLocal?: boolean;
}

export interface FederatedSearchResultItem {
  workspaceId: string;
  workspacePath: string;
  protocolVersion: string;
  trustLevel: FederationTrustLevel;
  stale: boolean;
  instance: PrimitiveInstance;
}

export interface FederatedSearchError {
  workspaceId: string;
  message: string;
}

export interface FederatedSearchResult {
  query: string;
  results: FederatedSearchResultItem[];
  errors: FederatedSearchError[];
}

export interface SyncFederationOptions {
  remoteIds?: string[];
  includeDisabled?: boolean;
}

export interface FederationSyncRemoteResult {
  id: string;
  workspaceId: string;
  workspacePath: string;
  enabled: boolean;
  status: 'synced' | 'skipped' | 'error';
  threadCount: number;
  openThreadCount: number;
  protocolVersion?: string;
  capabilities?: string[];
  trustLevel?: FederationTrustLevel;
  syncedAt?: string;
  error?: string;
}

export interface FederationSyncResult {
  actor: string;
  syncedAt: string;
  configPath: string;
  remotes: FederationSyncRemoteResult[];
}

export interface FederationHandshakeResult {
  remote: RemoteWorkspaceRef;
  identity: FederationWorkspaceIdentity;
  compatible: boolean;
  supportsRead: boolean;
  supportsSearch: boolean;
  error?: string;
}

export interface FederationResolveResult {
  ref: FederatedPrimitiveRef;
  source: 'local' | 'remote';
  authority: 'local' | 'remote';
  workspaceId: string;
  workspacePath: string;
  protocolVersion: string;
  trustLevel: FederationTrustLevel;
  stale: boolean;
  capabilityCheck: {
    supportsRead: boolean;
    supportsSearch: boolean;
  };
  instance: PrimitiveInstance;
  warning?: string;
}

export interface FederationStatusResult {
  workspace: FederationWorkspaceIdentity;
  configPath: string;
  remotes: FederationHandshakeResult[];
}

export function federationConfigPath(workspacePath: string): string {
  return path.join(workspacePath, FEDERATION_CONFIG_FILE);
}

export function loadFederationConfig(workspacePath: string): FederationConfig {
  const configPath = federationConfigPath(workspacePath);
  if (!fs.existsSync(configPath)) {
    return defaultFederationConfig(workspacePath);
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = YAML.parse(raw) as unknown;
    return normalizeFederationConfig(workspacePath, parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse federation config at ${configPath}: ${message}`);
  }
}

export function saveFederationConfig(workspacePath: string, config: FederationConfig): FederationConfig {
  const normalized = normalizeFederationConfig(workspacePath, config);
  const configPath = federationConfigPath(workspacePath);
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(configPath, YAML.stringify(normalized), 'utf-8');
  return normalized;
}

export function ensureFederationConfig(workspacePath: string): FederationConfig {
  const configPath = federationConfigPath(workspacePath);
  if (fs.existsSync(configPath)) {
    return loadFederationConfig(workspacePath);
  }
  const created = defaultFederationConfig(workspacePath);
  return saveFederationConfig(workspacePath, created);
}

export function listRemoteWorkspaces(
  workspacePath: string,
  options: { includeDisabled?: boolean } = {},
): RemoteWorkspaceRef[] {
  const includeDisabled = options.includeDisabled !== false;
  const config = loadFederationConfig(workspacePath);
  return includeDisabled
    ? config.remotes
    : config.remotes.filter((remote) => remote.enabled);
}

export function federationStatus(workspacePath: string): FederationStatusResult {
  const config = ensureFederationConfig(workspacePath);
  return {
    workspace: config.workspace,
    configPath: federationConfigPath(workspacePath),
    remotes: config.remotes.map((remote) => handshakeRemoteWorkspace(workspacePath, remote)),
  };
}

export function addRemoteWorkspace(
  workspacePath: string,
  input: AddRemoteWorkspaceInput,
): AddRemoteWorkspaceResult {
  const workspaceId = normalizeIdentifier(input.id, 'id');
  const remotePath = normalizeRemoteWorkspacePath(input.path);
  const workspaceRoot = path.resolve(workspacePath).replace(/\\/g, '/');
  if (remotePath === workspaceRoot) {
    throw new Error('Remote workspace path cannot point to the current workspace.');
  }

  const config = ensureFederationConfig(workspacePath);
  const remoteIdentity = readRemoteWorkspaceIdentity(remotePath);
  const now = new Date().toISOString();
  const index = config.remotes.findIndex((remote) => remote.id === workspaceId);
  const previous = index >= 0 ? config.remotes[index] : undefined;
  const nextTags = input.tags === undefined
    ? previous?.tags ?? []
    : normalizeTags(input.tags);
  const remote: RemoteWorkspaceRef = {
    id: workspaceId,
    workspaceId: previous?.workspaceId ?? remoteIdentity.workspaceId,
    name: normalizeOptionalString(input.name) ?? previous?.name ?? workspaceId,
    path: remotePath,
    enabled: input.enabled ?? previous?.enabled ?? true,
    tags: nextTags,
    protocolVersion: previous?.protocolVersion ?? remoteIdentity.protocolVersion,
    capabilities: previous?.capabilities ?? remoteIdentity.capabilities,
    trustLevel: previous?.trustLevel ?? 'read-only',
    transport: previous?.transport ?? 'local-path',
    addedAt: previous?.addedAt ?? now,
    lastHandshakeAt: previous?.lastHandshakeAt ?? now,
    lastSyncedAt: previous?.lastSyncedAt,
    lastSyncStatus: previous?.lastSyncStatus,
    lastSyncError: previous?.lastSyncError,
  };

  const remotes = [...config.remotes];
  if (index >= 0) {
    remotes[index] = remote;
  } else {
    remotes.push(remote);
  }

  const updated: FederationConfig = {
    ...config,
    updatedAt: now,
    remotes: remotes.sort((a, b) => a.id.localeCompare(b.id)),
  };
  const saved = saveFederationConfig(workspacePath, updated);
  return {
    configPath: federationConfigPath(workspacePath),
    created: index === -1,
    remote,
    config: saved,
  };
}

export function removeRemoteWorkspace(
  workspacePath: string,
  workspaceId: string,
): RemoveRemoteWorkspaceResult {
  const remoteId = normalizeIdentifier(workspaceId, 'id');
  const config = ensureFederationConfig(workspacePath);
  const removed = config.remotes.find((remote) => remote.id === remoteId);
  if (!removed) {
    return {
      configPath: federationConfigPath(workspacePath),
      changed: false,
      config,
    };
  }

  const updated: FederationConfig = {
    ...config,
    updatedAt: new Date().toISOString(),
    remotes: config.remotes.filter((remote) => remote.id !== remoteId),
  };
  const saved = saveFederationConfig(workspacePath, updated);
  return {
    configPath: federationConfigPath(workspacePath),
    changed: true,
    removed,
    config: saved,
  };
}

export function linkThreadToRemoteWorkspace(
  workspacePath: string,
  threadRef: string,
  remoteWorkspaceId: string,
  remoteThreadRef: string,
  actor: string,
): LinkFederatedThreadResult {
  const remoteId = normalizeIdentifier(remoteWorkspaceId, 'remoteWorkspaceId');
  const localThreadPath = normalizeThreadPathRef(threadRef, 'threadRef');
  const targetThreadPath = normalizeThreadPathRef(remoteThreadRef, 'remoteThreadRef');
  const config = ensureFederationConfig(workspacePath);
  const remote = config.remotes.find((entry) => entry.id === remoteId);
  if (!remote) {
    throw new Error(`Unknown federated workspace "${remoteId}". Add it first with \`workgraph federation add\`.`);
  }
  if (!remote.enabled) {
    throw new Error(`Federated workspace "${remoteId}" is disabled. Re-enable it before linking.`);
  }

  const localThread = store.read(workspacePath, localThreadPath);
  if (!localThread || localThread.type !== 'thread') {
    throw new Error(`Thread not found: ${localThreadPath}`);
  }

  if (!fs.existsSync(remote.path)) {
    throw new Error(`Federated workspace path not found for "${remoteId}": ${remote.path}`);
  }
  const handshake = handshakeRemoteWorkspace(workspacePath, remote);
  if (!handshake.compatible) {
    throw new Error(handshake.error ?? `Remote workspace "${remoteId}" is not protocol-compatible.`);
  }
  if (!handshake.supportsRead) {
    throw new Error(`Remote workspace "${remoteId}" does not advertise read capabilities for thread resolution.`);
  }
  const remoteThread = store.read(remote.path, targetThreadPath);
  if (!remoteThread || remoteThread.type !== 'thread') {
    throw new Error(`Remote thread not found in "${remoteId}": ${targetThreadPath}`);
  }

  const link = buildLegacyFederationLink(remote.id, targetThreadPath);
  const ref = buildFederatedPrimitiveRef({
    workspaceId: handshake.identity.workspaceId,
    primitiveType: remoteThread.type,
    primitivePath: targetThreadPath,
    protocolVersion: handshake.identity.protocolVersion,
    transport: remote.transport,
    remoteAlias: remote.id,
  });
  const existingLinks = readStringArray(localThread.fields.federation_links);
  const existingRefs = readFederatedRefs(localThread.fields.federation_refs);
  const created = !existingLinks.includes(link);
  const links = created ? [...existingLinks, link] : existingLinks;
  const refs = created
    ? [...existingRefs, ref]
    : existingRefs.some((entry) => entry.workspaceId === ref.workspaceId && entry.primitivePath === ref.primitivePath)
      ? existingRefs
      : [...existingRefs, ref];
  const body = created
    ? appendThreadFederationLink(localThread.body, link, remote.name)
    : undefined;

  const updated = store.update(
    workspacePath,
    localThread.path,
    {
      federation_links: links,
      federation_refs: refs,
    },
    body,
    actor,
    {
      skipAuthorization: true,
      action: 'federation.thread-link',
      requiredCapabilities: ['thread:update', 'thread:manage'],
    },
  );
  return {
    thread: updated,
    created,
    link,
    ref,
  };
}

export function searchFederated(
  workspacePath: string,
  text: string,
  options: FederatedSearchOptions = {},
): FederatedSearchResult {
  const queryText = String(text ?? '').trim();
  if (!queryText) {
    throw new Error('Federated search query cannot be empty.');
  }
  const selectedRemoteIds = new Set((options.remoteIds ?? []).map((value) => normalizeIdentifier(value, 'remoteId')));
  const includeAllRemotes = selectedRemoteIds.size === 0;
  const includeLocal = options.includeLocal !== false;
  const remotes = listRemoteWorkspaces(workspacePath, { includeDisabled: false })
    .filter((remote) => includeAllRemotes || selectedRemoteIds.has(remote.id));

  const results: FederatedSearchResultItem[] = [];
  const errors: FederatedSearchError[] = [];

  if (includeLocal) {
    const localResults = query.keywordSearch(workspacePath, queryText, {
      type: options.type,
    });
    for (const instance of localResults) {
      results.push({
        workspaceId: 'local',
        workspacePath: path.resolve(workspacePath).replace(/\\/g, '/'),
        protocolVersion: loadFederationConfig(workspacePath).workspace.protocolVersion,
        trustLevel: 'local',
        stale: false,
        instance,
      });
    }
  }

  for (const remote of remotes) {
    try {
      const handshake = handshakeRemoteWorkspace(workspacePath, remote);
      if (!handshake.compatible) {
        throw new Error(handshake.error ?? `Remote workspace ${remote.id} is not protocol-compatible.`);
      }
      if (!handshake.supportsSearch) {
        throw new Error(`Remote workspace ${remote.id} does not support federated search.`);
      }
      if (!fs.existsSync(remote.path)) {
        throw new Error(`Remote workspace path not found: ${remote.path}`);
      }
      const remoteResults = query.keywordSearch(remote.path, queryText, {
        type: options.type,
      });
      for (const instance of remoteResults) {
        results.push({
          workspaceId: remote.id,
          workspacePath: remote.path,
          protocolVersion: handshake.identity.protocolVersion,
          trustLevel: handshake.identity.trustLevel,
          stale: isRemoteResultStale(remote, instance),
          instance,
        });
      }
    } catch (error) {
      errors.push({
        workspaceId: remote.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const limitedResults = typeof options.limit === 'number' && options.limit >= 0
    ? results.slice(0, options.limit)
    : results;
  return {
    query: queryText,
    results: limitedResults,
    errors,
  };
}

export function resolveFederatedRef(
  workspacePath: string,
  ref: string | FederatedPrimitiveRef,
): FederationResolveResult {
  const parsedRef = typeof ref === 'string'
    ? parseFederatedRef(ref)
    : normalizeFederatedPrimitiveRef(ref);
  if (!parsedRef) {
    throw new Error('Invalid federated ref. Expected legacy federation:// link or typed federated ref.');
  }
  const config = ensureFederationConfig(workspacePath);
  const remote = config.remotes.find((entry) =>
    entry.id === parsedRef.remoteAlias
    || entry.id === parsedRef.workspaceId
    || entry.workspaceId === parsedRef.workspaceId);
  if (!remote) {
    throw new Error(`Federated workspace not configured for ref workspace id "${parsedRef.workspaceId}".`);
  }
  const localWinner = findLocalAuthorityWinner(workspacePath, parsedRef);
  if (localWinner) {
    return {
      ref: parsedRef,
      source: 'local',
      authority: 'local',
      workspaceId: config.workspace.workspaceId,
      workspacePath: path.resolve(workspacePath).replace(/\\/g, '/'),
      protocolVersion: config.workspace.protocolVersion,
      trustLevel: config.workspace.trustLevel,
      stale: false,
      capabilityCheck: {
        supportsRead: true,
        supportsSearch: true,
      },
      instance: localWinner,
      warning: `Local primitive "${localWinner.path}" overrides remote authority for slug "${parsedRef.primitiveSlug}".`,
    };
  }
  const handshake = handshakeRemoteWorkspace(workspacePath, remote);
  if (!handshake.compatible) {
    throw new Error(handshake.error ?? `Remote workspace "${remote.id}" is not protocol-compatible.`);
  }
  if (!handshake.supportsRead) {
    throw new Error(`Remote workspace "${remote.id}" does not support federated ref resolution.`);
  }
  const remoteInstance = resolveRemotePrimitive(remote.path, parsedRef);
  if (!remoteInstance) {
    throw new Error(`Remote primitive not found for ${parsedRef.primitiveType}:${parsedRef.primitiveSlug} in "${remote.id}".`);
  }
  const stale = isRemoteResultStale(remote, remoteInstance);
  return {
    ref: parsedRef,
    source: 'remote',
    authority: 'remote',
    workspaceId: handshake.identity.workspaceId,
    workspacePath: remote.path,
    protocolVersion: handshake.identity.protocolVersion,
    trustLevel: handshake.identity.trustLevel,
    stale,
    capabilityCheck: {
      supportsRead: handshake.supportsRead,
      supportsSearch: handshake.supportsSearch,
    },
    instance: remoteInstance,
    ...(stale ? { warning: `Remote primitive "${remoteInstance.path}" may be stale relative to last federation sync.` } : {}),
  };
}

export function syncFederation(
  workspacePath: string,
  actor: string,
  options: SyncFederationOptions = {},
): FederationSyncResult {
  const config = ensureFederationConfig(workspacePath);
  const now = new Date().toISOString();
  const selectedRemoteIds = new Set((options.remoteIds ?? []).map((value) => normalizeIdentifier(value, 'remoteId')));
  const syncAll = selectedRemoteIds.size === 0;
  const remotesResult: FederationSyncRemoteResult[] = [];
  const remotes = config.remotes.map((remote) => {
    const selected = syncAll || selectedRemoteIds.has(remote.id);
    if (!selected) {
      remotesResult.push({
        id: remote.id,
        workspaceId: remote.workspaceId,
        workspacePath: remote.path,
        enabled: remote.enabled,
        status: 'skipped',
        threadCount: 0,
        openThreadCount: 0,
        protocolVersion: remote.protocolVersion,
        capabilities: remote.capabilities,
        trustLevel: remote.trustLevel,
      });
      return remote;
    }
    if (!remote.enabled && options.includeDisabled !== true) {
      remotesResult.push({
        id: remote.id,
        workspaceId: remote.workspaceId,
        workspacePath: remote.path,
        enabled: remote.enabled,
        status: 'skipped',
        threadCount: 0,
        openThreadCount: 0,
        protocolVersion: remote.protocolVersion,
        capabilities: remote.capabilities,
        trustLevel: remote.trustLevel,
      });
      return remote;
    }

    try {
      if (!fs.existsSync(remote.path)) {
        throw new Error(`Remote workspace path not found: ${remote.path}`);
      }
      const handshake = handshakeRemoteWorkspace(workspacePath, remote);
      if (!handshake.compatible) {
        throw new Error(handshake.error ?? `Remote workspace ${remote.id} is not protocol-compatible.`);
      }
      const threads = store.list(remote.path, 'thread');
      const openThreadCount = threads.filter((thread) => String(thread.fields.status ?? '') === 'open').length;
      remotesResult.push({
        id: remote.id,
        workspaceId: handshake.identity.workspaceId,
        workspacePath: remote.path,
        enabled: remote.enabled,
        status: 'synced',
        threadCount: threads.length,
        openThreadCount,
        protocolVersion: handshake.identity.protocolVersion,
        capabilities: handshake.identity.capabilities,
        trustLevel: handshake.identity.trustLevel,
        syncedAt: now,
      });
      return {
        ...remote,
        workspaceId: handshake.identity.workspaceId,
        protocolVersion: handshake.identity.protocolVersion,
        capabilities: handshake.identity.capabilities,
        trustLevel: handshake.identity.trustLevel,
        lastHandshakeAt: now,
        lastSyncedAt: now,
        lastSyncStatus: 'synced' as const,
        lastSyncError: undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      remotesResult.push({
        id: remote.id,
        workspaceId: remote.workspaceId,
        workspacePath: remote.path,
        enabled: remote.enabled,
        status: 'error',
        threadCount: 0,
        openThreadCount: 0,
        protocolVersion: remote.protocolVersion,
        capabilities: remote.capabilities,
        trustLevel: remote.trustLevel,
        syncedAt: now,
        error: message,
      });
      return {
        ...remote,
        lastHandshakeAt: now,
        lastSyncedAt: now,
        lastSyncStatus: 'error' as const,
        lastSyncError: message,
      };
    }
  });

  saveFederationConfig(workspacePath, {
    ...config,
    updatedAt: now,
    remotes,
  });
  return {
    actor: String(actor || 'system'),
    syncedAt: now,
    configPath: federationConfigPath(workspacePath),
    remotes: remotesResult,
  };
}

function defaultFederationConfig(workspacePath: string, now: string = new Date().toISOString()): FederationConfig {
  return {
    version: 2,
    updatedAt: now,
    workspace: normalizeFederationWorkspaceIdentity(undefined, workspacePath),
    remotes: [],
  };
}

function normalizeFederationConfig(workspacePath: string, value: unknown): FederationConfig {
  const root = asRecord(value);
  const now = new Date().toISOString();
  const remotes = asArray(root.remotes)
    .map((entry) => normalizeRemoteWorkspaceRef(entry))
    .filter((entry): entry is RemoteWorkspaceRef => entry !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
  const version = typeof root.version === 'number' && Number.isFinite(root.version)
    ? Math.max(1, Math.floor(root.version))
    : 2;
  return {
    version,
    updatedAt: normalizeOptionalString(root.updatedAt) ?? now,
    workspace: normalizeFederationWorkspaceIdentity(root.workspace, workspacePath),
    remotes,
  };
}

function normalizeRemoteWorkspaceRef(value: unknown): RemoteWorkspaceRef | null {
  const raw = asRecord(value);
  const id = normalizeOptionalString(raw.id);
  const workspacePath = normalizeOptionalString(raw.path);
  if (!id || !workspacePath) return null;
  const now = new Date().toISOString();
  return {
    id: normalizeIdentifier(id, 'remote.id'),
    workspaceId: normalizeOptionalString(raw.workspaceId) ?? normalizeOptionalString(raw.workspace_id) ?? normalizeIdentifier(id, 'remote.id'),
    name: normalizeOptionalString(raw.name) ?? normalizeIdentifier(id, 'remote.id'),
    path: normalizeRemoteWorkspacePath(workspacePath),
    enabled: asBoolean(raw.enabled, true),
    tags: normalizeTags(asArray(raw.tags).map((entry) => String(entry))),
    protocolVersion: normalizeProtocolVersion(raw.protocolVersion ?? raw.protocol_version),
    capabilities: normalizeCapabilitySet(raw.capabilities),
    trustLevel: normalizeTrustLevel(raw.trustLevel ?? raw.trust_level, 'read-only'),
    transport: normalizeTransportKind(raw.transport, 'local-path'),
    addedAt: normalizeOptionalString(raw.addedAt) ?? now,
    lastHandshakeAt: normalizeOptionalString(raw.lastHandshakeAt ?? raw.last_handshake_at),
    lastSyncedAt: normalizeOptionalString(raw.lastSyncedAt),
    lastSyncStatus: normalizeSyncStatus(raw.lastSyncStatus),
    lastSyncError: normalizeOptionalString(raw.lastSyncError),
  };
}

function normalizeSyncStatus(value: unknown): 'synced' | 'error' | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (normalized === 'synced' || normalized === 'error') {
    return normalized;
  }
  return undefined;
}

function normalizeIdentifier(value: unknown, label: string): string {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) {
    throw new Error(`Invalid ${label}. Expected a non-empty identifier.`);
  }
  return normalized;
}

function normalizeRemoteWorkspacePath(value: unknown): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error('Invalid remote workspace path. Expected a non-empty path.');
  }
  return path.resolve(normalized).replace(/\\/g, '/');
}

function normalizeThreadPathRef(value: unknown, label: string): string {
  const normalized = normalizeMarkdownRef(value);
  if (!normalized) {
    throw new Error(`Invalid ${label}. Expected a markdown thread reference.`);
  }
  if (!normalized.startsWith('threads/')) {
    throw new Error(`Invalid ${label}. Expected a thread ref under "threads/". Received "${normalized}".`);
  }
  return normalized;
}

function normalizeMarkdownRef(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const unwrapped = raw.startsWith('[[') && raw.endsWith(']]')
    ? raw.slice(2, -2)
    : raw;
  const primary = unwrapped.split('|')[0].trim().split('#')[0].trim();
  if (!primary) return '';
  return primary.endsWith('.md') ? primary : `${primary}.md`;
}

function normalizeTags(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  for (const value of values) {
    const tag = String(value ?? '').trim();
    if (!tag) continue;
    seen.add(tag);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

function appendThreadFederationLink(body: string, link: string, remoteName: string): string {
  const currentBody = String(body ?? '');
  if (currentBody.includes(link)) return currentBody;
  const sectionTitle = '## Federated links';
  const line = `- ${remoteName}: ${link}`;
  if (currentBody.includes(sectionTitle)) {
    return `${currentBody.trimEnd()}\n${line}\n`;
  }
  const trimmed = currentBody.trimEnd();
  return trimmed
    ? `${trimmed}\n\n${sectionTitle}\n\n${line}\n`
    : `${sectionTitle}\n\n${line}\n`;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry ?? '').trim())
    .filter((entry) => entry.length > 0);
}

function readFederatedRefs(value: unknown): FederatedPrimitiveRef[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeFederatedPrimitiveRef(entry))
    .filter((entry): entry is FederatedPrimitiveRef => entry !== null);
}

function readRemoteWorkspaceIdentity(workspacePath: string): FederationWorkspaceIdentity {
  const configPath = federationConfigPath(workspacePath);
  if (!fs.existsSync(configPath)) {
    return {
      workspaceId: deriveWorkspaceId(workspacePath),
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      capabilities: [...DEFAULT_FEDERATION_CAPABILITIES],
      trustLevel: 'read-only',
    };
  }
  try {
    const raw = YAML.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
    const root = asRecord(raw);
    return normalizeFederationWorkspaceIdentity(root.workspace, workspacePath, 'read-only');
  } catch {
    return {
      workspaceId: deriveWorkspaceId(workspacePath),
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      capabilities: [...DEFAULT_FEDERATION_CAPABILITIES],
      trustLevel: 'read-only',
    };
  }
}

function handshakeRemoteWorkspace(
  workspacePath: string,
  remote: RemoteWorkspaceRef,
): FederationHandshakeResult {
  const local = ensureFederationConfig(workspacePath).workspace;
  if (!fs.existsSync(remote.path)) {
    return {
      remote,
      identity: {
        workspaceId: remote.workspaceId,
        protocolVersion: remote.protocolVersion,
        capabilities: remote.capabilities,
        trustLevel: remote.trustLevel,
      },
      compatible: false,
      supportsRead: false,
      supportsSearch: false,
      error: `Remote workspace path not found: ${remote.path}`,
    };
  }
  const identity = readRemoteWorkspaceIdentity(remote.path);
  const compatible = identity.protocolVersion === local.protocolVersion;
  const supportsRead = identity.capabilities.includes('resolve-ref') && (
    identity.capabilities.includes('read-primitive') || identity.capabilities.includes('read-thread')
  );
  const supportsSearch = identity.capabilities.includes('search');
  return {
    remote,
    identity,
    compatible,
    supportsRead,
    supportsSearch,
    ...(compatible ? {} : {
      error: `Protocol mismatch for remote "${remote.id}": local=${local.protocolVersion} remote=${identity.protocolVersion}.`,
    }),
  };
}

function resolveRemotePrimitive(
  workspacePath: string,
  ref: FederatedPrimitiveRef,
): PrimitiveInstance | null {
  if (ref.primitivePath) {
    const direct = store.read(workspacePath, ref.primitivePath);
    if (direct) return direct;
  }
  const instances = store.list(workspacePath, ref.primitiveType);
  return instances.find((instance) => primitiveSlugFromPath(instance.path) === ref.primitiveSlug) ?? null;
}

function findLocalAuthorityWinner(
  workspacePath: string,
  ref: FederatedPrimitiveRef,
): PrimitiveInstance | null {
  return resolveRemotePrimitive(workspacePath, {
    ...ref,
    workspaceId: 'local',
  });
}

function isRemoteResultStale(
  remote: RemoteWorkspaceRef,
  instance: PrimitiveInstance,
): boolean {
  if (!remote.lastSyncedAt) return true;
  const syncedAt = Date.parse(remote.lastSyncedAt);
  const updatedAt = Date.parse(String(instance.fields.updated ?? instance.fields.created ?? ''));
  if (!Number.isFinite(syncedAt) || !Number.isFinite(updatedAt)) return true;
  return updatedAt > syncedAt;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return fallback;
}
