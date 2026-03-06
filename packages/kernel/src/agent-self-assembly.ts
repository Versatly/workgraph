/**
 * Agent self-assembly orchestration.
 *
 * Flow:
 * 1) Optional bootstrap registration.
 * 2) Authenticate actor identity/governance context.
 * 3) Advertise capabilities + refresh presence heartbeat.
 * 4) Discover workspace orientation + claimable threads.
 * 5) Capability-match and claim a thread.
 * 6) Begin plan-step execution for the claimed thread.
 */

import * as auth from './auth.js';
import * as agent from './agent.js';
import * as conversation from './conversation.js';
import * as dispatch from './dispatch.js';
import * as orientation from './orientation.js';
import * as policy from './policy.js';
import * as store from './store.js';
import * as thread from './thread.js';
import type { PrimitiveInstance, WorkgraphBrief, WorkgraphStatusSnapshot } from './types.js';

const REQUIREMENT_TAG_PREFIXES = {
  capability: 'requires:capability:',
  skill: 'requires:skill:',
  adapter: 'requires:adapter:',
} as const;

export interface AgentCapabilityAdvertisement {
  capabilities?: string[];
  skills?: string[];
  adapters?: string[];
}

export interface AgentCapabilityProfile {
  agentName: string;
  capabilities: string[];
  skills: string[];
  adapters: string[];
  advertisedCapabilityTokens: string[];
}

export interface ThreadCapabilityRequirements {
  capabilities: string[];
  skills: string[];
  adapters: string[];
}

export interface ThreadCapabilityMatch {
  thread: PrimitiveInstance;
  requirements: ThreadCapabilityRequirements;
  missing: ThreadCapabilityRequirements;
  matched: boolean;
}

export interface AgentSelfAssemblyOptions {
  credentialToken?: string;
  bootstrapToken?: string;
  role?: string;
  registerActor?: string;
  recoverStaleClaims?: boolean;
  recoveryActor?: string;
  recoveryLimit?: number;
  recoveryRequired?: boolean;
  spaceRef?: string;
  leaseTtlMinutes?: number;
  advertise?: AgentCapabilityAdvertisement;
  createPlanStepIfMissing?: boolean;
}

export interface AgentSelfAssemblyResult {
  agentName: string;
  authenticated: boolean;
  identityVerified: boolean;
  registration?: agent.AgentRegistrationResult;
  presence?: PrimitiveInstance;
  capabilityProfile: AgentCapabilityProfile;
  status: WorkgraphStatusSnapshot;
  brief: WorkgraphBrief;
  candidates: ThreadCapabilityMatch[];
  claimedThread?: PrimitiveInstance;
  planStep?: PrimitiveInstance;
  conversationPath?: string;
  recovery?: thread.ReapStaleClaimsResult;
  warnings: string[];
}

export function assembleAgent(
  workspacePath: string,
  agentName: string,
  options: AgentSelfAssemblyOptions = {},
): AgentSelfAssemblyResult {
  const normalizedAgent = normalizeActorId(agentName);
  if (!normalizedAgent) {
    throw new Error(`Invalid agent name "${agentName}".`);
  }

  const warnings: string[] = [];
  const registration = maybeBootstrapRegister(workspacePath, normalizedAgent, options);
  const effectiveCredential = readOptionalString(options.credentialToken) ?? registration?.apiKey;

  return withCredentialContext(effectiveCredential, () => {
    const decision = auth.authorizeMutation(workspacePath, {
      actor: normalizedAgent,
      action: 'agent.self-assembly',
      target: '.workgraph/self-assembly',
      requiredCapabilities: ['thread:claim', 'thread:manage', 'dispatch:run'],
    });
    if (!decision.allowed) {
      throw new Error(decision.reason ?? `Self-assembly denied for "${normalizedAgent}".`);
    }

    const capabilityProfile = buildCapabilityProfile(workspacePath, normalizedAgent, options, registration);
    const presence = advertisePresence(workspacePath, normalizedAgent, capabilityProfile, warnings);
    const recovery = maybeRecoverStaleClaims(workspacePath, normalizedAgent, options, warnings);
    const status = orientation.statusSnapshot(workspacePath);
    const brief = orientation.brief(workspacePath, normalizedAgent, { nextCount: 10, recentCount: 20 });

    const readyThreads = options.spaceRef
      ? thread.listReadyThreadsInSpace(workspacePath, options.spaceRef)
      : thread.listReadyThreads(workspacePath);
    const candidates = readyThreads.map((readyThread) => matchThreadToAgent(readyThread, capabilityProfile));
    const matchedCandidates = candidates.filter((candidate) => candidate.matched);

    const claimedThread = claimFirstMatchedThread(
      workspacePath,
      normalizedAgent,
      matchedCandidates,
      options.leaseTtlMinutes,
      warnings,
    );
    const stepStart = claimedThread
      ? beginPlanStepExecution(workspacePath, claimedThread, normalizedAgent, options)
      : undefined;

    return {
      agentName: normalizedAgent,
      authenticated: true,
      identityVerified: decision.identityVerified,
      ...(registration ? { registration } : {}),
      ...(presence ? { presence } : {}),
      capabilityProfile,
      status,
      brief,
      candidates,
      ...(claimedThread ? { claimedThread } : {}),
      ...(stepStart?.planStep ? { planStep: stepStart.planStep } : {}),
      ...(stepStart?.conversationPath ? { conversationPath: stepStart.conversationPath } : {}),
      ...(recovery ? { recovery } : {}),
      warnings,
    };
  });
}

