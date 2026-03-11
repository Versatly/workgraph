import { createHash } from 'node:crypto';
import path from 'node:path';

export const FEDERATION_PROTOCOL_VERSION = 'wg-federation/v1';
export const DEFAULT_FEDERATION_CAPABILITIES = [
  'resolve-ref',
  'search',
  'read-primitive',
  'read-thread',
] as const;

export type FederationTrustLevel = 'local' | 'read-only';
export type FederationTransportKind = 'local-path' | 'http' | 'mcp';

export interface FederationWorkspaceIdentity {
  workspaceId: string;
  protocolVersion: string;
  capabilities: string[];
  trustLevel: FederationTrustLevel;
}

export interface FederatedPrimitiveRef {
  workspaceId: string;
  primitiveType: string;
  primitiveSlug: string;
  protocolVersion: string;
  transport: FederationTransportKind;
  primitivePath?: string;
  remoteAlias?: string;
}

export function deriveWorkspaceId(workspacePath: string): string {
  const normalized = path.resolve(workspacePath).replace(/\\/g, '/');
  const hash = createHash('sha256').update(`workgraph-federation:${normalized}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

export function normalizeFederationWorkspaceIdentity(
  value: unknown,
  workspacePath: string,
  fallbackTrustLevel: FederationTrustLevel = 'local',
): FederationWorkspaceIdentity {
  const record = asRecord(value);
  return {
    workspaceId: normalizeOptionalString(record.workspaceId) ?? normalizeOptionalString(record.workspace_id) ?? deriveWorkspaceId(workspacePath),
    protocolVersion: normalizeProtocolVersion(record.protocolVersion ?? record.protocol_version),
    capabilities: normalizeCapabilitySet(record.capabilities),
    trustLevel: normalizeTrustLevel(record.trustLevel ?? record.trust_level, fallbackTrustLevel),
  };
}

export function normalizeProtocolVersion(value: unknown): string {
  return normalizeOptionalString(value) ?? FEDERATION_PROTOCOL_VERSION;
}

export function normalizeCapabilitySet(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : DEFAULT_FEDERATION_CAPABILITIES;
  return [...new Set(raw.map((entry) => String(entry ?? '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export function normalizeTrustLevel(value: unknown, fallback: FederationTrustLevel = 'read-only'): FederationTrustLevel {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (normalized === 'local' || normalized === 'read-only') return normalized;
  return fallback;
}

export function normalizeTransportKind(value: unknown, fallback: FederationTransportKind = 'local-path'): FederationTransportKind {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (normalized === 'local-path' || normalized === 'http' || normalized === 'mcp') return normalized;
  return fallback;
}

export function buildFederatedPrimitiveRef(input: {
  workspaceId: string;
  primitiveType: string;
  primitivePath: string;
  protocolVersion?: string;
  transport?: FederationTransportKind;
  remoteAlias?: string;
}): FederatedPrimitiveRef {
  return {
    workspaceId: input.workspaceId,
    primitiveType: input.primitiveType,
    primitiveSlug: primitiveSlugFromPath(input.primitivePath),
    protocolVersion: normalizeProtocolVersion(input.protocolVersion),
    transport: input.transport ?? 'local-path',
    primitivePath: normalizePrimitivePath(input.primitivePath),
    ...(input.remoteAlias ? { remoteAlias: input.remoteAlias } : {}),
  };
}

export function normalizeFederatedPrimitiveRef(value: unknown): FederatedPrimitiveRef | null {
  const record = asRecord(value);
  const workspaceId = normalizeOptionalString(record.workspaceId) ?? normalizeOptionalString(record.workspace_id);
  const primitiveType = normalizeOptionalString(record.primitiveType) ?? normalizeOptionalString(record.primitive_type);
  const primitiveSlug = normalizeOptionalString(record.primitiveSlug) ?? normalizeOptionalString(record.primitive_slug);
  if (!workspaceId || !primitiveType || !primitiveSlug) return null;
  return {
    workspaceId,
    primitiveType,
    primitiveSlug,
    protocolVersion: normalizeProtocolVersion(record.protocolVersion ?? record.protocol_version),
    transport: normalizeTransportKind(record.transport),
    ...(normalizeOptionalString(record.primitivePath) ?? normalizeOptionalString(record.primitive_path)
      ? { primitivePath: normalizePrimitivePath(normalizeOptionalString(record.primitivePath) ?? normalizeOptionalString(record.primitive_path)!) }
      : {}),
    ...(normalizeOptionalString(record.remoteAlias) ?? normalizeOptionalString(record.remote_alias)
      ? { remoteAlias: normalizeOptionalString(record.remoteAlias) ?? normalizeOptionalString(record.remote_alias)! }
      : {}),
  };
}

export function parseFederatedRef(value: unknown): FederatedPrimitiveRef | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return normalizeFederatedPrimitiveRef(value);
  }
  const raw = normalizeOptionalString(value);
  if (!raw) return null;
  if (!raw.startsWith('federation://')) return null;
  const payload = raw.slice('federation://'.length);
  const firstSlash = payload.indexOf('/');
  if (firstSlash <= 0) return null;
  const remoteAlias = payload.slice(0, firstSlash);
  const primitivePath = normalizePrimitivePath(payload.slice(firstSlash + 1));
  const primitiveType = primitiveTypeFromPath(primitivePath);
  const primitiveSlug = primitiveSlugFromPath(primitivePath);
  if (!primitiveType || !primitiveSlug) return null;
  return {
    workspaceId: remoteAlias,
    primitiveType,
    primitiveSlug,
    protocolVersion: FEDERATION_PROTOCOL_VERSION,
    transport: 'local-path',
    primitivePath,
    remoteAlias,
  };
}

export function buildLegacyFederationLink(remoteAlias: string, primitivePath: string): string {
  return `federation://${remoteAlias}/${normalizePrimitivePath(primitivePath)}`;
}

export function primitiveSlugFromPath(primitivePath: string): string {
  const normalized = normalizePrimitivePath(primitivePath);
  const basename = path.basename(normalized, '.md');
  return basename;
}

export function primitiveTypeFromPath(primitivePath: string): string {
  const normalized = normalizePrimitivePath(primitivePath);
  const [directory] = normalized.split('/');
  if (!directory) return '';
  if (directory === 'threads') return 'thread';
  return directory.endsWith('s') ? directory.slice(0, -1) : directory;
}

export function normalizePrimitivePath(value: unknown): string {
  const raw = normalizeOptionalString(value) ?? '';
  if (!raw) return '';
  return raw.endsWith('.md') ? raw.replace(/\\/g, '/') : `${raw.replace(/\\/g, '/')}.md`;
}

export function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
