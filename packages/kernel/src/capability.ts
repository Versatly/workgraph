/**
 * Capability registry and thread-to-agent capability matching.
 */

import path from 'node:path';
import * as store from './store.js';
import type { PrimitiveInstance } from './types.js';

const REQUIRED_CAPABILITY_TAG_PREFIX = 'requires:capability:';

export interface AgentCapabilityProfile {
  agentName: string;
  paths: string[];
  capabilities: string[];
  status?: string;
  currentTask?: string;
  lastSeen?: string;
}

export interface CapabilityRegistryEntry {
  capability: string;
  agents: string[];
  count: number;
}

export interface CapabilityRegistry {
  generatedAt: string;
  agents: AgentCapabilityProfile[];
  capabilities: CapabilityRegistryEntry[];
}

export interface CapabilitySearchResult {
  query: string;
  capabilities: CapabilityRegistryEntry[];
  agents: AgentCapabilityProfile[];
}

export interface AgentThreadCapabilityMatch {
  agent: AgentCapabilityProfile;
  missingCapabilities: string[];
  matched: boolean;
}

export interface ThreadCapabilityMatchResult {
  thread: PrimitiveInstance;
  requiredCapabilities: string[];
  matches: AgentThreadCapabilityMatch[];
}

interface MutableAgentCapabilityProfile {
  agentName: string;
  paths: Set<string>;
  capabilities: Set<string>;
  status?: string;
  currentTask?: string;
  lastSeen?: string;
}

export function collectAgentCapabilities(workspacePath: string): AgentCapabilityProfile[] {
  const entries = store.list(workspacePath, 'presence')
    .filter((entry) => entry.path.startsWith('agents/'));
  const byAgent = new Map<string, MutableAgentCapabilityProfile>();

  for (const entry of entries) {
    const inferredName = normalizeAgentName(entry.fields.name ?? path.basename(entry.path, '.md'));
    if (!inferredName) continue;
    const existing = byAgent.get(inferredName) ?? {
      agentName: inferredName,
      paths: new Set<string>(),
      capabilities: new Set<string>(),
    };

    existing.paths.add(entry.path);
    for (const capability of asCapabilityList(entry.fields.capabilities)) {
      existing.capabilities.add(capability);
    }

    if (entry.type === 'presence') {
      mergePresenceMetadata(existing, entry);
    }

    byAgent.set(inferredName, existing);
  }

  return [...byAgent.values()]
    .map((entry) => ({
      agentName: entry.agentName,
      paths: [...entry.paths].sort((a, b) => a.localeCompare(b)),
      capabilities: [...entry.capabilities].sort((a, b) => a.localeCompare(b)),
      ...(entry.status ? { status: entry.status } : {}),
      ...(entry.currentTask ? { currentTask: entry.currentTask } : {}),
      ...(entry.lastSeen ? { lastSeen: entry.lastSeen } : {}),
    }))
    .sort((a, b) => a.agentName.localeCompare(b.agentName));
}

export function buildCapabilityRegistry(workspacePath: string): CapabilityRegistry {
  const agents = collectAgentCapabilities(workspacePath);
  const capabilityMap = new Map<string, Set<string>>();

  for (const agentProfile of agents) {
    for (const capability of agentProfile.capabilities) {
      const existing = capabilityMap.get(capability) ?? new Set<string>();
      existing.add(agentProfile.agentName);
      capabilityMap.set(capability, existing);
    }
  }

  const capabilities = [...capabilityMap.entries()]
    .map(([capability, agentsForCapability]) => ({
      capability,
      agents: [...agentsForCapability].sort((a, b) => a.localeCompare(b)),
      count: agentsForCapability.size,
    }))
    .sort((a, b) => a.capability.localeCompare(b.capability));

  return {
    generatedAt: new Date().toISOString(),
    agents,
    capabilities,
  };
}

export function searchCapabilities(workspacePath: string, query: string): CapabilitySearchResult {
  const normalizedQuery = normalizeToken(query);
  if (!normalizedQuery) {
    throw new Error('Capability query cannot be empty.');
  }
  const registry = buildCapabilityRegistry(workspacePath);
  const capabilities = registry.capabilities.filter((entry) =>
    entry.capability.includes(normalizedQuery) ||
    entry.agents.some((agentName) => agentName.includes(normalizedQuery))
  );
  const agents = registry.agents.filter((agentProfile) =>
    agentProfile.agentName.includes(normalizedQuery) ||
    agentProfile.capabilities.some((capability) => capability.includes(normalizedQuery))
  );
  return {
    query: normalizedQuery,
    capabilities,
    agents,
  };
}

