/**
 * Agent presence primitives.
 */

import path from 'node:path';
import * as policy from './policy.js';
import * as store from './store.js';
import { loadServerConfig } from './server-config.js';
import type { PolicyParty, PrimitiveInstance } from './types.js';

export type AgentPresenceStatus = 'online' | 'busy' | 'offline';

export interface AgentHeartbeatOptions {
  status?: AgentPresenceStatus;
  currentTask?: string;
  capabilities?: string[];
  actor?: string;
}

export interface AgentRegistrationOptions {
  token: string;
  role?: string;
  capabilities?: string[];
  status?: AgentPresenceStatus;
  currentTask?: string;
  actor?: string;
}

export interface AgentRegistrationResult {
  agentName: string;
  rolePath: string;
  role: string;
  capabilities: string[];
  trustTokenPath: string;
  trustTokenStatus: string;
  policyParty: PolicyParty;
  presence: PrimitiveInstance;
}

const PRESENCE_TYPE = 'presence';
const ROLE_TYPE = 'role';
const TRUST_TOKEN_TYPE = 'trust-token';
const PRESENCE_STATUS_VALUES = new Set<AgentPresenceStatus>(['online', 'busy', 'offline']);

export function heartbeat(
  workspacePath: string,
  name: string,
  options: AgentHeartbeatOptions = {},
): PrimitiveInstance {
  const existing = getPresence(workspacePath, name);
  const now = new Date().toISOString();
  const status = normalizeStatus(options.status ?? existing?.fields.status) ?? 'online';
  const capabilities = normalizeCapabilities(options.capabilities ?? existing?.fields.capabilities);
  const actor = options.actor ?? name;
  const currentTask = options.currentTask !== undefined
    ? normalizeTask(options.currentTask)
    : normalizeTask(existing?.fields.current_task);

  if (!existing) {
    return store.create(
      workspacePath,
      PRESENCE_TYPE,
      {
        name,
        status,
        current_task: currentTask,
        last_seen: now,
        capabilities,
      },
      renderPresenceBody(name, status, currentTask, capabilities, now),
      actor,
    );
  }

  return store.update(
    workspacePath,
    existing.path,
    {
      name,
      status,
      current_task: currentTask,
      last_seen: now,
      capabilities,
    },
    renderPresenceBody(name, status, currentTask, capabilities, now),
    actor,
  );
}

export function list(workspacePath: string): PrimitiveInstance[] {
  return store.list(workspacePath, PRESENCE_TYPE)
    .sort((a, b) => {
      const aSeen = Date.parse(String(a.fields.last_seen ?? ''));
      const bSeen = Date.parse(String(b.fields.last_seen ?? ''));
      const safeA = Number.isFinite(aSeen) ? aSeen : 0;
      const safeB = Number.isFinite(bSeen) ? bSeen : 0;
      if (safeA !== safeB) return safeB - safeA;
      return String(a.fields.name ?? '').localeCompare(String(b.fields.name ?? ''));
    });
}

export function getPresence(workspacePath: string, name: string): PrimitiveInstance | null {
  const target = normalizeName(name);
  return list(workspacePath)
    .find((entry) => normalizeName(entry.fields.name) === target) ?? null;
}

export function registerAgent(
  workspacePath: string,
  name: string,
  options: AgentRegistrationOptions,
): AgentRegistrationResult {
  const registrationToken = String(options.token ?? '').trim();
  if (!registrationToken) {
    throw new Error('Trust token is required for agent registration.');
  }

  const serverConfig = loadServerConfig(workspacePath);
  if (!serverConfig) {
    throw new Error('Workspace server config not found. Run `workgraph init` to seed onboarding defaults.');
  }
  if (!serverConfig.registration.enabled) {
    throw new Error('Agent registration is disabled by workspace server config.');
  }

  const trustTokenPath = normalizePathLike(serverConfig.registration.bootstrapTokenPath);
  const trustToken = store.read(workspacePath, trustTokenPath);
  if (!trustToken) {
    throw new Error(`Bootstrap trust token primitive not found: ${trustTokenPath}`);
  }
  if (trustToken.type !== TRUST_TOKEN_TYPE) {
    throw new Error(`Invalid bootstrap token primitive type at ${trustTokenPath}: ${trustToken.type}`);
  }

  const storedToken = String(trustToken.fields.token ?? '').trim();
  if (!storedToken) {
    throw new Error(`Bootstrap trust token primitive ${trustTokenPath} has no token field.`);
  }
  if (storedToken !== registrationToken) {
    throw new Error('Invalid trust token.');
  }

  const tokenStatus = String(trustToken.fields.status ?? 'active').trim().toLowerCase();
  const normalizedAgentName = normalizeAgentId(name);
  if (!normalizedAgentName) {
    throw new Error(`Invalid agent name "${name}".`);
  }
  const usedBy = asStringList(trustToken.fields.used_by).map(normalizeAgentId);
  if (tokenStatus === 'revoked') {
    throw new Error(`Trust token at ${trustTokenPath} has been revoked.`);
  }
  if (tokenStatus === 'used' && !usedBy.includes(normalizedAgentName)) {
    throw new Error(`Trust token at ${trustTokenPath} has already been used.`);
  }

  const roleRef = options.role
    ?? readNonEmptyString(trustToken.fields.default_role)
    ?? 'admin';
  const rolePath = resolveRolePath(roleRef);
  const role = store.read(workspacePath, rolePath);
  if (!role) {
    throw new Error(`Role primitive not found: ${rolePath}`);
  }
  if (role.type !== ROLE_TYPE) {
    throw new Error(`Expected role primitive at ${rolePath}, found ${role.type}.`);
  }

  const roleCapabilities = normalizeCapabilities(role.fields.capabilities);
  const mergedCapabilities = dedupeStrings([
    ...roleCapabilities,
    ...normalizeCapabilities(options.capabilities),
  ]);
  const roleName = inferRoleName(role.path);

  const policyParty = policy.upsertParty(workspacePath, normalizedAgentName, {
    roles: [roleName],
    capabilities: mergedCapabilities,
  });

  const presence = heartbeat(workspacePath, normalizedAgentName, {
    actor: options.actor ?? normalizedAgentName,
    status: options.status ?? 'online',
    currentTask: options.currentTask,
    capabilities: mergedCapabilities,
  });

  const updatedTrustToken = consumeBootstrapTrustToken(
    workspacePath,
    trustToken,
    normalizedAgentName,
    options.actor ?? normalizedAgentName,
  );

  return {
    agentName: normalizedAgentName,
    rolePath: role.path,
    role: roleName,
    capabilities: mergedCapabilities,
    trustTokenPath: updatedTrustToken.path,
    trustTokenStatus: String(updatedTrustToken.fields.status ?? 'active'),
    policyParty,
    presence,
  };
}

