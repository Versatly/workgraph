import * as store from '../store.js';
import * as threadAudit from '../thread-audit.js';
import type { PrimitiveInstance } from '../types.js';
import type { ProjectionSummary } from './types.js';

export interface RiskDashboardProjection extends ProjectionSummary {
  scope: 'org';
  summary: {
    blockedThreads: number;
    escalations: number;
    policyViolations: number;
  };
  blockedThreads: PrimitiveInstance[];
  escalations: PrimitiveInstance[];
  policyViolations: ReturnType<typeof threadAudit.reconcileThreadState>['issues'];
}

export function buildRiskDashboardProjection(workspacePath: string): RiskDashboardProjection {
  const blockedThreads = store.blockedThreads(workspacePath);
  const escalations = store.list(workspacePath, 'incident')
    .filter((entry) => String(entry.fields.status ?? '').toLowerCase() === 'active');
  const audit = threadAudit.reconcileThreadState(workspacePath);
  return {
    scope: 'org',
    generatedAt: new Date().toISOString(),
    healthy: audit.issues.length === 0 && blockedThreads.length === 0,
    summary: {
      blockedThreads: blockedThreads.length,
      escalations: escalations.length,
      policyViolations: audit.issues.length,
    },
    blockedThreads,
    escalations,
    policyViolations: audit.issues,
  };
}
