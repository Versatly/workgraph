/**
 * Agent presence primitives.
 */

import path from 'node:path';
import * as auth from './auth.js';
import * as policy from './policy.js';
import * as registry from './registry.js';
import * as store from './store.js';
import { loadServerConfig } from './server-config.js';
import type { FieldDefinition, PolicyParty, PrimitiveInstance } from './types.js';

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
  credential?: auth.AgentCredential;
  apiKey?: string;
}

export interface AgentRegistrationRequestOptions {
  role?: string;
  capabilities?: string[];
  actor?: string;
  note?: string;
}

export interface AgentRegistrationRequestResult {
  agentName: string;
  requestedRolePath: string;
  requestedCapabilities: string[];
  request: PrimitiveInstance;
}

export type AgentRegistrationDecision = 'approved' | 'rejected';

export interface AgentRegistrationReviewOptions {
  role?: string;
  capabilities?: string[];
  scopes?: string[];
  expiresAt?: string;
  note?: string;
}

export interface AgentRegistrationReviewResult {
  request: PrimitiveInstance;
  approval: PrimitiveInstance;
  decision: AgentRegistrationDecision;
  policyParty?: PolicyParty;
  presence?: PrimitiveInstance;
  credential?: auth.AgentCredential;
  apiKey?: string;
}

const PRESENCE_TYPE = 'presence';
const ROLE_TYPE = 'role';
const TRUST_TOKEN_TYPE = 'trust-token';
const REGISTRATION_REQUEST_TYPE = 'agent-registration-request';
const REGISTRATION_APPROVAL_TYPE = 'agent-registration-approval';
const REGISTRATION_REQUESTS_DIR = 'agent-registration-requests';
const REGISTRATION_APPROVALS_DIR = 'agent-registration-approvals';
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
  ensureRegistrationPrimitiveTypes(workspacePath);
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
  if (serverConfig.registration.mode === 'approval' && !serverConfig.registration.allowBootstrapFallback) {
    throw new Error(
      'Bootstrap registration is disabled. Submit a registration request and have it approved (`workgraph agent request/register-review`).',
    );
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
  const expiresAtRaw = readNonEmptyString(trustToken.fields.expires_at);
  if (expiresAtRaw) {
    const expiresAt = Date.parse(expiresAtRaw);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      throw new Error(`Trust token at ${trustTokenPath} has expired.`);
    }
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
  }, {
    actor: options.actor ?? normalizedAgentName,
    skipAuthorization: true,
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

  const issuedCredential = auth.issueAgentCredential(workspacePath, {
    actor: normalizedAgentName,
    scopes: mergedCapabilities,
    issuedBy: options.actor ?? normalizedAgentName,
    note: `bootstrap registration via ${updatedTrustToken.path}`,
  });

  return {
    agentName: normalizedAgentName,
    rolePath: role.path,
    role: roleName,
    capabilities: mergedCapabilities,
    trustTokenPath: updatedTrustToken.path,
    trustTokenStatus: String(updatedTrustToken.fields.status ?? 'active'),
    policyParty,
    presence,
    credential: issuedCredential.credential,
    apiKey: issuedCredential.apiKey,
  };
}

