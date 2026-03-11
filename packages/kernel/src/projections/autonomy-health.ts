import * as autonomyDaemon from '../autonomy-daemon.js';
import type { ProjectionSummary } from './types.js';

export interface AutonomyHealthProjection extends ProjectionSummary {
  scope: 'autonomy';
  summary: {
    running: boolean;
    lastHeartbeatAt?: string;
    driftIssues?: number;
  };
  status: ReturnType<typeof autonomyDaemon.readAutonomyDaemonStatus>;
}

export function buildAutonomyHealthProjection(workspacePath: string): AutonomyHealthProjection {
  const status = autonomyDaemon.readAutonomyDaemonStatus(workspacePath, {
    cleanupStalePidFile: true,
  });
  return {
    scope: 'autonomy',
    generatedAt: new Date().toISOString(),
    healthy: !status.running || Boolean(status.heartbeat?.driftOk ?? status.heartbeat?.finalDriftOk ?? true),
    summary: {
      running: status.running,
      lastHeartbeatAt: status.heartbeat?.ts,
      driftIssues: status.heartbeat?.driftIssues,
    },
    status,
  };
}
