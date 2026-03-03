import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as ledger from './ledger.js';
import { loadServerConfig, type WorkgraphAuthMode } from './server-config.js';

const CREDENTIAL_STORE_FILE = '.workgraph/auth/credentials.json';
const CREDENTIAL_STORE_VERSION = 1;
const API_KEY_PREFIX = 'wgk_';
const POLICY_FILE = '.workgraph/policy.json';

interface CredentialStore {
  version: number;
  credentials: StoredCredential[];
}

type CredentialStatus = 'active' | 'revoked';

interface StoredCredential {
  id: string;
  actor: string;
  scopes: string[];
  status: CredentialStatus;
  issuedAt: string;
  issuedBy: string;
  expiresAt?: string;
  revokedAt?: string;
  revokedBy?: string;
  note?: string;
  lastUsedAt?: string;
  secretSalt: string;
  secretHash: string;
}

interface PolicyRegistrySnapshot {
  version: number;
  parties: Record<string, {
    id: string;
    roles?: unknown;
    capabilities?: unknown;
  }>;
}

export interface AgentCredential {
  id: string;
  actor: string;
  scopes: string[];
  status: CredentialStatus;
  issuedAt: string;
  issuedBy: string;
  expiresAt?: string;
  revokedAt?: string;
  revokedBy?: string;
  note?: string;
  lastUsedAt?: string;
}

export interface IssueAgentCredentialInput {
  actor: string;
  scopes: string[];
  issuedBy: string;
  expiresAt?: string;
  note?: string;
}

export interface IssueAgentCredentialResult {
  apiKey: string;
  credential: AgentCredential;
}

export interface VerifyAgentCredentialOptions {
  touchLastUsed?: boolean;
}

export interface VerifyAgentCredentialResult {
  valid: boolean;
  reason?: string;
  looksLikeCredential: boolean;
  credential?: AgentCredential;
}

export interface WorkgraphAuthContext {
  credentialToken?: string;
  source?: 'cli' | 'mcp' | 'rest' | 'internal';
}

export interface MutationAuthorizationInput {
  actor: string;
  action: string;
  target?: string;
  requiredCapabilities?: string[];
  requiredScopes?: string[];
  allowUnauthenticatedFallback?: boolean;
  allowSystemActor?: boolean;
  metadata?: Record<string, unknown>;
}

export interface MutationAuthorizationDecision {
  allowed: boolean;
  actor: string;
  action: string;
  mode: WorkgraphAuthMode;
  reason?: string;
  credentialId?: string;
  identityVerified: boolean;
  usedFallback: boolean;
}

const AUTH_CONTEXT = new AsyncLocalStorage<WorkgraphAuthContext>();

export function runWithAuthContext<T>(
  context: WorkgraphAuthContext,
  fn: () => T,
): T {
  return AUTH_CONTEXT.run(sanitizeAuthContext(context), fn);
}

export function getAuthContext(): WorkgraphAuthContext | null {
  return AUTH_CONTEXT.getStore() ?? null;
}

export function issueAgentCredential(
  workspacePath: string,
  input: IssueAgentCredentialInput,
): IssueAgentCredentialResult {
  const actor = normalizeActor(input.actor);
  const issuedBy = normalizeActor(input.issuedBy);
  if (!actor) {
    throw new Error('Cannot issue credential: actor is required.');
  }
  if (!issuedBy) {
    throw new Error('Cannot issue credential: issuedBy is required.');
  }

  const scopes = dedupeStrings(input.scopes);
  if (scopes.length === 0) {
    throw new Error('Cannot issue credential: at least one scope is required.');
  }
  const expiresAt = normalizeOptionalIsoDate(input.expiresAt);
  const note = normalizeOptionalText(input.note);
  const now = new Date().toISOString();

  const credentialId = randomBytes(12).toString('hex');
  const secret = randomBytes(24).toString('hex');
  const secretSalt = randomBytes(16).toString('hex');
  const secretHash = hashCredentialSecret(secretSalt, secret);

  const store = loadCredentialStore(workspacePath);
  const credential: StoredCredential = {
    id: credentialId,
    actor,
    scopes,
    status: 'active',
    issuedAt: now,
    issuedBy,
    ...(expiresAt ? { expiresAt } : {}),
    ...(note ? { note } : {}),
    secretSalt,
    secretHash,
  };
  store.credentials.push(credential);
  saveCredentialStore(workspacePath, store);

  ledger.append(workspacePath, issuedBy, 'create', credentialLedgerTarget(credentialId), 'credential', {
    credential_id: credentialId,
    actor,
    scopes,
    ...(expiresAt ? { expires_at: expiresAt } : {}),
  });

  return {
    apiKey: `${API_KEY_PREFIX}${credentialId}.${secret}`,
    credential: toAgentCredential(credential),
  };
}

