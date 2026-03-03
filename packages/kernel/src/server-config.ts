import fs from 'node:fs';
import path from 'node:path';

export const WORKGRAPH_SERVER_CONFIG_FILE = '.workgraph/server.json';
const DEFAULT_SERVER_HOST = '127.0.0.1';
const DEFAULT_SERVER_PORT = 8787;
const DEFAULT_SERVER_ENDPOINT_PATH = '/mcp';
const DEFAULT_SERVER_ACTOR = 'system';
const DEFAULT_BOOTSTRAP_TOKEN_PATH = 'trust-tokens/bootstrap-first-agent.md';
const DEFAULT_AUTH_MODE_EXISTING: WorkgraphAuthMode = 'legacy';
const DEFAULT_AUTH_MODE_NEW: WorkgraphAuthMode = 'hybrid';
const DEFAULT_REGISTRATION_MODE_EXISTING: WorkgraphServerRegistrationMode = 'legacy';
const DEFAULT_REGISTRATION_MODE_NEW: WorkgraphServerRegistrationMode = 'approval';

export type WorkgraphAuthMode = 'legacy' | 'hybrid' | 'strict';
export type WorkgraphServerRegistrationMode = 'legacy' | 'approval';

export interface WorkgraphServerRegistrationConfig {
  enabled: boolean;
  mode: WorkgraphServerRegistrationMode;
  bootstrapTokenPath: string;
  allowBootstrapFallback: boolean;
}

export interface WorkgraphServerAuthConfig {
  mode: WorkgraphAuthMode;
  allowUnauthenticatedFallback: boolean;
}

export interface WorkgraphServerConfig {
  host: string;
  port: number;
  endpointPath: string;
  defaultActor: string;
  bearerToken?: string;
  auth: WorkgraphServerAuthConfig;
  registration: WorkgraphServerRegistrationConfig;
}

export interface EnsureServerConfigOptions {
  bootstrapTokenPath?: string;
}

export interface EnsureServerConfigResult {
  config: WorkgraphServerConfig;
  path: string;
  created: boolean;
  updated: boolean;
}

export function serverConfigPath(workspacePath: string): string {
  return path.join(workspacePath, WORKGRAPH_SERVER_CONFIG_FILE);
}

export function loadServerConfig(workspacePath: string): WorkgraphServerConfig | null {
  const targetPath = serverConfigPath(workspacePath);
  if (!fs.existsSync(targetPath)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(targetPath, 'utf-8')) as Record<string, unknown>;
    return normalizeServerConfig(parsed, 'existing');
  } catch {
    return null;
  }
}

export function ensureServerConfig(
  workspacePath: string,
  options: EnsureServerConfigOptions = {},
): EnsureServerConfigResult {
  const targetPath = serverConfigPath(workspacePath);
  const desiredBootstrapTokenPath = normalizePathRef(
    options.bootstrapTokenPath ?? DEFAULT_BOOTSTRAP_TOKEN_PATH,
  );
  const existing = loadServerConfig(workspacePath);
  if (!existing) {
    const createdConfig = normalizeServerConfig({
      registration: {
        bootstrapTokenPath: desiredBootstrapTokenPath,
      },
    }, 'new');
    writeServerConfig(workspacePath, createdConfig);
    return {
      config: createdConfig,
      path: targetPath,
      created: true,
      updated: false,
    };
  }

  const needsBootstrapPath = !existing.registration.bootstrapTokenPath;
  if (!needsBootstrapPath) {
    return {
      config: existing,
      path: targetPath,
      created: false,
      updated: false,
    };
  }

  const updated = {
    ...existing,
    registration: {
      ...existing.registration,
      bootstrapTokenPath: desiredBootstrapTokenPath,
    },
  };
  writeServerConfig(workspacePath, updated);
  return {
    config: updated,
    path: targetPath,
    created: false,
    updated: true,
  };
}

function writeServerConfig(workspacePath: string, config: WorkgraphServerConfig): void {
  const targetPath = serverConfigPath(workspacePath);
  const directory = path.dirname(targetPath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(targetPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

function normalizeServerConfig(
  input: Record<string, unknown>,
  profile: 'existing' | 'new' = 'existing',
): WorkgraphServerConfig {
  const registrationInput = asRecord(input.registration);
  const authInput = asRecord(input.auth);
  const defaultAuthMode = profile === 'new'
    ? DEFAULT_AUTH_MODE_NEW
    : DEFAULT_AUTH_MODE_EXISTING;
  const defaultRegistrationMode = profile === 'new'
    ? DEFAULT_REGISTRATION_MODE_NEW
    : DEFAULT_REGISTRATION_MODE_EXISTING;
  return {
    host: readString(input.host) ?? DEFAULT_SERVER_HOST,
    port: normalizePort(input.port),
    endpointPath: normalizeEndpointPath(readString(input.endpointPath)),
    defaultActor: readString(input.defaultActor) ?? DEFAULT_SERVER_ACTOR,
    bearerToken: readString(input.bearerToken),
    auth: {
      mode: readAuthMode(authInput.mode) ?? defaultAuthMode,
      allowUnauthenticatedFallback: readBoolean(authInput.allowUnauthenticatedFallback) ?? true,
    },
    registration: {
      enabled: readBoolean(registrationInput.enabled) ?? true,
      mode: readRegistrationMode(registrationInput.mode) ?? defaultRegistrationMode,
      bootstrapTokenPath: normalizePathRef(
        readString(registrationInput.bootstrapTokenPath) ?? DEFAULT_BOOTSTRAP_TOKEN_PATH,
      ),
      allowBootstrapFallback: readBoolean(registrationInput.allowBootstrapFallback) ?? true,
    },
  };
}

function normalizePort(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) {
      return parsed;
    }
  }
  return DEFAULT_SERVER_PORT;
}

function normalizeEndpointPath(rawPath: string | undefined): string {
  const trimmed = String(rawPath ?? '').trim();
  if (!trimmed) return DEFAULT_SERVER_ENDPOINT_PATH;
  if (trimmed.startsWith('/')) return trimmed;
  return `/${trimmed}`;
}

function normalizePathRef(rawPath: string): string {
  const normalized = String(rawPath)
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  if (!normalized) return DEFAULT_BOOTSTRAP_TOKEN_PATH;
  return normalized.endsWith('.md') ? normalized : `${normalized}.md`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return undefined;
}

function readAuthMode(value: unknown): WorkgraphAuthMode | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'legacy' || normalized === 'hybrid' || normalized === 'strict') {
    return normalized;
  }
  return undefined;
}

function readRegistrationMode(value: unknown): WorkgraphServerRegistrationMode | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'legacy' || normalized === 'approval') {
    return normalized;
  }
  return undefined;
}
