/**
 * Capability registry + thread routing helpers.
 */

import * as store from './store.js';
import type { PrimitiveInstance } from './types.js';

const DEFAULT_CAPABILITY_VERSION = '*';
const DEFAULT_CAPABILITY_CONFIDENCE = 1;

export interface CapabilityDescriptor {
  name: string;
  version: string;
  confidence: number;
}

export interface AgentCapabilityProfile {
  agent: string;
  capabilities: CapabilityDescriptor[];
  sources: string[];
  status?: 'online' | 'busy' | 'offline';
  lastSeen?: string;
}

export interface CapabilityRegistryEntry {
  name: string;
  versions: string[];
  agents: Array<{
    agent: string;
    version: string;
    confidence: number;
  }>;
}

export interface CapabilitySearchResult {
  query: string;
  matches: Array<{
    agent: string;
    capability: CapabilityDescriptor;
  }>;
}

export interface CapabilityThreadMatchCandidate {
  agent: string;
  score: number;
  matchedCapabilities: CapabilityDescriptor[];
  missingCapabilities: CapabilityDescriptor[];
  profile: AgentCapabilityProfile;
}

export interface CapabilityThreadMatchResult {
  threadPath: string;
  requiredCapabilities: CapabilityDescriptor[];
  explicitAssignee?: string;
  candidates: CapabilityThreadMatchCandidate[];
  best?: CapabilityThreadMatchCandidate;
  manualAssignmentRequired: boolean;
  reason?: string;
}

export interface CapabilityThreadMatchOptions {
  candidateAgents?: string[];
  includeOfflineAgents?: boolean;
}

