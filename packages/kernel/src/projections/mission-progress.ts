import * as mission from '../mission.js';
import * as store from '../store.js';
import type { ProjectionSummary } from './types.js';

export interface MissionProgressProjection extends ProjectionSummary {
  scope: 'mission';
  summary: {
    totalMissions: number;
    completedMissions: number;
    averageCompletionPercent: number;
  };
  missions: Array<ReturnType<typeof mission.missionProgress>>;
}

export function buildMissionProgressProjection(workspacePath: string): MissionProgressProjection {
  const missions = store.list(workspacePath, 'mission')
    .map((entry) => mission.missionProgress(workspacePath, entry.path));
  const completedMissions = missions.filter((entry) => entry.percentComplete >= 100 || entry.status === 'completed').length;
  const averageCompletionPercent = missions.length === 0
    ? 0
    : Math.round((missions.reduce((sum, entry) => sum + entry.percentComplete, 0) / missions.length) * 100) / 100;
  return {
    scope: 'mission',
    generatedAt: new Date().toISOString(),
    healthy: true,
    summary: {
      totalMissions: missions.length,
      completedMissions,
      averageCompletionPercent,
    },
    missions,
  };
}