export function submitRegistrationRequest(
  workspacePath: string,
  name: string,
  options: AgentRegistrationRequestOptions = {},
): AgentRegistrationRequestResult {
  ensureRegistrationPrimitiveTypes(workspacePath);
  const serverConfig = loadServerConfig(workspacePath);
  if (!serverConfig) {
    throw new Error('Workspace server config not found. Run `workgraph init` first.');
  }
  if (!serverConfig.registration.enabled) {
    throw new Error('Agent registration is disabled by workspace server config.');
  }

  const agentName = normalizeAgentId(name);
  if (!agentName) {
    throw new Error(`Invalid agent name "${name}".`);
  }
  const requester = normalizeActor(options.actor ?? agentName);
  const requestedRolePath = resolveRolePath(options.role ?? 'roles/contributor');
  const requestedCapabilities = dedupeStrings(normalizeCapabilities(options.capabilities));
  const note = normalizeTask(options.note);
  const now = new Date().toISOString();
  const requestPath = `${REGISTRATION_REQUESTS_DIR}/${agentName}-${Date.now()}.md`;

  const request = store.create(
    workspacePath,
    REGISTRATION_REQUEST_TYPE,
    {
      title: `Agent registration request: ${agentName}`,
      agent_name: agentName,
      requested_role: requestedRolePath,
      requested_capabilities: requestedCapabilities,
      requested_by: requester,
      requested_at: now,
      status: 'pending',
      tags: ['registration', 'request'],
    },
    renderRegistrationRequestBody({
      agentName,
      requestedRolePath,
      requestedCapabilities,
      requestedBy: requester,
      requestedAt: now,
      note,
    }),
    requester,
    {
      pathOverride: requestPath,
      skipAuthorization: true,
      action: 'agent.registration.request',
    },
  );

  return {
    agentName,
    requestedRolePath,
    requestedCapabilities,
    request,
  };
}

export function listRegistrationRequests(
  workspacePath: string,
  status?: 'pending' | 'approved' | 'rejected',
): PrimitiveInstance[] {
  ensureRegistrationPrimitiveTypes(workspacePath);
  const targetStatus = readNonEmptyString(status)?.toLowerCase();
  return store.list(workspacePath, REGISTRATION_REQUEST_TYPE)
    .filter((entry) => {
      if (!targetStatus) return true;
      return String(entry.fields.status ?? '').toLowerCase() === targetStatus;
    })
    .sort((a, b) =>
      String(b.fields.requested_at ?? b.fields.created ?? '').localeCompare(
        String(a.fields.requested_at ?? a.fields.created ?? ''),
      )
    );
}

