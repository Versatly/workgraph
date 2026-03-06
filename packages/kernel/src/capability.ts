/**
 * Agent capability registry and thread requirement matching.
 */

import * as policy from './policy.js';
import * as store from './store.js';
import type { PrimitiveInstance } from './types.js';

export const REQUIREMENT_TAG_PREFIXES = {
  capability: 'requires:capability:',
  skill: 'requires:skill:',
  adapter: 'requires:adapter:',
} as const;

export type CapabilitySource = 'policy' | 'presence';

export interface AgentCapabilityProfile {
  agentName: string;
  capabilities: string[];
  skills: string[];
  adapters: string[];
  sources: CapabilitySource[];
}

export interface CapabilityRegistryEntry {
  capability: string;
  agents: string[];
}

export interface AgentCapabilityRegistry {
  generatedAt: string;
  agents: AgentCapabilityProfile[];
  capabilities: CapabilityRegistryEntry[];
}

export interface ThreadCapabilityRequirements {
  capabilities: string[];
  skills: string[];
  adapters: string[];
}

export interface CapabilityMatchProfile {
  capabilities?: string[];
  skills?: string[];
  adapters?: string[];
}

export interface ThreadCapabilityMatch {
  thread: PrimitiveInstance;
  requirements: ThreadCapabilityRequirements;
  missing: ThreadCapabilityRequirements;
  matched: boolean;
}

export interface ThreadAgentCapabilityMatch extends ThreadCapabilityMatch {
  profile: AgentCapabilityProfile;
}

