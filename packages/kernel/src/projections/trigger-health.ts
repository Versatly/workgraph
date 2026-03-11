import * as triggerEngine from '../trigger-engine.js';
import type { ProjectionSummary } from './types.js';

export interface TriggerHealthProjection extends ProjectionSummary {
  scope: 'trigger';
  summary: {
    totalTriggers: number;
    errorTriggers: number;
    cooldownTriggers: number;
  };
  dashboard: ReturnType<typeof triggerEngine.triggerDashboard>;
}

export function buildTriggerHealthProjection(workspacePath: string): TriggerHealthProjection {
  const dashboard = triggerEngine.triggerDashboard(workspacePath);
  const errorTriggers = dashboard.triggers.filter((entry) => entry.currentState === 'error').length;
  const cooldownTriggers = dashboard.triggers.filter((entry) => entry.currentState === 'cooldown').length;
  return {
    scope: 'trigger',
    generatedAt: new Date().toISOString(),
    healthy: errorTriggers === 0,
    summary: {
      totalTriggers: dashboard.triggers.length,
      errorTriggers,
      cooldownTriggers,
    },
    dashboard,
  };
}
