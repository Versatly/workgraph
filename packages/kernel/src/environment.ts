export type WorkgraphEnvironmentKind = 'local' | 'cloud';

export interface WorkgraphEnvironmentInfo {
  environment: WorkgraphEnvironmentKind;
  source: 'explicit' | 'platform' | 'default';
  featureFlags: Record<string, boolean>;
}

const CLOUD_PLATFORM_SIGNAL_KEYS = [
  'VERCEL',
  'K_SERVICE',
  'AWS_EXECUTION_ENV',
  'RAILWAY_ENVIRONMENT',
  'RENDER',
  'FLY_APP_NAME',
] as const;

export function detectEnvironment(env: NodeJS.ProcessEnv = process.env): WorkgraphEnvironmentKind {
  const explicit = normalizeEnvironment(env.WORKGRAPH_ENV);
  if (explicit) return explicit;
  if (hasCloudPlatformSignals(env)) return 'cloud';
  return 'local';
}

export function getEnvironmentInfo(env: NodeJS.ProcessEnv = process.env): WorkgraphEnvironmentInfo {
  const explicit = normalizeEnvironment(env.WORKGRAPH_ENV);
  if (explicit) {
    return {
      environment: explicit,
      source: 'explicit',
      featureFlags: listFeatureFlags(env),
    };
  }

  if (hasCloudPlatformSignals(env)) {
    return {
      environment: 'cloud',
      source: 'platform',
      featureFlags: listFeatureFlags(env),
    };
  }

  return {
    environment: 'local',
    source: 'default',
    featureFlags: listFeatureFlags(env),
  };
}

export function listFeatureFlags(env: NodeJS.ProcessEnv = process.env): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('WORKGRAPH_FEATURE_')) continue;
    const featureName = normalizeFeatureFlagName(key.slice('WORKGRAPH_FEATURE_'.length));
    if (!featureName) continue;
    flags[featureName] = parseBooleanFlag(value, false);
  }
  return flags;
}

export function isFeatureEnabled(
  featureName: string,
  env: NodeJS.ProcessEnv = process.env,
  defaultValue = false,
): boolean {
  const normalizedFeatureName = normalizeFeatureFlagName(featureName);
  if (!normalizedFeatureName) return defaultValue;
  const envKey = `WORKGRAPH_FEATURE_${normalizedFeatureName.toUpperCase().replace(/-/g, '_')}`;
  return parseBooleanFlag(env[envKey], defaultValue);
}

function normalizeEnvironment(raw: string | undefined): WorkgraphEnvironmentKind | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'local' || normalized === 'cloud') return normalized;
  return undefined;
}

function normalizeFeatureFlagName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replaceAll('_', '-');
}

function hasCloudPlatformSignals(env: NodeJS.ProcessEnv): boolean {
  return CLOUD_PLATFORM_SIGNAL_KEYS.some((key) => readNonEmptyString(env[key]) !== undefined);
}

function parseBooleanFlag(raw: string | undefined, defaultValue: boolean): boolean {
  const normalized = readNonEmptyString(raw)?.toLowerCase();
  if (!normalized) return defaultValue;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return defaultValue;
}

function readNonEmptyString(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