export function revokeAgentCredential(
  workspacePath: string,
  credentialId: string,
  revokedBy: string,
  reason?: string,
): AgentCredential {
  const normalizedId = normalizeCredentialId(credentialId);
  const actor = normalizeActor(revokedBy);
  if (!normalizedId) {
    throw new Error('Credential id is required.');
  }
  if (!actor) {
    throw new Error('revokedBy actor is required.');
  }

  const store = loadCredentialStore(workspacePath);
  const credential = store.credentials.find((entry) => entry.id === normalizedId);
  if (!credential) {
    throw new Error(`Credential not found: ${normalizedId}`);
  }
  if (credential.status === 'revoked') {
    return toAgentCredential(credential);
  }

  const now = new Date().toISOString();
  credential.status = 'revoked';
  credential.revokedAt = now;
  credential.revokedBy = actor;
  const normalizedReason = normalizeOptionalText(reason);
  if (normalizedReason) {
    credential.note = credential.note
      ? `${credential.note}\nrevocation_reason=${normalizedReason}`
      : `revocation_reason=${normalizedReason}`;
  }
  saveCredentialStore(workspacePath, store);

  ledger.append(workspacePath, actor, 'update', credentialLedgerTarget(normalizedId), 'credential', {
    credential_id: normalizedId,
    status: 'revoked',
    ...(normalizedReason ? { reason: normalizedReason } : {}),
  });

  return toAgentCredential(credential);
}

export function listAgentCredentials(
  workspacePath: string,
  actor?: string,
): AgentCredential[] {
  const store = loadCredentialStore(workspacePath);
  const actorFilter = normalizeActor(actor);
  return store.credentials
    .filter((credential) => !actorFilter || credential.actor === actorFilter)
    .map((credential) => toAgentCredential(credential));
}

export function verifyAgentCredential(
  workspacePath: string,
  apiKey: string | undefined,
  options: VerifyAgentCredentialOptions = {},
): VerifyAgentCredentialResult {
  const parsed = parseCredentialToken(apiKey);
  if (!parsed) {
    return {
      valid: false,
      reason: 'Credential token is missing.',
      looksLikeCredential: false,
    };
  }
  if (!parsed.looksLikeCredential) {
    return {
      valid: false,
      reason: 'Token is not a WorkGraph credential token.',
      looksLikeCredential: false,
    };
  }
  if (!parsed.id || !parsed.secret) {
    return {
      valid: false,
      reason: 'Credential token format is invalid.',
      looksLikeCredential: true,
    };
  }

  const store = loadCredentialStore(workspacePath);
  const credential = store.credentials.find((entry) => entry.id === parsed.id);
  if (!credential) {
    return {
      valid: false,
      reason: 'Credential not found.',
      looksLikeCredential: true,
    };
  }

  const expected = hashCredentialSecret(credential.secretSalt, parsed.secret);
  const expectedBuffer = Buffer.from(expected, 'utf-8');
  const actualBuffer = Buffer.from(credential.secretHash, 'utf-8');
  if (
    expectedBuffer.length !== actualBuffer.length ||
    !timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    return {
      valid: false,
      reason: 'Credential secret mismatch.',
      looksLikeCredential: true,
    };
  }

  if (credential.status !== 'active') {
    return {
      valid: false,
      reason: `Credential is ${credential.status}.`,
      looksLikeCredential: true,
    };
  }
  if (credential.expiresAt) {
    const expiresAtMs = Date.parse(credential.expiresAt);
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
      return {
        valid: false,
        reason: 'Credential has expired.',
        looksLikeCredential: true,
      };
    }
  }

  if (options.touchLastUsed !== false) {
    credential.lastUsedAt = new Date().toISOString();
    saveCredentialStore(workspacePath, store);
  }

  return {
    valid: true,
    looksLikeCredential: true,
    credential: toAgentCredential(credential),
  };
}

