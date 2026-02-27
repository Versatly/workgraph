import * as orientation from './orientation.js';
import * as store from './store.js';
import * as thread from './thread.js';
import type {
  DispatchAdapter,
  DispatchAdapterCreateInput,
  DispatchAdapterExecutionInput,
  DispatchAdapterExecutionResult,
  DispatchAdapterLogEntry,
  DispatchAdapterRunStatus,
} from './runtime-adapter-contracts.js';

const DEFAULT_MAX_STEPS = 200;
const DEFAULT_STEP_DELAY_MS = 25;
const DEFAULT_AGENT_COUNT = 3;

export class CursorCloudAdapter implements DispatchAdapter {
  name = 'cursor-cloud';

  async create(_input: DispatchAdapterCreateInput): Promise<DispatchAdapterRunStatus> {
    return {
      runId: 'adapter-managed',
      status: 'queued',
    };
  }

  async status(runId: string): Promise<DispatchAdapterRunStatus> {
    return { runId, status: 'running' };
  }

  async followup(runId: string, _actor: string, _input: string): Promise<DispatchAdapterRunStatus> {
    return { runId, status: 'running' };
  }

  async stop(runId: string, _actor: string): Promise<DispatchAdapterRunStatus> {
    return { runId, status: 'cancelled' };
  }

  async logs(_runId: string): Promise<DispatchAdapterLogEntry[]> {
    return [];
  }

  async execute(input: DispatchAdapterExecutionInput): Promise<DispatchAdapterExecutionResult> {
    const start = Date.now();
    const logs: DispatchAdapterLogEntry[] = [];
    const agentPool = normalizeAgents(input.agents, input.actor);
    const maxSteps = normalizeInt(input.maxSteps, DEFAULT_MAX_STEPS, 1, 5000);
    const stepDelayMs = normalizeInt(input.stepDelayMs, DEFAULT_STEP_DELAY_MS, 0, 5000);
    const claimedByAgent: Record<string, number> = {};
    const completedByAgent: Record<string, number> = {};
    let stepsExecuted = 0;
    let completionCount = 0;
    let failureCount = 0;
    let cancelled = false;

    for (const agent of agentPool) {
      claimedByAgent[agent] = 0;
      completedByAgent[agent] = 0;
    }

    pushLog(logs, 'info', `Run ${input.runId} started with agents: ${agentPool.join(', ')}`);
    pushLog(logs, 'info', `Objective: ${input.objective}`);

    while (stepsExecuted < maxSteps) {
      if (input.isCancelled?.()) {
        cancelled = true;
        pushLog(logs, 'warn', `Run ${input.runId} received cancellation signal.`);
        break;
      }

      const claimedThisRound: Array<{ agent: string; threadPath: string; goal: string }> = [];
      for (const agent of agentPool) {
        try {
          const claimed = input.space
            ? thread.claimNextReadyInSpace(input.workspacePath, agent, input.space)
            : thread.claimNextReady(input.workspacePath, agent);
          if (!claimed) {
            continue;
          }
          const path = claimed.path;
          const goal = String(claimed.fields.goal ?? claimed.fields.title ?? path);
          claimedThisRound.push({ agent, threadPath: path, goal });
          claimedByAgent[agent] += 1;
          pushLog(logs, 'info', `${agent} claimed ${path}`);
        } catch (error) {
          // Races are expected in multi-agent scheduling; recover and keep moving.
          pushLog(logs, 'warn', `${agent} claim skipped: ${errorMessage(error)}`);
        }
      }

      if (claimedThisRound.length === 0) {
        const readyRemaining = listReady(input.workspacePath, input.space).length;
        if (readyRemaining === 0) {
          pushLog(logs, 'info', 'No ready threads remaining; autonomous loop complete.');
          break;
        }
        if (stepDelayMs > 0) {
          await sleep(stepDelayMs);
        }
        continue;
      }

      await Promise.all(claimedThisRound.map(async (claimed) => {
        if (input.isCancelled?.()) {
          cancelled = true;
          return;
        }
        if (stepDelayMs > 0) {
          await sleep(stepDelayMs);
        }
        try {
          thread.done(
            input.workspacePath,
            claimed.threadPath,
            claimed.agent,
            `Completed by ${claimed.agent} during dispatch run ${input.runId}. Goal: ${claimed.goal}`,
          );
          completionCount += 1;
          completedByAgent[claimed.agent] += 1;
          pushLog(logs, 'info', `${claimed.agent} completed ${claimed.threadPath}`);
        } catch (error) {
          failureCount += 1;
          pushLog(logs, 'error', `${claimed.agent} failed to complete ${claimed.threadPath}: ${errorMessage(error)}`);
        }
      }));

      stepsExecuted += claimedThisRound.length;
      if (cancelled) break;
    }

    const readyAfter = listReady(input.workspacePath, input.space);
    const activeAfter = input.space
      ? store.threadsInSpace(input.workspacePath, input.space).filter((candidate) => candidate.fields.status === 'active')
      : store.activeThreads(input.workspacePath);
    const openAfter = input.space
      ? store.threadsInSpace(input.workspacePath, input.space).filter((candidate) => candidate.fields.status === 'open')
      : store.openThreads(input.workspacePath);
    const blockedAfter = input.space
      ? store.threadsInSpace(input.workspacePath, input.space).filter((candidate) => candidate.fields.status === 'blocked')
      : store.blockedThreads(input.workspacePath);

    const elapsedMs = Date.now() - start;
    const summary = renderSummary({
      objective: input.objective,
      runId: input.runId,
      completed: completionCount,
      failed: failureCount,
      stepsExecuted,
      readyRemaining: readyAfter.length,
      openRemaining: openAfter.length,
      blockedRemaining: blockedAfter.length,
      activeRemaining: activeAfter.length,
      elapsedMs,
      claimedByAgent,
      completedByAgent,
      cancelled,
    });

    if (input.createCheckpoint !== false) {
      try {
        orientation.checkpoint(
          input.workspacePath,
          input.actor,
          `Dispatch run ${input.runId} completed autonomous execution.`,
          {
            next: readyAfter.slice(0, 10).map((entry) => entry.path),
            blocked: blockedAfter.slice(0, 10).map((entry) => entry.path),
            tags: ['dispatch', 'autonomous-run'],
          },
        );
        pushLog(logs, 'info', `Checkpoint recorded for run ${input.runId}.`);
      } catch (error) {
        // Checkpoint creation is helpful but should not fail a completed run.
        pushLog(logs, 'warn', `Checkpoint creation skipped: ${errorMessage(error)}`);
      }
    }

    if (cancelled) {
      return {
        status: 'cancelled',
        output: summary,
        logs,
        metrics: {
          completed: completionCount,
          failed: failureCount,
          readyRemaining: readyAfter.length,
          openRemaining: openAfter.length,
          blockedRemaining: blockedAfter.length,
          elapsedMs,
          claimedByAgent,
          completedByAgent,
        },
      };
    }

    if (failureCount > 0) {
      return {
        status: 'failed',
        error: summary,
        logs,
        metrics: {
          completed: completionCount,
          failed: failureCount,
          readyRemaining: readyAfter.length,
          openRemaining: openAfter.length,
          blockedRemaining: blockedAfter.length,
          elapsedMs,
          claimedByAgent,
          completedByAgent,
        },
      };
    }

    const status = readyAfter.length === 0 && activeAfter.length === 0 ? 'succeeded' : 'failed';
    if (status === 'failed') {
      pushLog(logs, 'warn', 'Execution stopped with actionable work still remaining.');
    }

    return {
      status,
      output: summary,
      logs,
      metrics: {
        completed: completionCount,
        failed: failureCount,
        readyRemaining: readyAfter.length,
        openRemaining: openAfter.length,
        blockedRemaining: blockedAfter.length,
        elapsedMs,
        claimedByAgent,
        completedByAgent,
      },
    };
  }
}