export function matchThreadToAgent(
  threadInstance: PrimitiveInstance,
  capabilityProfile: AgentCapabilityProfile,
): ThreadCapabilityMatch {
  const requirements = readThreadCapabilityRequirements(threadInstance);
  const missingCapabilities = requirements.capabilities
    .filter((requiredCapability) => !capabilitySatisfied(capabilityProfile.capabilities, requiredCapability));
  const missingSkills = requirements.skills
    .filter((requiredSkill) => !capabilityProfile.skills.includes(requiredSkill));
  const missingAdapters = requirements.adapters
    .filter((requiredAdapter) => !capabilityProfile.adapters.includes(requiredAdapter));

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

function maybeBootstrapRegister(
  workspacePath: string,
  agentName: string,
  options: AgentSelfAssemblyOptions,
): agent.AgentRegistrationResult | undefined {
  const bootstrapToken = readOptionalString(options.bootstrapToken);
  if (!bootstrapToken) return undefined;
  return agent.registerAgent(workspacePath, agentName, {
    token: bootstrapToken,
    ...(options.role ? { role: options.role } : {}),
    ...(options.advertise?.capabilities ? { capabilities: options.advertise.capabilities } : {}),
    actor: readOptionalString(options.registerActor) ?? agentName,
  });
}

function buildCapabilityProfile(
  workspacePath: string,
  agentName: string,
  options: AgentSelfAssemblyOptions,
  registration: agent.AgentRegistrationResult | undefined,
): AgentCapabilityProfile {
  const existingPresence = agent.getPresence(workspacePath, agentName);
  const policyParty = policy.getParty(workspacePath, agentName);
  const advertised = options.advertise ?? {};

  const mergedCapabilities = dedupeStrings([
    ...asStringList(existingPresence?.fields.capabilities),
    ...(registration?.capabilities ?? []),
    ...(policyParty?.capabilities ?? []),
    ...asStringList(advertised.capabilities),
  ]);
  const mergedSkills = dedupeStrings([
    ...extractScopedValues(mergedCapabilities, 'skill:'),
    ...asStringList(advertised.skills),
  ]);
  const mergedAdapters = dedupeStrings([
    ...extractScopedValues(mergedCapabilities, 'adapter:'),
    ...asStringList(advertised.adapters),
  ]);
  const advertisedCapabilityTokens = dedupeStrings([
    ...mergedCapabilities,
    ...mergedSkills.map((skillName) => `skill:${skillName}`),
    ...mergedAdapters.map((adapterName) => `adapter:${adapterName}`),
  ]);

  return {
    agentName,
    capabilities: mergedCapabilities,
    skills: mergedSkills,
    adapters: mergedAdapters,
    advertisedCapabilityTokens,
  };
}

function advertisePresence(
  workspacePath: string,
  agentName: string,
  capabilityProfile: AgentCapabilityProfile,
  warnings: string[],
): PrimitiveInstance | undefined {
  try {
    return agent.heartbeat(workspacePath, agentName, {
      actor: agentName,
      status: 'online',
      capabilities: capabilityProfile.advertisedCapabilityTokens,
    });
  } catch (error) {
    warnings.push(`Presence advertisement failed: ${errorMessage(error)}`);
    return undefined;
  }
}

function maybeRecoverStaleClaims(
  workspacePath: string,
  agentName: string,
  options: AgentSelfAssemblyOptions,
  warnings: string[],
): thread.ReapStaleClaimsResult | undefined {
  if (options.recoverStaleClaims === false) return undefined;
  const recoveryActor = readOptionalString(options.recoveryActor) ?? agentName;
  try {
    return thread.reapStaleClaims(workspacePath, recoveryActor, {
      ...(typeof options.recoveryLimit === 'number' ? { limit: options.recoveryLimit } : {}),
    });
  } catch (error) {
    if (options.recoveryRequired) {
      throw error;
    }
    warnings.push(`Stale-claim recovery skipped: ${errorMessage(error)}`);
    return undefined;
  }
}

function claimFirstMatchedThread(
  workspacePath: string,
  actor: string,
  candidates: ThreadCapabilityMatch[],
  leaseTtlMinutes: number | undefined,
  warnings: string[],
): PrimitiveInstance | undefined {
  for (const candidate of candidates) {
    try {
      const claimed = dispatch.claimThread(workspacePath, candidate.thread.path, actor).thread;
      if (typeof leaseTtlMinutes === 'number') {
        thread.heartbeatClaim(workspacePath, actor, claimed.path, { ttlMinutes: leaseTtlMinutes });
      }
      return claimed;
    } catch (error) {
      warnings.push(`Claim failed for ${candidate.thread.path}: ${errorMessage(error)}`);
    }
  }
  return undefined;
}

function beginPlanStepExecution(
  workspacePath: string,
  claimedThread: PrimitiveInstance,
  actor: string,
  options: AgentSelfAssemblyOptions,
): { planStep?: PrimitiveInstance; conversationPath?: string } {
  const createPlanStepIfMissing = options.createPlanStepIfMissing !== false;
  let conversationPath: string | undefined = findConversationForThread(workspacePath, claimedThread.path);

  if (!conversationPath && createPlanStepIfMissing) {
    const createdConversation = conversation.createConversation(
      workspacePath,
      `Execution: ${String(claimedThread.fields.title ?? claimedThread.path)}`,
      actor,
      {
        threadRefs: [claimedThread.path],
      },
    );
    conversationPath = createdConversation.conversation.path;
  }

  let selectedStep = findPlanStepForExecution(workspacePath, claimedThread.path, actor);
  if (!selectedStep && createPlanStepIfMissing && conversationPath) {
    selectedStep = conversation.createPlanStep(
      workspacePath,
      `Execute ${String(claimedThread.fields.title ?? claimedThread.path)}`,
      actor,
      {
        conversationRef: conversationPath,
        threadRef: claimedThread.path,
        assignee: actor,
      },
    );
  }

  if (selectedStep && !readOptionalString(selectedStep.fields.assignee)) {
    selectedStep = store.update(
      workspacePath,
      selectedStep.path,
      { assignee: actor },
      undefined,
      actor,
    );
  }

  if (selectedStep && String(selectedStep.fields.status ?? '').toLowerCase() !== 'active') {
    selectedStep = conversation.updatePlanStepStatus(
      workspacePath,
      selectedStep.path,
      'active',
      actor,
    );
  }

  if (conversationPath) {
    conversation.appendConversationMessage(
      workspacePath,
      conversationPath,
      actor,
      `Self-assembly claimed ${claimedThread.path} and started execution.`,
      {
        kind: 'system',
        eventType: 'self-assembly',
        threadRef: claimedThread.path,
      },
    );
  }

  return {
    ...(selectedStep ? { planStep: selectedStep } : {}),
    ...(conversationPath ? { conversationPath } : {}),
  };
}

function findConversationForThread(workspacePath: string, threadPath: string): string | undefined {
  const conversations = conversation.listConversations(workspacePath, { threadRef: threadPath });
  return conversations[0]?.conversation.path;
}

function findPlanStepForExecution(
  workspacePath: string,
  threadPath: string,
  actor: string,
): PrimitiveInstance | undefined {
  const candidates = conversation.listPlanSteps(workspacePath, { threadRef: threadPath });
  return candidates.find((step) => {
    const status = String(step.fields.status ?? '').trim().toLowerCase();
    if (status !== 'open' && status !== 'active') return false;
    const assignee = readOptionalString(step.fields.assignee);
    return !assignee || assignee === actor;
  });
}

function readThreadCapabilityRequirements(threadInstance: PrimitiveInstance): ThreadCapabilityRequirements {
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

function extractTagRequirements(value: unknown, prefix: string): string[] {
  return asStringList(value)
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => tag.slice(prefix.length))
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

function withCredentialContext<T>(credentialToken: string | undefined, fn: () => T): T {
  const token = readOptionalString(credentialToken);
  if (!token) return fn();
  return auth.runWithAuthContext({ credentialToken: token, source: 'internal' }, fn);
}

function normalizeActorId(value: unknown): string {
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

function extractScopedValues(tokens: string[], prefix: string): string[] {
  return tokens
    .filter((token) => token.startsWith(prefix))
    .map((token) => token.slice(prefix.length))
    .filter(Boolean);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