export function reviewRegistrationRequest(
  workspacePath: string,
  requestRef: string,
  reviewer: string,
  decision: AgentRegistrationDecision,
  options: AgentRegistrationReviewOptions = {},
): AgentRegistrationReviewResult {
  ensureRegistrationPrimitiveTypes(workspacePath);
  const normalizedReviewer = normalizeActor(reviewer);
  if (!normalizedReviewer) {
    throw new Error('Reviewer actor is required.');
  }
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new Error(`Unsupported registration decision "${decision}".`);
  }

  const request = resolveRegistrationRequest(workspacePath, requestRef);
  if (!request) {
    throw new Error(`Registration request not found: ${requestRef}`);
  }
  if (request.type !== REGISTRATION_REQUEST_TYPE) {
    throw new Error(`Expected ${REGISTRATION_REQUEST_TYPE} at ${request.path}, found ${request.type}.`);
  }
  const requestStatus = String(request.fields.status ?? 'pending').toLowerCase();
  if (requestStatus !== 'pending') {
    throw new Error(`Registration request ${request.path} has status "${requestStatus}" and cannot be reviewed.`);
  }
  auth.assertAuthorizedMutation(workspacePath, {
    actor: normalizedReviewer,
    action: 'agent.registration.review',
    target: request.path,
    requiredCapabilities: ['agent:approve-registration', 'agent:register', 'policy:manage'],
    metadata: {
      module: 'agent',
      decision,
    },
  });
  assertRegistrationPolicyApproval(workspacePath, normalizedReviewer);

  const agentName = normalizeAgentId(String(request.fields.agent_name ?? ''));
  if (!agentName) {
    throw new Error(`Registration request ${request.path} has invalid agent_name.`);
  }
  const requestedRolePath = resolveRolePath(
    readNonEmptyString(options.role)
      ?? readNonEmptyString(request.fields.requested_role)
      ?? 'roles/contributor',
  );
  const requestedCapabilities = dedupeStrings([
    ...normalizeCapabilities(request.fields.requested_capabilities),
    ...normalizeCapabilities(options.capabilities),
  ]);
  const reviewNote = normalizeTask(options.note);
  const now = new Date().toISOString();

  let policyParty: PolicyParty | undefined;
  let presence: PrimitiveInstance | undefined;
  let issuedCredential: auth.IssueAgentCredentialResult | undefined;
  let rolePath: string | undefined;
  let approvedCapabilities: string[] | undefined;
  if (decision === 'approved') {
    const role = store.read(workspacePath, requestedRolePath);
    if (!role) {
      throw new Error(`Role primitive not found: ${requestedRolePath}`);
    }
    if (role.type !== ROLE_TYPE) {
      throw new Error(`Expected role primitive at ${requestedRolePath}, found ${role.type}.`);
    }
    rolePath = role.path;
    const roleName = inferRoleName(role.path);
    approvedCapabilities = dedupeStrings([
      ...normalizeCapabilities(role.fields.capabilities),
      ...requestedCapabilities,
    ]);
    policyParty = policy.upsertParty(workspacePath, agentName, {
      roles: [roleName],
      capabilities: approvedCapabilities,
    }, {
      actor: normalizedReviewer,
    });
    presence = heartbeat(workspacePath, agentName, {
      actor: normalizedReviewer,
      status: 'online',
      capabilities: approvedCapabilities,
    });
    const credentialScopes = dedupeStrings(options.scopes ?? approvedCapabilities);
    issuedCredential = auth.issueAgentCredential(workspacePath, {
      actor: agentName,
      scopes: credentialScopes,
      issuedBy: normalizedReviewer,
      expiresAt: options.expiresAt,
      note: `registration approval ${request.path}`,
    });
  }

  const approval = store.create(
    workspacePath,
    REGISTRATION_APPROVAL_TYPE,
    {
      title: `Registration ${decision}: ${agentName}`,
      request_ref: request.path,
      agent_name: agentName,
      decision,
      reviewer: normalizedReviewer,
      reviewed_at: now,
      role: rolePath,
      granted_capabilities: approvedCapabilities ?? [],
      granted_scopes: issuedCredential?.credential.scopes ?? [],
      credential_id: issuedCredential?.credential.id,
      reason: reviewNote,
      tags: ['registration', 'approval', decision],
    },
    renderRegistrationApprovalBody({
      agentName,
      decision,
      reviewer: normalizedReviewer,
      reviewedAt: now,
      rolePath,
      approvedCapabilities: approvedCapabilities ?? [],
      scopes: issuedCredential?.credential.scopes ?? [],
      note: reviewNote,
    }),
    normalizedReviewer,
    {
      pathOverride: `${REGISTRATION_APPROVALS_DIR}/${agentName}-${decision}-${Date.now()}.md`,
      action: 'agent.registration.approval.create',
    },
  );

  const updatedRequest = store.update(
    workspacePath,
    request.path,
    {
      status: decision,
      reviewed_by: normalizedReviewer,
      reviewed_at: now,
      decision_reason: reviewNote,
      approval_ref: approval.path,
      approved_role: rolePath,
      approved_capabilities: approvedCapabilities,
      approved_scopes: issuedCredential?.credential.scopes,
      credential_id: issuedCredential?.credential.id,
    },
    appendReviewSection(request.body, {
      decision,
      reviewer: normalizedReviewer,
      reviewedAt: now,
      note: reviewNote,
      approvalPath: approval.path,
    }),
    normalizedReviewer,
    {
      action: 'agent.registration.request.review',
    },
  );

  return {
    request: updatedRequest,
    approval,
    decision,
    ...(policyParty ? { policyParty } : {}),
    ...(presence ? { presence } : {}),
    ...(issuedCredential
      ? {
          credential: issuedCredential.credential,
          apiKey: issuedCredential.apiKey,
        }
      : {}),
  };
}

