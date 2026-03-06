import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadRegistry, saveRegistry } from './registry.js';
import {
  auditTrail,
  createRun,
  executeRun,
  listRunEvidence,
  retryRun,
} from './dispatch.js';
import { registerDispatchAdapter } from './runtime-adapter-registry.js';
import type { DispatchAdapter, DispatchAdapterExecutionInput, DispatchAdapterExecutionResult } from './runtime-adapter-contracts.js';

let workspacePath: string;
let gitAvailable = false;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-dispatch-evidence-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
  const gitInit = spawnSync('git', ['init'], {
    cwd: workspacePath,
    stdio: 'ignore',
  });
  gitAvailable = (gitInit.status ?? 1) === 0;
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('dispatch run evidence loop', () => {
  it('captures immutable audit trail and execution evidence', async () => {
    const command = `"${process.execPath}" -e "const fs=require('fs'); fs.mkdirSync('artifacts',{recursive:true}); fs.writeFileSync('artifacts/evidence.txt','ok'); console.log('tests: 3 passed, 0 failed'); console.log('proof artifacts/evidence.txt'); console.log('https://github.com/versatly/workgraph/pull/4242');"`;
    const run = createRun(workspacePath, {
      actor: 'agent-evidence',
      adapter: 'shell-worker',
      objective: 'Collect execution evidence',
      context: {
        shell_command: command,
      },
    });

    const executed = await executeRun(workspacePath, run.id, {
      actor: 'agent-evidence',
      timeoutMs: 10_000,
    });

    expect(executed.status).toBe('succeeded');
    expect((executed.evidenceChain?.count ?? 0) > 0).toBe(true);
    expect((executed.audit?.eventCount ?? 0) > 0).toBe(true);

    const evidence = listRunEvidence(workspacePath, run.id);
    const evidenceTypes = new Set(evidence.map((entry) => entry.type));
    expect(evidenceTypes.has('stdout')).toBe(true);
    expect(evidenceTypes.has('test-result')).toBe(true);
    expect(evidenceTypes.has('pr-url')).toBe(true);
    expect(evidenceTypes.has('attachment')).toBe(true);
    if (gitAvailable) {
      expect(evidenceTypes.has('file-change')).toBe(true);
    }

    const trail = auditTrail(workspacePath, run.id);
    expect(trail.some((entry) => entry.kind === 'run-created')).toBe(true);
    expect(trail.some((entry) => entry.kind === 'run-execution-started')).toBe(true);
    expect(trail.some((entry) => entry.kind === 'run-evidence-collected')).toBe(true);
    expect(trail.some((entry) => entry.kind === 'run-execution-finished')).toBe(true);
  });

  it('fails gracefully on execution timeout and records timeout audit event', async () => {
    registerDispatchAdapter('test-timeout-adapter', () =>
      makeAdapter(async () =>
        new Promise<DispatchAdapterExecutionResult>(() => {
          // Intentional never-resolving execution promise to trigger dispatcher timeout.
        })),
    );

    const run = createRun(workspacePath, {
      actor: 'agent-timeout',
      adapter: 'test-timeout-adapter',
      objective: 'Trigger timeout path',
    });

    const finished = await executeRun(workspacePath, run.id, {
      actor: 'agent-timeout',
      timeoutMs: 25,
    });

    expect(finished.status).toBe('failed');
    expect(finished.error).toContain('timed out');
    const trail = auditTrail(workspacePath, run.id);
    expect(trail.some((entry) => entry.kind === 'run-execution-timeout')).toBe(true);
  });

  it('retries failed runs into a new attempt', async () => {
    registerDispatchAdapter('test-retry-adapter', () =>
      makeAdapter(async (input) => {
        if (input.context?.retry_attempt) {
          return {
            status: 'succeeded',
            output: 'retry succeeded',
            logs: [],
          };
        }
        return {
          status: 'failed',
          error: 'first attempt failed',
          logs: [],
        };
      }),
    );

    const source = createRun(workspacePath, {
      actor: 'agent-retry',
      adapter: 'test-retry-adapter',
      objective: 'Retry target',
    });
    const failed = await executeRun(workspacePath, source.id, { actor: 'agent-retry' });
    expect(failed.status).toBe('failed');

    const retried = await retryRun(workspacePath, source.id, {
      actor: 'agent-retry',
    });
    expect(retried.id).not.toBe(source.id);
    expect(retried.status).toBe('succeeded');
    expect(retried.context?.retry_of_run_id).toBe(source.id);
    expect(retried.context?.retry_attempt).toBe(1);

    const sourceTrail = auditTrail(workspacePath, source.id);
    expect(sourceTrail.some((entry) => entry.kind === 'run-retried')).toBe(true);
  });
});

function makeAdapter(
  executeImpl: (input: DispatchAdapterExecutionInput) => Promise<DispatchAdapterExecutionResult>,
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
    execute: executeImpl,
  };
}
