import * as dispatch from '../dispatch.js';
import type { DispatchRun } from '../types.js';
import type { ProjectionSummary } from './types.js';

export interface RunHealthProjection extends ProjectionSummary {
  scope: 'run';
  summary: {
    totalRuns: number;
    activeRuns: number;
    queuedRuns: number;
    staleRuns: number;
    failedRuns: number;
    failedReconciliations: number;
  };
  activeRuns: DispatchRun[];
  staleRuns: DispatchRun[];
  failedRuns: DispatchRun[];
  failedReconciliations: DispatchRun[];
}

const DEFAULT_STALE_MINUTES = 30;

export function buildRunHealthProjection(
  workspacePath: string,
  options: { staleMinutes?: number } = {},
): RunHealthProjection {
  const runs = dispatch.listRuns(workspacePath);
  const staleCutoff = Date.now() - (Math.max(1, options.staleMinutes ?? DEFAULT_STALE_MINUTES) * 60_000);
  const activeRuns = runs.filter((run) => run.status === 'running');
  const queuedRuns = runs.filter((run) => run.status === 'queued');
  const staleRuns = runs.filter((run) =>
    (run.status === 'running' || run.status === 'queued')
    && Date.parse(run.updatedAt) <= staleCutoff,
  );
  const failedRuns = runs.filter((run) => run.status === 'failed');
  const failedReconciliations = runs.filter((run) => Boolean(run.dispatchTracking?.reconciliationError));
  return {
    scope: 'run',
    generatedAt: new Date().toISOString(),
    healthy: failedReconciliations.length === 0,
    summary: {
      totalRuns: runs.length,
      activeRuns: activeRuns.length,
      queuedRuns: queuedRuns.length,
      staleRuns: staleRuns.length,
      failedRuns: failedRuns.length,
      failedReconciliations: failedReconciliations.length,
    },
    activeRuns,
    staleRuns,
    failedRuns,
    failedReconciliations,
  };
}