export function revokeAgentCredential(
  workspacePath: string,
  credentialId: string,
  actor: string,
  reason?: string,
): auth.AgentCredential {
  const normalizedActor = normalizeActor(actor);
  if (!normalizedActor) {
    throw new Error('Actor is required to revoke a credential.');
  }
  auth.assertAuthorizedMutation(workspacePath, {
    actor: normalizedActor,
    action: 'agent.credential.revoke',
    target: `.workgraph/auth/credentials/${credentialId}`,
    requiredCapabilities: ['agent:register', 'policy:manage'],
    metadata: {
      module: 'agent',
    },
  });
  return auth.revokeAgentCredential(workspacePath, credentialId, normalizedActor, reason);
}

export function listAgentCredentials(
  workspacePath: string,
  actorFilter?: string,
): auth.AgentCredential[] {
  return auth.listAgentCredentials(workspacePath, actorFilter);
}

function ensureRegistrationPrimitiveTypes(workspacePath: string): void {
  ensureType(
    workspacePath,
    REGISTRATION_REQUEST_TYPE,
    'Agent registration request pending governance approval.',
    REGISTRATION_REQUESTS_DIR,
    {
      agent_name: { type: 'string', required: true },
      requested_role: { type: 'string', required: true },
      requested_capabilities: { type: 'list', default: [] },
      requested_by: { type: 'string', required: true },
      requested_at: { type: 'date', required: true },
      status: {
        type: 'string',
        required: true,
        default: 'pending',
        enum: ['pending', 'approved', 'rejected'],
      },
      reviewed_by: { type: 'string' },
      reviewed_at: { type: 'date' },
      decision_reason: { type: 'string' },
      approval_ref: { type: 'ref', refTypes: [REGISTRATION_APPROVAL_TYPE] },
      approved_role: { type: 'string' },
      approved_capabilities: { type: 'list', default: [] },
      approved_scopes: { type: 'list', default: [] },
      credential_id: { type: 'string' },
    },
  );

  ensureType(
    workspacePath,
    REGISTRATION_APPROVAL_TYPE,
    'Approval/rejection record for an agent registration request.',
    REGISTRATION_APPROVALS_DIR,
    {
      request_ref: { type: 'ref', refTypes: [REGISTRATION_REQUEST_TYPE], required: true },
      agent_name: { type: 'string', required: true },
      decision: {
        type: 'string',
        required: true,
        enum: ['approved', 'rejected'],
      },
      reviewer: { type: 'string', required: true },
      reviewed_at: { type: 'date', required: true },
      role: { type: 'string' },
      granted_capabilities: { type: 'list', default: [] },
      granted_scopes: { type: 'list', default: [] },
      credential_id: { type: 'string' },
      reason: { type: 'string' },
    },
  );
}

function ensureType(
  workspacePath: string,
  typeName: string,
  description: string,
  directory: string,
  fields: Record<string, FieldDefinition>,
): void {
  if (registry.getType(workspacePath, typeName)) return;
  registry.defineType(workspacePath, typeName, description, fields, 'system', directory);
}

function resolveRegistrationRequest(
  workspacePath: string,
  requestRef: string,
): PrimitiveInstance | null {
  const normalizedRef = normalizePathLike(requestRef);
  if (normalizedRef.includes('/')) {
    return store.read(workspacePath, normalizedRef);
  }
  const normalizedSlug = normalizedRef.endsWith('.md')
    ? normalizedRef.slice(0, -3)
    : normalizedRef;
  const candidates = store.list(workspacePath, REGISTRATION_REQUEST_TYPE);
  const byPath = candidates.find((entry) => path.basename(entry.path, '.md') === normalizedSlug);
  if (byPath) return byPath;
  return candidates.find((entry) =>
    normalizeAgentId(entry.fields.agent_name) === normalizeAgentId(normalizedSlug)
  ) ?? null;
}

