import * as federation from '../federation.js';
import type { ProjectionSummary } from './types.js';

export interface FederationStatusProjection extends ProjectionSummary {
  scope: 'federation';
  summary: {
    remotes: number;
    compatibleRemotes: number;
    staleRemotes: number;
  };
  status: ReturnType<typeof federation.federationStatus>;
}

export function buildFederationStatusProjection(workspacePath: string): FederationStatusProjection {
  const status = federation.federationStatus(workspacePath);
  const compatibleRemotes = status.remotes.filter((entry) => entry.compatible).length;
  const staleRemotes = status.remotes.filter((entry) => {
    const remote = entry.remote;
    return !remote.lastSyncedAt || remote.lastSyncStatus !== 'synced';
  }).length;
  return {
    scope: 'federation',
    generatedAt: new Date().toISOString(),
    healthy: status.remotes.every((entry) => entry.compatible && entry.supportsRead),
    summary: {
      remotes: status.remotes.length,
      compatibleRemotes,
      staleRemotes,
    },
    status,
  };
}
