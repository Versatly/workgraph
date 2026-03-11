import {
  projections as projectionsModule,
} from '@versatly/workgraph-kernel';

const projections = projectionsModule;

export type ProjectionRouteName =
  | 'overview'
  | 'run-health'
  | 'risk-dashboard'
  | 'mission-progress'
  | 'transport-health'
  | 'federation-status'
  | 'trigger-health'
  | 'autonomy-health';

export function buildProjectionByName(workspacePath: string, name: ProjectionRouteName) {
  switch (name) {
    case 'overview':
      return buildProjectionOverview(workspacePath);
    case 'run-health':
      return projections.buildRunHealthProjection(workspacePath);
    case 'risk-dashboard':
      return projections.buildRiskDashboardProjection(workspacePath);
    case 'mission-progress':
      return projections.buildMissionProgressProjection(workspacePath);
    case 'transport-health':
      return projections.buildTransportHealthProjection(workspacePath);
    case 'federation-status':
      return projections.buildFederationStatusProjection(workspacePath);
    case 'trigger-health':
      return projections.buildTriggerHealthProjection(workspacePath);
    case 'autonomy-health':
      return projections.buildAutonomyHealthProjection(workspacePath);
    default:
      return assertNever(name);
  }
}

export function listProjectionRouteNames(): ProjectionRouteName[] {
  return [
    'overview',
    'run-health',
    'risk-dashboard',
    'mission-progress',
    'transport-health',
    'federation-status',
    'trigger-health',
    'autonomy-health',
  ];
}

export function buildProjectionOverview(workspacePath: string) {
  return {
    generatedAt: new Date().toISOString(),
    projections: {
      runHealth: projections.buildRunHealthProjection(workspacePath),
      riskDashboard: projections.buildRiskDashboardProjection(workspacePath),
      missionProgress: projections.buildMissionProgressProjection(workspacePath),
      transportHealth: projections.buildTransportHealthProjection(workspacePath),
      federationStatus: projections.buildFederationStatusProjection(workspacePath),
      triggerHealth: projections.buildTriggerHealthProjection(workspacePath),
      autonomyHealth: projections.buildAutonomyHealthProjection(workspacePath),
    },
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled projection route "${String(value)}".`);
}
