import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, saveRegistry } from './registry.js';
import {
  claimThread,
  createAndExecuteRun,
  createRun,
  executeRun,
  followup,
  heartbeat,
  listRuns,
  markRun,
  reconcileExpiredLeases,
  status,
  stop,
} from './dispatch.js';
import { registerDispatchAdapter } from './runtime-adapter-registry.js';
import * as store from './store.js';
import * as thread from './thread.js';
import type {
  DispatchAdapter,
  DispatchAdapterExecutionInput,
  DispatchAdapterExecutionResult,
} from './runtime-adapter-contracts.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-dispatch-core-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('dispatch core module', () => {
  it('creates idempotent runs and persists a run primitive', () => {
    const first = createRun(workspacePath, {
      actor: 'agent-runner',
      objective: 'Process backlog',
      idempotencyKey: 'same-key',
    });
    const second = createRun(workspacePath, {
      actor: 'agent-runner',
      objective: 'Process backlog duplicate',
      idempotencyKey: 'same-key',
    });

    expect(second.id).toBe(first.id);

    const runPrimitives = store.list(workspacePath, 'run')
      .filter((instance) => String(instance.fields.run_id) === first.id);
    expect(runPrimitives).toHaveLength(1);

    const queuedRuns = listRuns(workspacePath, { status: 'queued' });
    expect(queuedRuns.some((entry) => entry.id === first.id)).toBe(true);
  });

  it('records followup without implicitly starting queued runs and blocks followup after stop', () => {
    const created = createRun(workspacePath, {
      actor: 'agent-op',
      objective: 'Prepare deployment',
    });

    const followed = followup(workspacePath, created.id, 'agent-op', 'Start execution');
    expect(followed.status).toBe('queued');
    expect(followed.followups).toHaveLength(1);
    expect(followed.leaseExpires).toBeUndefined();

    const stopped = stop(workspacePath, created.id, 'agent-op');
    expect(stopped.status).toBe('cancelled');

    expect(() => followup(workspacePath, created.id, 'agent-op', 'Retry')).toThrow(
      `Cannot send follow-up to run ${created.id} in terminal status "cancelled".`,
    );
  });

  it('enforces heartbeat state and extends lease for running runs', () => {
    const created = createRun(workspacePath, {
      actor: 'agent-lease',
      objective: 'Long-running check',
    });

    expect(() =>
      heartbeat(workspacePath, created.id, { actor: 'agent-lease', leaseMinutes: 5 }),
    ).toThrow('Only running runs may heartbeat.');

    markRun(workspacePath, created.id, 'agent-lease', 'running');
    const touched = heartbeat(workspacePath, created.id, {
      actor: 'agent-lease',
      leaseMinutes: 5,
    });
    expect(touched.heartbeats).toHaveLength(1);
    expect(touched.leaseDurationMinutes).toBe(5);
    expect(Date.parse(String(touched.leaseExpires))).toBeGreaterThan(Date.now());
  });

  it('requeues expired running leases during reconcile', () => {
    const run = createRun(workspacePath, {
      actor: 'agent-ops',
      objective: 'Lease reconcile target',
    });
    markRun(workspacePath, run.id, 'agent-ops', 'running');

    const dispatchStatePath = path.join(workspacePath, '.workgraph', 'dispatch-runs.json');
    const state = JSON.parse(fs.readFileSync(dispatchStatePath, 'utf-8')) as {
      version: number;
      runs: Array<Record<string, unknown>>;
    };
    const target = state.runs.find((entry) => entry.id === run.id);
    expect(target).toBeDefined();
    target!.status = 'running';
    target!.leaseExpires = '2001-01-01T00:00:00.000Z';
    fs.writeFileSync(dispatchStatePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');

    const reconciled = reconcileExpiredLeases(workspacePath, 'agent-ops');
    expect(reconciled.requeuedRuns.map((entry) => entry.id)).toContain(run.id);

    const after = status(workspacePath, run.id);
    expect(after.status).toBe('queued');
    expect(after.leaseExpires).toBeUndefined();
  });

  it('claims thread refs and rejects gate-blocked claims', () => {
    thread.createThread(workspacePath, 'Claimable', 'Ready for claim', 'agent-seed');
    const claimed = claimThread(workspacePath, 'claimable', 'agent-claim');
    expect(claimed.thread.path).toBe('threads/claimable.md');
    expect(claimed.gateCheck.allowed).toBe(true);

    store.create(
      workspacePath,
      'policy-gate',
      {
        title: 'Need readiness fact',
        status: 'active',
        required_facts: ['facts/readiness.md'],
        required_approvals: [],
        min_age_seconds: 0,
      },
      'Gate requiring readiness fact.',
      'agent-policy',
    );
    store.create(
      workspacePath,
      'thread',
      {
        title: 'Guarded task',
        goal: 'Blocked by gate',
        status: 'open',
        priority: 'medium',
        deps: [],
        context_refs: [],
        tags: [],
        gates: ['policy-gates/need-readiness-fact.md'],
        approvals: [],
      },
      'Cannot be claimed until gate passes.',
      'agent-policy',
    );

    expect(() => claimThread(workspacePath, 'guarded-task', 'agent-claim')).toThrow(
      'Quality gates blocked claim',
    );
  });

  it('executes runs through registered adapter and stores output/metrics', async () => {
    registerDispatchAdapter('test-exec-success', () =>
      makeAdapter(async (input) => ({
        status: 'succeeded',
        output: `done:${input.objective}`,
        logs: [{
          ts: new Date().toISOString(),
          level: 'info',
          message: 'adapter execution complete',
        }],
        metrics: { steps: 3 },
      })),
    );

    const run = createRun(workspacePath, {
      actor: 'agent-exec',
      adapter: 'test-exec-success',
      objective: 'Adapter execution objective',
    });
    const finished = await executeRun(workspacePath, run.id, { actor: 'agent-exec' });

    expect(finished.status).toBe('succeeded');
    expect(finished.output).toBe('done:Adapter execution objective');
    expect(finished.context?.adapter_metrics).toEqual({ steps: 3 });
    expect(finished.logs.some((entry) => entry.message.includes('adapter execution complete'))).toBe(true);
  });

  it('supports createAndExecuteRun convenience helper', async () => {
    registerDispatchAdapter('test-create-and-exec', () =>
      makeAdapter(async () => ({
        status: 'failed',
        error: 'synthetic failure',
        logs: [{
          ts: new Date().toISOString(),
          level: 'error',
          message: 'run failed from adapter',
        }],
      })),
    );

    const finished = await createAndExecuteRun(workspacePath, {
      actor: 'agent-helper',
      adapter: 'test-create-and-exec',
      objective: 'Combined create+execute',
    });

    expect(finished.status).toBe('failed');
    expect(finished.error).toBe('synthetic failure');
  });

  it('rejects adapters without execute or with non-terminal execute result', async () => {
    registerDispatchAdapter('test-no-exec', () =>
      makeAdapter(undefined),
    );
    const noExec = createRun(workspacePath, {
      actor: 'agent-adapter',
      adapter: 'test-no-exec',
      objective: 'No execute adapter',
    });
    await expect(
      executeRun(workspacePath, noExec.id, { actor: 'agent-adapter' }),
    ).rejects.toThrow('does not implement execute()');

    registerDispatchAdapter('test-invalid-terminal', () =>
      makeAdapter(async () => ({
        status: 'running',
        logs: [{
          ts: new Date().toISOString(),
          level: 'warn',
          message: 'still running',
        }],
      })),
    );
    const invalid = createRun(workspacePath, {
      actor: 'agent-adapter',
      adapter: 'test-invalid-terminal',
      objective: 'Bad terminal status',
    });
    await expect(
      executeRun(workspacePath, invalid.id, { actor: 'agent-adapter' }),
    ).rejects.toThrow('invalid terminal status "running"');
  });
});

function makeAdapter(
  executeImpl?: (input: DispatchAdapterExecutionInput) => Promise<DispatchAdapterExecutionResult>,
): DispatchAdapter {
  return {
    name: 'test-adapter',
    async create() {
      return { runId: 'external-run', status: 'queued' };
    },
    async status(runId: string) {
      return { runId, status: 'running' };
    },
    async followup(runId: string) {
      return { runId, status: 'running' };
    },
    async stop(runId: string) {
      return { runId, status: 'cancelled' };
    },
    async logs() {
      return [];
    },
    ...(executeImpl ? { execute: executeImpl } : {}),
  };
}