export function authorizeMutation(
  workspacePath: string,
  input: MutationAuthorizationInput,
): MutationAuthorizationDecision {
  const actor = normalizeActor(input.actor);
  const action = normalizeAction(input.action);
  const target = normalizeOptionalText(input.target);
  const mode = resolveAuthMode(workspacePath);
  const requiredCapabilities = dedupeStrings(input.requiredCapabilities);
  const requiredScopes = dedupeStrings(input.requiredScopes ?? requiredCapabilities);
  const allowFallback = resolveAllowFallback(workspacePath, input.allowUnauthenticatedFallback);
  const token = resolveCredentialToken(input);
  const tokenProvided = !!token;
  const verification = tokenProvided
    ? verifyAgentCredential(workspacePath, token, { touchLastUsed: true })
    : null;
  const verifiedCredential = verification?.valid ? verification.credential : undefined;

  const deny = (reason: string): MutationAuthorizationDecision =>
    finalizeDecision(workspacePath, {
      allowed: false,
      actor,
      action,
      mode,
      reason,
      identityVerified: !!verifiedCredential,
      usedFallback: false,
      ...(verifiedCredential ? { credentialId: verifiedCredential.id } : {}),
    }, target, requiredCapabilities, requiredScopes, input.metadata);

  if (!actor) {
    return deny('Mutation blocked: actor is required.');
  }
  if (!action) {
    return deny('Mutation blocked: action is required.');
  }
  if (input.allowSystemActor && actor === 'system') {
    return finalizeDecision(workspacePath, {
      allowed: true,
      actor,
      action,
      mode,
      identityVerified: true,
      usedFallback: false,
    }, target, requiredCapabilities, requiredScopes, input.metadata);
  }

  if (verification && !verification.valid && verification.looksLikeCredential) {
    return deny(`Identity verification failed: ${verification.reason ?? 'invalid credential.'}`);
  }

  if (mode === 'strict' && !verifiedCredential) {
    return deny('Identity verification failed: strict auth mode requires a valid credential.');
  }

  if (verifiedCredential && verifiedCredential.actor !== actor) {
    return deny(
      `Identity verification failed: credential actor "${verifiedCredential.actor}" does not match claimed actor "${actor}".`,
    );
  }

  const party = getPolicyParty(workspacePath, actor);
  const modeAllowsLegacyFallback = (mode === 'legacy' || mode === 'hybrid') && allowFallback;
  const mayUseFallback = modeAllowsLegacyFallback && !verifiedCredential;

  if (!party && !mayUseFallback) {
    return deny(`Policy gate blocked mutation: actor "${actor}" is not a registered party.`);
  }

  if (party && requiredCapabilities.length > 0) {
    const hasRequiredCapability = requiredCapabilities.some((capability) =>
      capabilitySatisfied(party.capabilities, capability)
    );
    if (!hasRequiredCapability && !mayUseFallback) {
      return deny(
        `Policy gate blocked mutation: actor "${actor}" lacks required capability. Required any of [${requiredCapabilities.join(', ')}].`,
      );
    }
  }

  if (verifiedCredential && requiredScopes.length > 0) {
    const hasRequiredScope = requiredScopes.some((scope) =>
      capabilitySatisfied(verifiedCredential.scopes, scope)
    );
    if (!hasRequiredScope) {
      return deny(
        `Credential scope blocked mutation: credential "${verifiedCredential.id}" lacks required scope. Required any of [${requiredScopes.join(', ')}].`,
      );
    }
  }

  return finalizeDecision(workspacePath, {
    allowed: true,
    actor,
    action,
    mode,
    identityVerified: !!verifiedCredential,
    usedFallback: mayUseFallback,
    ...(verifiedCredential ? { credentialId: verifiedCredential.id } : {}),
  }, target, requiredCapabilities, requiredScopes, input.metadata);
}

export function assertAuthorizedMutation(
  workspacePath: string,
  input: MutationAuthorizationInput,
): void {
  const decision = authorizeMutation(workspacePath, input);
  if (!decision.allowed) {
    throw new Error(decision.reason ?? `Mutation "${decision.action}" denied for actor "${decision.actor}".`);
  }
}

function finalizeDecision(
  workspacePath: string,
  decision: MutationAuthorizationDecision,
  target: string | undefined,
  requiredCapabilities: string[],
  requiredScopes: string[],
  metadata: Record<string, unknown> | undefined,
): MutationAuthorizationDecision {
  const context = getAuthContext();
  // Preserve backward-compatible ledger behavior during legacy/hybrid fallback mode.
  // Permission decisions are always audited when identity is cryptographically verified
  // or when authorization is denied.
  const shouldAuditDecision = decision.identityVerified || !decision.allowed;
  if (shouldAuditDecision) {
    const auditTarget = target ?? `.workgraph/authz/${decision.action}`;
    ledger.append(workspacePath, decision.actor || 'anonymous', 'authorize', auditTarget, 'authorization', {
      action: decision.action,
      mode: decision.mode,
      allowed: decision.allowed,
      ...(decision.reason ? { reason: decision.reason } : {}),
      ...(decision.credentialId ? { credential_id: decision.credentialId } : {}),
      identity_verified: decision.identityVerified,
      used_fallback: decision.usedFallback,
      required_capabilities: requiredCapabilities,
      required_scopes: requiredScopes,
      ...(context?.source ? { source: context.source } : {}),
      ...(metadata ? { metadata } : {}),
    });
  }
  return decision;
}