export function buildAgentCapabilityRegistry(workspacePath: string): AgentCapabilityRegistry {
  const byAgent = new Map<string, {
    capabilities: Set<string>;
    sources: Set<CapabilitySource>;
  }>();

  const ensureAgent = (agentName: string) => {
    const normalizedAgent = normalizeToken(agentName);
    if (!normalizedAgent) return null;
    const existing = byAgent.get(normalizedAgent);
    if (existing) return existing;
    const created = {
      capabilities: new Set<string>(),
      sources: new Set<CapabilitySource>(),
    };
    byAgent.set(normalizedAgent, created);
    return created;
  };

  const policyRegistry = policy.loadPolicyRegistry(workspacePath);
  for (const party of Object.values(policyRegistry.parties)) {
    const agent = ensureAgent(party.id);
    if (!agent) continue;
    for (const capability of asStringList(party.capabilities)) {
      agent.capabilities.add(capability);
    }
    if (agent.capabilities.size > 0) {
      agent.sources.add('policy');
    }
  }

  const presenceEntries = store.list(workspacePath, 'presence');
  for (const presence of presenceEntries) {
    const fallbackName = basenameWithoutExtension(presence.path);
    const agent = ensureAgent(String(presence.fields.name ?? fallbackName));
    if (!agent) continue;
    const capabilities = asStringList(presence.fields.capabilities);
    for (const capability of capabilities) {
      agent.capabilities.add(capability);
    }
    if (capabilities.length > 0) {
      agent.sources.add('presence');
    }
  }

  const agents: AgentCapabilityProfile[] = [...byAgent.entries()]
    .map(([agentName, value]) => {
      const capabilities = [...value.capabilities].sort((a, b) => a.localeCompare(b));
      const skills = extractScopedValues(capabilities, 'skill:');
      const adapters = extractScopedValues(capabilities, 'adapter:');
      return {
        agentName,
        capabilities,
        skills,
        adapters,
        sources: [...value.sources].sort((a, b) => a.localeCompare(b)),
      };
    })
    .sort((a, b) => a.agentName.localeCompare(b.agentName));

  const capabilityMap = new Map<string, Set<string>>();
  for (const agent of agents) {
    for (const capability of agent.capabilities) {
      const existing = capabilityMap.get(capability);
      if (existing) {
        existing.add(agent.agentName);
      } else {
        capabilityMap.set(capability, new Set([agent.agentName]));
      }
    }
  }
  const capabilities: CapabilityRegistryEntry[] = [...capabilityMap.entries()]
    .map(([capability, agentsWithCapability]) => ({
      capability,
      agents: [...agentsWithCapability].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.capability.localeCompare(b.capability));

  return {
    generatedAt: new Date().toISOString(),
    agents,
    capabilities,
  };
}

export function searchCapabilityRegistry(
  workspacePath: string,
  query: string,
): CapabilityRegistryEntry[] {
  const registry = buildAgentCapabilityRegistry(workspacePath);
  const normalizedQuery = normalizeToken(query);
  if (!normalizedQuery) return registry.capabilities;
  return registry.capabilities.filter((entry) =>
    entry.capability.includes(normalizedQuery) ||
    entry.agents.some((agentName) => agentName.includes(normalizedQuery))
  );
}

export function resolveAgentCapabilityProfile(
  workspacePath: string,
  agentName: string,
): AgentCapabilityProfile {
  const normalizedAgent = normalizeToken(agentName);
  if (!normalizedAgent) {
    throw new Error('Agent name is required.');
  }
  const registry = buildAgentCapabilityRegistry(workspacePath);
  const existing = registry.agents.find((entry) => entry.agentName === normalizedAgent);
  if (existing) return existing;
  return {
    agentName: normalizedAgent,
    capabilities: [],
    skills: [],
    adapters: [],
    sources: [],
  };
}

export function resolveThreadInstance(
  workspacePath: string,
  threadRef: string,
): PrimitiveInstance | null {
  const normalizedRef = normalizeThreadRef(threadRef);
  if (!normalizedRef) return null;
  const direct = store.read(workspacePath, normalizedRef);
  if (direct?.type === 'thread') return direct;
  const slug = basenameWithoutExtension(normalizedRef);
  if (!slug) return null;
  return store.list(workspacePath, 'thread')
    .find((candidate) => basenameWithoutExtension(candidate.path) === slug) ?? null;
}

export function matchThreadToAgent(
  workspacePath: string,
  threadRef: string,
  agentName: string,
): ThreadAgentCapabilityMatch {
  const threadInstance = resolveThreadInstance(workspacePath, threadRef);
  if (!threadInstance) {
    throw new Error(`Thread not found: ${threadRef}`);
  }
  const profile = resolveAgentCapabilityProfile(workspacePath, agentName);
  return {
    ...matchThreadToCapabilityProfile(threadInstance, profile),
    profile,
  };
}

export function readThreadCapabilityRequirements(
  threadInstance: PrimitiveInstance,
): ThreadCapabilityRequirements {
  const capabilityRequirements = dedupeStrings([
    ...asStringList(threadInstance.fields.required_capabilities),
    ...asStringList(threadInstance.fields.requiredCapabilities),
    ...extractTagRequirements(threadInstance.fields.tags, REQUIREMENT_TAG_PREFIXES.capability),
  ]);
  const skillRequirements = dedupeStrings([
    ...asStringList(threadInstance.fields.required_skills),
    ...asStringList(threadInstance.fields.requiredSkills),
    ...extractTagRequirements(threadInstance.fields.tags, REQUIREMENT_TAG_PREFIXES.skill),
  ]);
  const adapterRequirements = dedupeStrings([
    ...asStringList(threadInstance.fields.required_adapters),
    ...asStringList(threadInstance.fields.requiredAdapters),
    ...extractTagRequirements(threadInstance.fields.tags, REQUIREMENT_TAG_PREFIXES.adapter),
  ]);

  return {
    capabilities: capabilityRequirements,
    skills: skillRequirements,
    adapters: adapterRequirements,
  };
}

export function matchThreadToCapabilityProfile(
  threadInstance: PrimitiveInstance,
  profile: CapabilityMatchProfile,
): ThreadCapabilityMatch {
  const normalizedCapabilities = dedupeStrings(asStringList(profile.capabilities));
  const normalizedSkills = dedupeStrings([
    ...extractScopedValues(normalizedCapabilities, 'skill:'),
    ...asStringList(profile.skills),
  ]);
  const normalizedAdapters = dedupeStrings([
    ...extractScopedValues(normalizedCapabilities, 'adapter:'),
    ...asStringList(profile.adapters),
  ]);
  const requirements = readThreadCapabilityRequirements(threadInstance);
  const missingCapabilities = requirements.capabilities
    .filter((requiredCapability) => !capabilitySatisfied(normalizedCapabilities, requiredCapability));
  const missingSkills = requirements.skills
    .filter((requiredSkill) => !normalizedSkills.includes(requiredSkill));
  const missingAdapters = requirements.adapters
    .filter((requiredAdapter) => !normalizedAdapters.includes(requiredAdapter));

  return {
    thread: threadInstance,
    requirements,
    missing: {
      capabilities: missingCapabilities,
      skills: missingSkills,
      adapters: missingAdapters,
    },
    matched: missingCapabilities.length === 0 && missingSkills.length === 0 && missingAdapters.length === 0,
  };
}

export function capabilitySatisfied(grantedCapabilities: string[], requiredCapability: string): boolean {
  const normalizedRequired = normalizeToken(requiredCapability);
  if (!normalizedRequired) return true;
  for (const grantedCapability of asStringList(grantedCapabilities)) {
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
  if (primary.startsWith('threads/')) {
    return primary.endsWith('.md') ? primary : `${primary}.md`;
  }
  if (primary.includes('/')) {
    return primary.endsWith('.md') ? primary : `${primary}.md`;
  }
  return `threads/${primary}.md`;
}

function extractTagRequirements(value: unknown, prefix: string): string[] {
  return asStringList(value)
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => tag.slice(prefix.length))
    .filter(Boolean);
}

function extractScopedValues(tokens: string[], prefix: string): string[] {
  return dedupeStrings(tokens
    .filter((token) => token.startsWith(prefix))
    .map((token) => token.slice(prefix.length))
    .filter(Boolean));
}

function asStringList(value: unknown): string[] {
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
  return [...new Set(values.map((value) => normalizeToken(value)).filter(Boolean))];
}

function basenameWithoutExtension(value: string): string {
  const normalized = String(value ?? '').replace(/\\/g, '/');
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  return basename.replace(/\.md$/i, '').trim().toLowerCase();
}

function normalizeToken(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}