export function matchThreadToAgents(
  workspacePath: string,
  threadRefOrInstance: string | PrimitiveInstance,
): ThreadCapabilityMatchResult {
  const threadInstance = resolveThread(workspacePath, threadRefOrInstance);
  const requiredCapabilities = extractThreadRequiredCapabilities(threadInstance);
  const agents = collectAgentCapabilities(workspacePath);
  const matches = agents
    .map((agentProfile) => {
      const missingCapabilities = requiredCapabilities.filter((requiredCapability) =>
        !capabilitySatisfied(agentProfile.capabilities, requiredCapability)
      );
      return {
        agent: agentProfile,
        missingCapabilities,
        matched: missingCapabilities.length === 0,
      };
    })
    .sort((a, b) => {
      if (a.matched !== b.matched) return a.matched ? -1 : 1;
      if (a.missingCapabilities.length !== b.missingCapabilities.length) {
        return a.missingCapabilities.length - b.missingCapabilities.length;
      }
      return a.agent.agentName.localeCompare(b.agent.agentName);
    });
  return {
    thread: threadInstance,
    requiredCapabilities,
    matches,
  };
}

export function extractThreadRequiredCapabilities(threadInstance: PrimitiveInstance): string[] {
  return dedupeStrings([
    ...asCapabilityList(threadInstance.fields.required_capabilities),
    ...asCapabilityList(threadInstance.fields.requiredCapabilities),
    ...extractTagCapabilityRequirements(threadInstance.fields.tags),
  ]);
}

function resolveThread(
  workspacePath: string,
  threadRefOrInstance: string | PrimitiveInstance,
): PrimitiveInstance {
  if (typeof threadRefOrInstance !== 'string') {
    if (threadRefOrInstance.type !== 'thread') {
      throw new Error(`Capability matching requires a thread instance, got "${threadRefOrInstance.type}".`);
    }
    return threadRefOrInstance;
  }

  const normalizedRef = normalizeThreadRef(threadRefOrInstance);
  if (!normalizedRef) {
    throw new Error('Thread reference cannot be empty.');
  }

  if (normalizedRef.includes('/')) {
    const resolved = store.read(workspacePath, normalizedRef);
    if (!resolved) throw new Error(`Thread not found: ${normalizedRef}`);
    if (resolved.type !== 'thread') {
      throw new Error(`Expected thread at ${normalizedRef}, found "${resolved.type}".`);
    }
    return resolved;
  }

  const normalizedSlug = normalizedRef.endsWith('.md')
    ? normalizedRef.slice(0, -3)
    : normalizedRef;
  const threads = store.list(workspacePath, 'thread').filter((entry) => entry.type === 'thread');
  const byPathSlug = threads.find((entry) => path.basename(entry.path, '.md') === normalizedSlug);
  if (byPathSlug) return byPathSlug;

  const byTid = threads.find((entry) => normalizeToken(entry.fields.tid) === normalizedSlug);
  if (byTid) return byTid;

  throw new Error(`Thread not found for ref "${threadRefOrInstance}".`);
}

function mergePresenceMetadata(
  profile: MutableAgentCapabilityProfile,
  presence: PrimitiveInstance,
): void {
  const status = readOptionalString(presence.fields.status);
  const currentTask = readOptionalString(presence.fields.current_task);
  const lastSeen = readOptionalString(presence.fields.last_seen);

  if (!lastSeen) {
    if (!profile.status && status) profile.status = status;
    if (!profile.currentTask && currentTask) profile.currentTask = currentTask;
    return;
  }

  const profileLastSeenTs = Date.parse(profile.lastSeen ?? '');
  const candidateLastSeenTs = Date.parse(lastSeen);
  const useCandidate = !Number.isFinite(profileLastSeenTs) ||
    (Number.isFinite(candidateLastSeenTs) && candidateLastSeenTs >= profileLastSeenTs);

  if (useCandidate) {
    profile.lastSeen = lastSeen;
    profile.status = status ?? profile.status;
    profile.currentTask = currentTask ?? profile.currentTask;
  }
}

function extractTagCapabilityRequirements(tags: unknown): string[] {
  return asCapabilityList(tags)
    .filter((tag) => tag.startsWith(REQUIRED_CAPABILITY_TAG_PREFIX))
    .map((tag) => tag.slice(REQUIRED_CAPABILITY_TAG_PREFIX.length))
    .filter(Boolean);
}

function capabilitySatisfied(grantedCapabilities: string[], requiredCapability: string): boolean {
  const normalizedRequired = normalizeToken(requiredCapability);
  if (!normalizedRequired) return true;
  for (const grantedCapability of grantedCapabilities) {
    if (grantedCapability === '*') return true;
    if (grantedCapability === normalizedRequired) return true;
    if (
      grantedCapability.endsWith(':*') &&
      normalizedRequired.startsWith(`${grantedCapability.slice(0, -2)}:`)
    ) {
      return true;
    }
  }
  return false;
}

function normalizeThreadRef(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const unwrapped = raw.startsWith('[[') && raw.endsWith(']]')
    ? raw.slice(2, -2)
    : raw;
  const primary = unwrapped.split('|')[0].trim().split('#')[0].trim();
  if (!primary) return '';
  if (primary.includes('/')) {
    return primary.endsWith('.md') ? primary : `${primary}.md`;
  }
  return normalizeToken(primary);
}

function normalizeAgentName(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeToken(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function asCapabilityList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeToken(entry))
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => normalizeToken(entry))
      .filter(Boolean);
  }
  return [];
}

function dedupeStrings(values: string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const normalized = normalizeToken(value);
    if (!normalized) continue;
    unique.add(normalized);
  }
  return [...unique];
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