function normalizeStatus(value: unknown): AgentPresenceStatus | null {
  const normalized = String(value ?? '').trim().toLowerCase() as AgentPresenceStatus;
  if (!PRESENCE_STATUS_VALUES.has(normalized)) return null;
  return normalized;
}

function normalizeCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry).trim())
    .filter(Boolean);
}

function consumeBootstrapTrustToken(
  workspacePath: string,
  trustToken: PrimitiveInstance,
  agentName: string,
  actor: string,
): PrimitiveInstance {
  const status = String(trustToken.fields.status ?? 'active').trim().toLowerCase();
  const usedBy = dedupeStrings(asStringList(trustToken.fields.used_by).map(normalizeAgentId));
  const alreadyUsedByAgent = usedBy.includes(agentName);
  if (status === 'used' && alreadyUsedByAgent) {
    return trustToken;
  }
  if (status === 'revoked') {
    return trustToken;
  }

  const maxUses = asPositiveNumber(trustToken.fields.max_uses) ?? 1;
  const usedCount = asNonNegativeNumber(trustToken.fields.used_count) ?? usedBy.length;
  const nextUsedBy = alreadyUsedByAgent
    ? usedBy
    : dedupeStrings([...usedBy, agentName]);
  const nextUsedCount = alreadyUsedByAgent
    ? usedCount
    : usedCount + 1;
  const nextStatus = nextUsedCount >= maxUses ? 'used' : 'active';

  return store.update(
    workspacePath,
    trustToken.path,
    {
      used_by: nextUsedBy,
      used_count: nextUsedCount,
      status: nextStatus,
    },
    undefined,
    actor,
  );
}

function normalizeTask(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized : null;
}

function normalizeName(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeAgentId(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-|-$/g, '');
}

function resolveRolePath(roleRef: string): string {
  const normalizedRef = normalizePathLike(roleRef);
  if (normalizedRef.includes('/')) return normalizedRef;
  const roleSlugSource = normalizedRef.endsWith('.md')
    ? normalizedRef.slice(0, -3)
    : normalizedRef;
  return `roles/${slugify(roleSlugSource)}.md`;
}

function normalizePathLike(value: unknown): string {
  const trimmed = String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  if (!trimmed) return '';
  const unwrapped = trimmed.startsWith('[[') && trimmed.endsWith(']]')
    ? trimmed.slice(2, -2)
    : trimmed;
  return unwrapped.endsWith('.md') ? unwrapped : `${unwrapped}.md`;
}

function slugify(value: string): string {
  const normalized = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'role';
}

function inferRoleName(rolePath: string): string {
  const basename = path.basename(rolePath, '.md').trim().toLowerCase();
  return basename || 'role';
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = String(value).trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry).trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function asPositiveNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function asNonNegativeNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function renderPresenceBody(
  name: string,
  status: AgentPresenceStatus,
  currentTask: string | null,
  capabilities: string[],
  lastSeen: string,
): string {
  const lines = [
    '## Presence',
    '',
    `- agent: ${name}`,
    `- status: ${status}`,
    `- last_seen: ${lastSeen}`,
    `- current_task: ${currentTask ?? 'none'}`,
    '',
    '## Capabilities',
    '',
    ...(capabilities.length > 0
      ? capabilities.map((capability) => `- ${capability}`)
      : ['- none']),
    '',
  ];
  return lines.join('\n');
}