export function listCapabilityRegistry(workspacePath: string): CapabilityRegistryEntry[] {
  const profiles = collectAgentCapabilityProfiles(workspacePath);
  const byCapability = new Map<string, CapabilityRegistryEntry>();

  for (const profile of profiles) {
    for (const capability of profile.capabilities) {
      const key = capability.name;
      const existing = byCapability.get(key) ?? {
        name: capability.name,
        versions: [],
        agents: [],
      };
      if (!existing.versions.includes(capability.version)) {
        existing.versions.push(capability.version);
      }
      existing.agents.push({
        agent: profile.agent,
        version: capability.version,
        confidence: capability.confidence,
      });
      byCapability.set(key, existing);
    }
  }

  return [...byCapability.values()]
    .map((entry) => ({
      ...entry,
      versions: [...entry.versions].sort((left, right) => left.localeCompare(right)),
      agents: [...entry.agents].sort((left, right) =>
        left.agent.localeCompare(right.agent)
        || left.version.localeCompare(right.version)
      ),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function searchAgentsByCapability(workspacePath: string, name: string): CapabilitySearchResult {
  const normalizedQuery = normalizeToken(name);
  const profiles = collectAgentCapabilityProfiles(workspacePath);
  const matches: CapabilitySearchResult['matches'] = [];

  for (const profile of profiles) {
    for (const capability of profile.capabilities) {
      if (capability.name === normalizedQuery) {
        matches.push({
          agent: profile.agent,
          capability,
        });
      }
    }
  }

  matches.sort((left, right) =>
    right.capability.confidence - left.capability.confidence
    || left.agent.localeCompare(right.agent)
    || left.capability.version.localeCompare(right.capability.version)
  );
  return {
    query: normalizedQuery,
    matches,
  };
}

export function matchThreadToBestAgent(
  workspacePath: string,
  threadRef: string | PrimitiveInstance,
  options: CapabilityThreadMatchOptions = {},
): CapabilityThreadMatchResult {
  const threadInstance = typeof threadRef === 'string'
    ? resolveThread(workspacePath, threadRef)
    : threadRef;
  if (!threadInstance) {
    throw new Error(`Thread not found: ${threadRef}`);
  }
  if (threadInstance.type !== 'thread') {
    throw new Error(`Expected thread primitive, found ${threadInstance.type} at ${threadInstance.path}.`);
  }

  const requiredCapabilities = readCapabilityList(
    threadInstance.fields.required_capabilities ?? threadInstance.fields.requiredCapabilities,
  );
  const explicitAssignee = readOptionalString(threadInstance.fields.assignee);
  const candidateFilter = new Set(
    (options.candidateAgents ?? [])
      .map((agent) => normalizeToken(agent))
      .filter(Boolean),
  );
  const includeOfflineAgents = options.includeOfflineAgents === true;
  const profiles = collectAgentCapabilityProfiles(workspacePath)
    .filter((profile) => candidateFilter.size === 0 || candidateFilter.has(normalizeToken(profile.agent)))
    .filter((profile) => includeOfflineAgents || profile.status !== 'offline');

  if (explicitAssignee) {
    const explicitProfile = profiles.find((profile) => normalizeToken(profile.agent) === explicitAssignee);
    if (!explicitProfile) {
      return {
        threadPath: threadInstance.path,
        requiredCapabilities,
        explicitAssignee,
        candidates: [],
        manualAssignmentRequired: true,
        reason: `Explicit assignee "${explicitAssignee}" has no capability profile.`,
      };
    }
    const explicitCandidate = evaluateProfileAgainstRequirements(explicitProfile, requiredCapabilities);
    return {
      threadPath: threadInstance.path,
      requiredCapabilities,
      explicitAssignee,
      candidates: [explicitCandidate],
      ...(explicitCandidate.missingCapabilities.length === 0 ? { best: explicitCandidate } : {}),
      manualAssignmentRequired: explicitCandidate.missingCapabilities.length > 0,
      ...(explicitCandidate.missingCapabilities.length > 0
        ? { reason: `Explicit assignee "${explicitAssignee}" is missing required capabilities.` }
        : {}),
    };
  }

  const candidates = profiles
    .map((profile) => evaluateProfileAgainstRequirements(profile, requiredCapabilities))
    .sort((left, right) =>
      right.score - left.score
      || left.missingCapabilities.length - right.missingCapabilities.length
      || left.agent.localeCompare(right.agent)
    );
  const best = candidates.find((candidate) => candidate.missingCapabilities.length === 0);

  return {
    threadPath: threadInstance.path,
    requiredCapabilities,
    candidates,
    ...(best ? { best } : {}),
    manualAssignmentRequired: !best,
    ...(!best ? { reason: 'No agent satisfies required capabilities.' } : {}),
  };
}

export function agentMatchesThreadRequirements(
  workspacePath: string,
  agentName: string,
  threadRef: string | PrimitiveInstance,
): CapabilityThreadMatchCandidate {
  const normalizedAgent = normalizeToken(agentName);
  const profile = collectAgentCapabilityProfiles(workspacePath)
    .find((entry) => normalizeToken(entry.agent) === normalizedAgent);
  const threadInstance = typeof threadRef === 'string'
    ? resolveThread(workspacePath, threadRef)
    : threadRef;
  if (!threadInstance) {
    throw new Error(`Thread not found: ${threadRef}`);
  }
  if (threadInstance.type !== 'thread') {
    throw new Error(`Expected thread primitive, found ${threadInstance.type} at ${threadInstance.path}.`);
  }
  const requiredCapabilities = readCapabilityList(
    threadInstance.fields.required_capabilities ?? threadInstance.fields.requiredCapabilities,
  );
  if (!profile) {
    return {
      agent: agentName,
      score: 0,
      matchedCapabilities: [],
      missingCapabilities: requiredCapabilities,
      profile: {
        agent: agentName,
        capabilities: [],
        sources: [],
      },
    };
  }
  return evaluateProfileAgainstRequirements(profile, requiredCapabilities);
}

export function collectAgentCapabilityProfiles(workspacePath: string): AgentCapabilityProfile[] {
  const profiles = new Map<string, AgentCapabilityProfile>();
  const instances = [
    ...store.list(workspacePath, 'agent'),
    ...store.list(workspacePath, 'presence'),
  ];

  for (const instance of instances) {
    const agentName = readAgentName(instance);
    if (!agentName) continue;
    const capabilities = readCapabilityList(instance.fields.capabilities);
    const existing = profiles.get(agentName) ?? {
      agent: agentName,
      capabilities: [],
      sources: [],
    };
    const capabilityMap = new Map(
      existing.capabilities.map((capability) => [capabilityKey(capability), capability] as const),
    );
    for (const capability of capabilities) {
      const key = capabilityKey(capability);
      const prior = capabilityMap.get(key);
      if (!prior || capability.confidence > prior.confidence) {
        capabilityMap.set(key, capability);
      }
    }
    existing.capabilities = [...capabilityMap.values()].sort((left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
    );
    if (!existing.sources.includes(instance.path)) {
      existing.sources.push(instance.path);
    }
    const normalizedStatus = normalizePresenceStatus(instance.fields.status);
    if (normalizedStatus) {
      existing.status = prioritizeStatus(existing.status, normalizedStatus);
    }
    const lastSeen = readOptionalString(instance.fields.last_seen);
    if (lastSeen && (!existing.lastSeen || lastSeen > existing.lastSeen)) {
      existing.lastSeen = lastSeen;
    }
    profiles.set(agentName, existing);
  }

  return [...profiles.values()].sort((left, right) => left.agent.localeCompare(right.agent));
}

function readAgentName(instance: PrimitiveInstance): string {
  if (instance.type === 'presence') {
    return normalizeToken(instance.fields.name) || normalizeToken(instance.fields.title);
  }
  if (instance.type === 'agent') {
    return normalizeToken(instance.fields.name) || normalizeToken(instance.fields.title);
  }
  return '';
}

function readCapabilityList(value: unknown): CapabilityDescriptor[] {
  const inputValues: unknown[] = [];
  if (Array.isArray(value)) {
    inputValues.push(...value);
  } else if (typeof value === 'string') {
    inputValues.push(
      ...value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
  } else if (value && typeof value === 'object') {
    inputValues.push(value);
  } else {
    return [];
  }
  const output = new Map<string, CapabilityDescriptor>();
  for (const entry of inputValues) {
    const normalized = normalizeCapability(entry);
    if (!normalized) continue;
    const key = capabilityKey(normalized);
    const prior = output.get(key);
    if (!prior || normalized.confidence > prior.confidence) {
      output.set(key, normalized);
    }
  }
  return [...output.values()].sort((left, right) =>
    left.name.localeCompare(right.name)
    || left.version.localeCompare(right.version)
  );
}

function normalizeCapability(value: unknown): CapabilityDescriptor | null {
  if (typeof value === 'string') {
    const token = normalizeToken(value);
    if (!token) return null;
    return {
      name: token,
      version: DEFAULT_CAPABILITY_VERSION,
      confidence: DEFAULT_CAPABILITY_CONFIDENCE,
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const name = normalizeToken(record.name);
  if (!name) return null;
  const version = normalizeVersion(record.version);
  const confidence = normalizeConfidence(record.confidence);
  return {
    name,
    version,
    confidence,
  };
}

function evaluateProfileAgainstRequirements(
  profile: AgentCapabilityProfile,
  requirements: CapabilityDescriptor[],
): CapabilityThreadMatchCandidate {
  if (requirements.length === 0) {
    return {
      agent: profile.agent,
      score: 1,
      matchedCapabilities: [],
      missingCapabilities: [],
      profile,
    };
  }

  const matchedCapabilities: CapabilityDescriptor[] = [];
  const missingCapabilities: CapabilityDescriptor[] = [];
  let confidenceTotal = 0;

  for (const requirement of requirements) {
    const matched = profile.capabilities
      .filter((capability) => capability.name === requirement.name)
      .find((capability) => versionsCompatible(requirement.version, capability.version));
    if (!matched) {
      missingCapabilities.push(requirement);
      continue;
    }
    matchedCapabilities.push(matched);
    confidenceTotal += matched.confidence;
  }

  const completeness = matchedCapabilities.length / requirements.length;
  const confidenceScore = matchedCapabilities.length === 0
    ? 0
    : confidenceTotal / matchedCapabilities.length;
  const score = completeness * 0.7 + confidenceScore * 0.3;

  return {
    agent: profile.agent,
    score: Number(score.toFixed(4)),
    matchedCapabilities,
    missingCapabilities,
    profile,
  };
}

function versionsCompatible(requiredVersion: string, availableVersion: string): boolean {
  if (requiredVersion === DEFAULT_CAPABILITY_VERSION || availableVersion === DEFAULT_CAPABILITY_VERSION) {
    return true;
  }
  if (requiredVersion === availableVersion) {
    return true;
  }
  if (requiredVersion.endsWith('.*')) {
    const prefix = requiredVersion.slice(0, -2);
    return availableVersion.startsWith(`${prefix}.`);
  }
  return false;
}

function capabilityKey(capability: CapabilityDescriptor): string {
  return `${capability.name}@${capability.version}`;
}

function normalizeToken(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function normalizeVersion(value: unknown): string {
  const normalized = normalizeToken(value);
  return normalized || DEFAULT_CAPABILITY_VERSION;
}

function normalizeConfidence(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clampConfidence(value);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return clampConfidence(parsed);
    }
  }
  return DEFAULT_CAPABILITY_CONFIDENCE;
}

function clampConfidence(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return Number(value.toFixed(4));
}

function resolveThread(workspacePath: string, threadRef: string): PrimitiveInstance | null {
  const normalized = normalizeThreadRef(threadRef);
  if (!normalized) return null;
  return store.read(workspacePath, normalized);
}

function normalizeThreadRef(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const unwrapped = raw.startsWith('[[') && raw.endsWith(']]')
    ? raw.slice(2, -2)
    : raw;
  if (!unwrapped) return '';
  if (unwrapped.includes('/')) {
    return unwrapped.endsWith('.md') ? unwrapped : `${unwrapped}.md`;
  }
  return `threads/${unwrapped.endsWith('.md') ? unwrapped : `${unwrapped}.md`}`;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = normalizeToken(value);
  return normalized || undefined;
}

function normalizePresenceStatus(value: unknown): 'online' | 'busy' | 'offline' | undefined {
  const normalized = normalizeToken(value);
  if (normalized === 'online' || normalized === 'busy' || normalized === 'offline') {
    return normalized;
  }
  return undefined;
}

function prioritizeStatus(
  existing: AgentCapabilityProfile['status'],
  incoming: NonNullable<AgentCapabilityProfile['status']>,
): AgentCapabilityProfile['status'] {
  if (!existing) return incoming;
  const rank = (status: NonNullable<AgentCapabilityProfile['status']>): number => {
    switch (status) {
      case 'online':
        return 0;
      case 'busy':
        return 1;
      case 'offline':
        return 2;
      default:
        return 3;
    }
  };
  return rank(incoming) < rank(existing) ? incoming : existing;
}