function renderRegistrationRequestBody(input: {
  agentName: string;
  requestedRolePath: string;
  requestedCapabilities: string[];
  requestedBy: string;
  requestedAt: string;
  note: string | null;
}): string {
  const lines = [
    '## Registration Request',
    '',
    `- agent: ${input.agentName}`,
    `- requested_role: ${input.requestedRolePath}`,
    `- requested_by: ${input.requestedBy}`,
    `- requested_at: ${input.requestedAt}`,
    '',
    '## Requested Capabilities',
    '',
    ...(input.requestedCapabilities.length > 0
      ? input.requestedCapabilities.map((capability) => `- ${capability}`)
      : ['- none']),
    '',
  ];
  if (input.note) {
    lines.push('## Note');
    lines.push('');
    lines.push(input.note);
    lines.push('');
  }
  return lines.join('\n');
}

function renderRegistrationApprovalBody(input: {
  agentName: string;
  decision: AgentRegistrationDecision;
  reviewer: string;
  reviewedAt: string;
  rolePath?: string;
  approvedCapabilities: string[];
  scopes: string[];
  note: string | null;
}): string {
  const lines = [
    '## Registration Review',
    '',
    `- agent: ${input.agentName}`,
    `- decision: ${input.decision}`,
    `- reviewer: ${input.reviewer}`,
    `- reviewed_at: ${input.reviewedAt}`,
    `- role: ${input.rolePath ?? 'n/a'}`,
    '',
    '## Granted Capabilities',
    '',
    ...(input.approvedCapabilities.length > 0
      ? input.approvedCapabilities.map((capability) => `- ${capability}`)
      : ['- none']),
    '',
    '## Granted Scopes',
    '',
    ...(input.scopes.length > 0
      ? input.scopes.map((scope) => `- ${scope}`)
      : ['- none']),
    '',
  ];
  if (input.note) {
    lines.push('## Review Note');
    lines.push('');
    lines.push(input.note);
    lines.push('');
  }
  return lines.join('\n');
}

function appendReviewSection(
  existingBody: string,
  input: {
    decision: AgentRegistrationDecision;
    reviewer: string;
    reviewedAt: string;
    note: string | null;
    approvalPath: string;
  },
): string {
  const lines = [
    existingBody.trimEnd(),
    '',
    '## Review Decision',
    '',
    `- decision: ${input.decision}`,
    `- reviewer: ${input.reviewer}`,
    `- reviewed_at: ${input.reviewedAt}`,
    `- approval: [[${input.approvalPath}]]`,
    ...(input.note ? [`- note: ${input.note}`] : []),
    '',
  ];
  return lines.join('\n');
}

function assertRegistrationPolicyApproval(workspacePath: string, reviewer: string): void {
  const registrationPolicy = store.read(workspacePath, 'policies/registration-approval.md');
  if (!registrationPolicy || registrationPolicy.type !== 'policy') return;
  const policyStatus = String(registrationPolicy.fields.status ?? 'active').toLowerCase();
  if (policyStatus !== 'active' && policyStatus !== 'approved') return;
  const approverRefs = asStringList(registrationPolicy.fields.approvers);
  if (approverRefs.length === 0) return;

  const reviewerParty = policy.getParty(workspacePath, reviewer);
  if (!reviewerParty) {
    throw new Error(
      `Registration approval policy requires reviewer "${reviewer}" to be a registered policy party.`,
    );
  }
  const allowedRoles = new Set(
    approverRefs
      .map((ref) => inferRoleName(resolveRolePath(ref)))
      .filter(Boolean),
  );
  const reviewerRoles = new Set(reviewerParty.roles.map((role) => normalizeActor(role)));
  const isAllowed = [...allowedRoles].some((role) => reviewerRoles.has(normalizeActor(role)));
  if (!isAllowed) {
    throw new Error(
      `Registration approval policy blocked reviewer "${reviewer}". Required one of roles [${[...allowedRoles].join(', ')}].`,
    );
  }
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

function normalizeActor(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
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