function loadCredentialStore(workspacePath: string): CredentialStore {
  const cPath = credentialStorePath(workspacePath);
  if (!fs.existsSync(cPath)) {
    return {
      version: CREDENTIAL_STORE_VERSION,
      credentials: [],
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(cPath, 'utf-8')) as CredentialStore;
    if (!Array.isArray(parsed.credentials)) {
      throw new Error('Invalid credential store shape.');
    }
    return {
      version: CREDENTIAL_STORE_VERSION,
      credentials: parsed.credentials
        .map((entry) => sanitizeStoredCredential(entry))
        .filter((entry): entry is StoredCredential => !!entry),
    };
  } catch {
    return {
      version: CREDENTIAL_STORE_VERSION,
      credentials: [],
    };
  }
}

function saveCredentialStore(workspacePath: string, store: CredentialStore): void {
  const cPath = credentialStorePath(workspacePath);
  const dir = path.dirname(cPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const serialized: CredentialStore = {
    version: CREDENTIAL_STORE_VERSION,
    credentials: store.credentials.map((credential) => ({
      id: credential.id,
      actor: credential.actor,
      scopes: credential.scopes,
      status: credential.status,
      issuedAt: credential.issuedAt,
      issuedBy: credential.issuedBy,
      ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
      ...(credential.revokedAt ? { revokedAt: credential.revokedAt } : {}),
      ...(credential.revokedBy ? { revokedBy: credential.revokedBy } : {}),
      ...(credential.note ? { note: credential.note } : {}),
      ...(credential.lastUsedAt ? { lastUsedAt: credential.lastUsedAt } : {}),
      secretSalt: credential.secretSalt,
      secretHash: credential.secretHash,
    })),
  };
  fs.writeFileSync(cPath, `${JSON.stringify(serialized, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  try {
    fs.chmodSync(cPath, 0o600);
  } catch {
    // Best effort: chmod may fail on some platforms/filesystems.
  }
}

function credentialStorePath(workspacePath: string): string {
  return path.join(workspacePath, CREDENTIAL_STORE_FILE);
}

function credentialLedgerTarget(credentialId: string): string {
  return `.workgraph/auth/credentials/${credentialId}`;
}

function resolveAuthMode(workspacePath: string): WorkgraphAuthMode {
  const config = loadServerConfig(workspacePath);
  return config?.auth.mode ?? 'legacy';
}

function resolveAllowFallback(
  workspacePath: string,
  requested: boolean | undefined,
): boolean {
  if (typeof requested === 'boolean') return requested;
  const config = loadServerConfig(workspacePath);
  return config?.auth.allowUnauthenticatedFallback ?? true;
}

function resolveCredentialToken(input: MutationAuthorizationInput): string | undefined {
  const fromContext = normalizeOptionalText(getAuthContext()?.credentialToken);
  if (fromContext) return fromContext;
  const fromEnv = normalizeOptionalText(process.env.WORKGRAPH_AGENT_API_KEY)
    ?? normalizeOptionalText(process.env.WORKGRAPH_API_KEY);
  return fromEnv;
}

function getPolicyParty(
  workspacePath: string,
  actor: string,
): { id: string; capabilities: string[] } | null {
  const policyPath = path.join(workspacePath, POLICY_FILE);
  if (!fs.existsSync(policyPath)) {
    return actor === 'system'
      ? {
          id: 'system',
          capabilities: ['promote:sensitive', 'dispatch:run', 'policy:manage', 'gate:manage', 'agent:register'],
        }
      : null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(policyPath, 'utf-8')) as PolicyRegistrySnapshot;
    const party = parsed.parties?.[actor];
    if (!party) return null;
    return {
      id: String(party.id ?? actor),
      capabilities: dedupeStrings(asStringList(party.capabilities)),
    };
  } catch {
    return actor === 'system'
      ? {
          id: 'system',
          capabilities: ['promote:sensitive', 'dispatch:run', 'policy:manage', 'gate:manage', 'agent:register'],
        }
      : null;
  }
}

function capabilitySatisfied(grantedCapabilities: string[], requiredCapability: string): boolean {
  const required = normalizeOptionalText(requiredCapability);
  if (!required) return true;
  const granted = dedupeStrings(grantedCapabilities);
  for (const capability of granted) {
    if (capability === '*') return true;
    if (capability === required) return true;
    if (capability.endsWith(':*') && required.startsWith(`${capability.slice(0, -2)}:`)) {
      return true;
    }
  }
  return false;
}

function parseCredentialToken(rawToken: string | undefined): {
  looksLikeCredential: boolean;
  id?: string;
  secret?: string;
} | null {
  const token = normalizeOptionalText(rawToken);
  if (!token) return null;
  if (!token.startsWith(API_KEY_PREFIX)) {
    return { looksLikeCredential: false };
  }
  const remainder = token.slice(API_KEY_PREFIX.length);
  const separatorIndex = remainder.indexOf('.');
  if (separatorIndex <= 0 || separatorIndex >= remainder.length - 1) {
    return { looksLikeCredential: true };
  }
  const id = normalizeCredentialId(remainder.slice(0, separatorIndex));
  const secret = normalizeOptionalText(remainder.slice(separatorIndex + 1));
  return {
    looksLikeCredential: true,
    ...(id ? { id } : {}),
    ...(secret ? { secret } : {}),
  };
}

function sanitizeStoredCredential(value: unknown): StoredCredential | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Partial<StoredCredential>;
  const id = normalizeCredentialId(entry.id);
  const actor = normalizeActor(entry.actor);
  const scopes = dedupeStrings(asStringList(entry.scopes));
  const issuedAt = normalizeOptionalIsoDate(entry.issuedAt);
  const issuedBy = normalizeActor(entry.issuedBy);
  const secretSalt = normalizeOptionalText(entry.secretSalt);
  const secretHash = normalizeOptionalText(entry.secretHash);
  if (!id || !actor || !issuedAt || !issuedBy || !secretSalt || !secretHash) {
    return null;
  }
  const status: CredentialStatus = entry.status === 'revoked' ? 'revoked' : 'active';
  return {
    id,
    actor,
    scopes,
    status,
    issuedAt,
    issuedBy,
    ...(normalizeOptionalIsoDate(entry.expiresAt) ? { expiresAt: normalizeOptionalIsoDate(entry.expiresAt)! } : {}),
    ...(normalizeOptionalIsoDate(entry.revokedAt) ? { revokedAt: normalizeOptionalIsoDate(entry.revokedAt)! } : {}),
    ...(normalizeActor(entry.revokedBy) ? { revokedBy: normalizeActor(entry.revokedBy)! } : {}),
    ...(normalizeOptionalText(entry.note) ? { note: normalizeOptionalText(entry.note)! } : {}),
    ...(normalizeOptionalIsoDate(entry.lastUsedAt) ? { lastUsedAt: normalizeOptionalIsoDate(entry.lastUsedAt)! } : {}),
    secretSalt,
    secretHash,
  };
}

function toAgentCredential(credential: StoredCredential): AgentCredential {
  return {
    id: credential.id,
    actor: credential.actor,
    scopes: [...credential.scopes],
    status: credential.status,
    issuedAt: credential.issuedAt,
    issuedBy: credential.issuedBy,
    ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
    ...(credential.revokedAt ? { revokedAt: credential.revokedAt } : {}),
    ...(credential.revokedBy ? { revokedBy: credential.revokedBy } : {}),
    ...(credential.note ? { note: credential.note } : {}),
    ...(credential.lastUsedAt ? { lastUsedAt: credential.lastUsedAt } : {}),
  };
}

function hashCredentialSecret(salt: string, secret: string): string {
  return createHash('sha256')
    .update(`${salt}:${secret}`, 'utf-8')
    .digest('hex');
}

function normalizeActor(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function normalizeAction(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function normalizeCredentialId(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalIsoDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ISO date value "${trimmed}".`);
  }
  return new Date(parsed).toISOString();
}

function dedupeStrings(value: unknown): string[] {
  return [...new Set(asStringList(value))];
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

function sanitizeAuthContext(input: WorkgraphAuthContext): WorkgraphAuthContext {
  return {
    ...(normalizeOptionalText(input.credentialToken)
      ? { credentialToken: normalizeOptionalText(input.credentialToken) }
      : {}),
    ...(input.source ? { source: input.source } : {}),
  };
}
