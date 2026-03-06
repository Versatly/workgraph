import fs from 'node:fs';
import path from 'node:path';
import type { WorkgraphWorkspaceConfig } from './types.js';
import { detectStorageMode, type StorageMode } from './storage.js';

export interface WorkgraphFeatureFlags {
  sseServer: boolean;
  webhooks: boolean;
}

export interface WorkgraphEnvironmentInfo {
  mode: StorageMode;
  modeSource: 'env' | 'config' | 'default';
  offline: boolean;
  featureFlags: WorkgraphFeatureFlags;
}

export function detectEnvironment(workspacePath: string): WorkgraphEnvironmentInfo {
  const resolvedWorkspace = path.resolve(workspacePath);
  const config = loadWorkspaceConfig(resolvedWorkspace);
  const mode = detectStorageMode(resolvedWorkspace);
  const modeSource = resolveModeSource(config);
  const offline = resolveOfflineMode(config);
  const featureFlags = resolveFeatureFlags(mode, config);
  return {
    mode,
    modeSource,
    offline,
    featureFlags,
  };
}

export function loadWorkspaceConfig(workspacePath: string): Partial<WorkgraphWorkspaceConfig> | null {
  const configPath = path.join(workspacePath, '.workgraph.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Partial<WorkgraphWorkspaceConfig>;
  } catch {
    return null;
  }
}

function resolveModeSource(config: Partial<WorkgraphWorkspaceConfig> | null): 'env' | 'config' | 'default' {
  const fromEnv = normalizeMode(process.env.WORKGRAPH_STORAGE_MODE)
    ?? normalizeMode(process.env.WORKGRAPH_MODE);
  if (fromEnv) return 'env';
  if (normalizeMode(config?.storageMode)) return 'config';
  if (config?.cloud && typeof config.cloud === 'object') return 'config';
  return 'default';
}

function resolveOfflineMode(config: Partial<WorkgraphWorkspaceConfig> | null): boolean {
  const fromEnv = readBooleanLike(process.env.WORKGRAPH_OFFLINE)
    ?? readBooleanLike(process.env.WORKGRAPH_CLOUD_OFFLINE);
  if (fromEnv !== undefined) return fromEnv;
  const cloudConfig = config?.cloud && typeof config.cloud === 'object'
    ? config.cloud as Record<string, unknown>
    : undefined;
  return readBooleanLike(cloudConfig?.offline) ?? false;
}

function resolveFeatureFlags(
  mode: StorageMode,
  config: Partial<WorkgraphWorkspaceConfig> | null,
): WorkgraphFeatureFlags {
  const configFeatures = config?.features && typeof config.features === 'object'
    ? config.features as Record<string, unknown>
    : undefined;
  const defaultCloudFlag = mode === 'cloud';
  const sseServer = readBooleanLike(process.env.WORKGRAPH_FEATURE_SSE_SERVER)
    ?? readBooleanLike(process.env.WORKGRAPH_ENABLE_SSE)
    ?? readBooleanLike(configFeatures?.sseServer)
    ?? defaultCloudFlag;
  const webhooks = readBooleanLike(process.env.WORKGRAPH_FEATURE_WEBHOOKS)
    ?? readBooleanLike(process.env.WORKGRAPH_ENABLE_WEBHOOKS)
    ?? readBooleanLike(configFeatures?.webhooks)
    ?? defaultCloudFlag;
  return {
    sseServer,
    webhooks,
  };
}

function normalizeMode(value: unknown): StorageMode | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'local' || normalized === 'cloud') return normalized;
  return undefined;
}

function readBooleanLike(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}
