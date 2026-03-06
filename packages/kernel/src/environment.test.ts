import { describe, expect, it } from 'vitest';
import {
  detectEnvironment,
  getEnvironmentInfo,
  isFeatureEnabled,
  listFeatureFlags,
} from './environment.js';

describe('environment detection', () => {
  it('prefers WORKGRAPH_ENV when set to cloud/local', () => {
    expect(detectEnvironment(asEnv({ WORKGRAPH_ENV: 'cloud' }))).toBe('cloud');
    expect(detectEnvironment(asEnv({ WORKGRAPH_ENV: 'local', VERCEL: '1' }))).toBe('local');
  });

  it('falls back to cloud when known cloud signals are present', () => {
    expect(detectEnvironment(asEnv({ VERCEL: '1' }))).toBe('cloud');
    expect(detectEnvironment(asEnv({ K_SERVICE: 'workgraph-api' }))).toBe('cloud');
  });

  it('defaults to local when no signals are present', () => {
    expect(detectEnvironment(asEnv({}))).toBe('local');
  });

  it('returns environment metadata including source and feature flags', () => {
    const info = getEnvironmentInfo(asEnv({
      WORKGRAPH_ENV: 'cloud',
      WORKGRAPH_FEATURE_PORTABILITY: 'true',
      WORKGRAPH_FEATURE_FAST_IMPORT: '0',
    }));

    expect(info.environment).toBe('cloud');
    expect(info.source).toBe('explicit');
    expect(info.featureFlags).toEqual({
      portability: true,
      'fast-import': false,
    });
  });
});

describe('feature flags', () => {
  it('lists and normalizes WORKGRAPH_FEATURE_* flags', () => {
    expect(listFeatureFlags(asEnv({
      WORKGRAPH_FEATURE_LOCAL_EXPORT: 'yes',
      WORKGRAPH_FEATURE_CLOUD_IMPORT: 'off',
      WORKGRAPH_FEATURE_EMPTY: '',
    }))).toEqual({
      'local-export': true,
      'cloud-import': false,
      empty: false,
    });
  });

  it('resolves one feature flag with defaults', () => {
    const env = asEnv({
      WORKGRAPH_FEATURE_LOCAL_EXPORT: 'true',
    });
    expect(isFeatureEnabled('local-export', env)).toBe(true);
    expect(isFeatureEnabled('cloud-import', env)).toBe(false);
    expect(isFeatureEnabled('unknown-flag', env, true)).toBe(true);
  });
});

function asEnv(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}
