import fs from 'node:fs';
import path from 'node:path';
import * as dispatch from './dispatch.js';
import * as missionOrchestrator from './mission-orchestrator.js';
import * as thread from './thread.js';
import * as triggerEngine from './trigger-engine.js';

export interface AutonomyLoopOptions {
  actor: string;
  adapter?: string;
  agents?: string[];
  space?: string;
  pollMs?: number;
  watch?: boolean;
  maxCycles?: number;
  maxIdleCycles?: number;
  maxSteps?: number;
  stepDelayMs?: number;
  executeTriggers?: boolean;
  executeReadyThreads?: boolean;
  heartbeatFile?: string;
}

export interface AutonomyCycleReport {
  cycle: number;
  readyThreads: number;
  triggerActions: number;
  missionActions: number;
  repairedRuns: number;
  requeuedRuns: number;
  runId?: string;
  runStatus?: string;
  driftOk: boolean;
  driftIssues: number;
}

export interface AutonomyLoopResult {
  cycles: AutonomyCycleReport[];
  finalReadyThreads: number;
  finalDriftOk: boolean;
}

export async function runAutonomyLoop(
  workspacePath: string,
  options: AutonomyLoopOptions,
): Promise<AutonomyLoopResult> {
  const watch = options.watch === true;
  const pollMs = clampInt(options.pollMs, 2000, 100, 60_000);
  const maxCycles = clampInt(options.maxCycles, watch ? Number.MAX_SAFE_INTEGER : 20, 1, Number.MAX_SAFE_INTEGER);
  const maxIdleCycles = clampInt(options.maxIdleCycles, watch ? Number.MAX_SAFE_INTEGER : 2, 1, Number.MAX_SAFE_INTEGER);
  const cycles: AutonomyCycleReport[] = [];
  let idleCycles = 0;

  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    const dispatchRecovery = dispatch.recoverDispatchState(workspacePath, options.actor);
    const leaseReconcile = dispatch.reconcileExpiredLeases(workspacePath, options.actor);
    const threadRecovery = thread.recoverThreadState(workspacePath, options.actor, {
      staleClaimLimit: 100,
    });
    const preExecutionMissionCycles = missionOrchestrator.runMissionOrchestratorForActiveMissions(
      workspacePath,
      options.actor,
    );
    const triggerResult = options.executeTriggers === false
      ? null
      : triggerEngine.runTriggerEngineCycle(workspacePath, {
          actor: options.actor,
        });

    const readyNow = options.space
      ? thread.listReadyThreadsInSpace(workspacePath, options.space)
      : thread.listReadyThreads(workspacePath);

    let runId: string | undefined;
    let runStatus: string | undefined;
    if (options.executeReadyThreads !== false && readyNow.length > 0) {
      const run = await dispatch.createAndExecuteRun(
        workspacePath,
        {
          actor: options.actor,
          adapter: options.adapter ?? 'cursor-cloud',
          objective: `Autonomy cycle ${cycle}: coordinate ${readyNow.length} ready thread(s)`,
          context: {
            autonomy_cycle: cycle,
            autonomy_ready_count: readyNow.length,
          },
        },
        {
          agents: options.agents,
          maxSteps: options.maxSteps,
          stepDelayMs: options.stepDelayMs,
          space: options.space,
          createCheckpoint: true,
        },
      );
      runId = run.id;
      runStatus = run.status;
    }

    const postExecutionMissionCycles = missionOrchestrator.runMissionOrchestratorForActiveMissions(
      workspacePath,
      options.actor,
    );
    const missionActions = [...preExecutionMissionCycles, ...postExecutionMissionCycles]
      .reduce((total, entry) => total + entry.actions.length, 0);
    const driftIssues =
      dispatchRecovery.repairedRuns.length +
      dispatchRecovery.removedCorruptRuns +
      dispatchRecovery.warnings.length +
      leaseReconcile.requeuedRuns.length +
      threadRecovery.leaseState.repaired +
      threadRecovery.leaseState.removed +
      threadRecovery.leaseState.issues.length +
      threadRecovery.staleClaims.reaped.length +
      threadRecovery.staleClaims.skipped.length +
      threadRecovery.brokenReferences.length +
      (triggerResult?.errors ?? 0);

    const report: AutonomyCycleReport = {
      cycle,
      readyThreads: readyNow.length,
      triggerActions: triggerResult?.fired ?? 0,
      missionActions,
      repairedRuns: dispatchRecovery.repairedRuns.length,
      requeuedRuns: leaseReconcile.requeuedRuns.length,
      runId,
      runStatus,
      driftOk: driftIssues === 0,
      driftIssues,
    };
    cycles.push(report);
    writeHeartbeat(options.heartbeatFile, {
      ts: new Date().toISOString(),
      ...report,
    });

    const isIdle = report.readyThreads === 0 && report.triggerActions === 0;
    if (isIdle) {
      idleCycles += 1;
    } else {
      idleCycles = 0;
    }

    if (!watch && idleCycles >= maxIdleCycles) {
      break;
    }
    if (cycle >= maxCycles) {
      break;
    }
    await sleep(pollMs);
  }

  const finalReadyThreads = (options.space
    ? thread.listReadyThreadsInSpace(workspacePath, options.space)
    : thread.listReadyThreads(workspacePath)).length;
  writeHeartbeat(options.heartbeatFile, {
    ts: new Date().toISOString(),
    finalReadyThreads,
    finalDriftOk: cycles.every((entry) => entry.driftOk),
  });
  return {
    cycles,
    finalReadyThreads,
    finalDriftOk: cycles.every((entry) => entry.driftOk),
  };
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, raw));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function writeHeartbeat(filePath: string | undefined, payload: Record<string, unknown>): void {
  if (!filePath) return;
  const absolutePath = path.resolve(filePath);
  const dir = path.dirname(absolutePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(absolutePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}