function normalizeAgents(agents: string[] | undefined, actor: string): string[] {
  const fromInput = (agents ?? []).map((entry) => String(entry).trim()).filter(Boolean);
  if (fromInput.length > 0) return [...new Set(fromInput)];
  return Array.from({ length: DEFAULT_AGENT_COUNT }, (_, idx) => `${actor}-worker-${idx + 1}`);
}

function normalizeInt(
  rawValue: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number.isFinite(rawValue) ? Number(rawValue) : fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function pushLog(target: DispatchAdapterLogEntry[], level: DispatchAdapterLogEntry['level'], message: string): void {
  target.push({
    ts: new Date().toISOString(),
    level,
    message,
  });
}

function listReady(workspacePath: string, space: string | undefined) {
  return space
    ? thread.listReadyThreadsInSpace(workspacePath, space)
    : thread.listReadyThreads(workspacePath);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function renderSummary(data: {
  objective: string;
  runId: string;
  completed: number;
  failed: number;
  stepsExecuted: number;
  readyRemaining: number;
  openRemaining: number;
  blockedRemaining: number;
  activeRemaining: number;
  elapsedMs: number;
  claimedByAgent: Record<string, number>;
  completedByAgent: Record<string, number>;
  cancelled: boolean;
}): string {
  const lines = [
    `Autonomous dispatch summary for ${data.runId}`,
    `Objective: ${data.objective}`,
    `Completed threads: ${data.completed}`,
    `Failed completions: ${data.failed}`,
    `Scheduler steps executed: ${data.stepsExecuted}`,
    `Ready remaining: ${data.readyRemaining}`,
    `Open remaining: ${data.openRemaining}`,
    `Blocked remaining: ${data.blockedRemaining}`,
    `Active remaining: ${data.activeRemaining}`,
    `Elapsed ms: ${data.elapsedMs}`,
    `Cancelled: ${data.cancelled ? 'yes' : 'no'}`,
    '',
    'Claims by agent:',
    ...Object.entries(data.claimedByAgent).map(([agent, count]) => `- ${agent}: ${count}`),
    '',
    'Completions by agent:',
    ...Object.entries(data.completedByAgent).map(([agent, count]) => `- ${agent}: ${count}`),
  ];
  return lines.join('\n');
}
