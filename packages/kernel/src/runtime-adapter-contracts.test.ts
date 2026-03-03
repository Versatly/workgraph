import { describe, expect, expectTypeOf, it } from 'vitest';
import type { RunStatus } from './types.js';
import type {
  DispatchAdapter,
  DispatchAdapterExecutionInput,
  DispatchAdapterExecutionResult,
  DispatchAdapterRunStatus,
} from './runtime-adapter-contracts.js';

function makeExecutionInput(overrides: Partial<DispatchAdapterExecutionInput> = {}): DispatchAdapterExecutionInput {
  return {
    workspacePath: '/workspace/demo',
    runId: 'run-contracts-1',
    actor: 'agent-contracts',
    objective: 'Validate adapter contract',
    context: {
      source: 'unit-test',
    },
    ...overrides,
  };
}

describe('runtime adapter contracts', () => {
  it('keeps dispatch run status aligned with shared RunStatus type', () => {
    expectTypeOf<DispatchAdapterRunStatus['status']>().toEqualTypeOf<RunStatus>();
  });

  it('supports fully typed adapter implementations at runtime', async () => {
    const adapter: DispatchAdapter = {
      name: 'contract-test',
      async create(input) {
        return {
          runId: `${input.actor}-run`,
          status: 'queued',
        };
      },
      async status(runId) {
        return { runId, status: 'running' };
      },
      async followup(runId) {
        return { runId, status: 'running' };
      },
      async stop(runId) {
        return { runId, status: 'cancelled' };
      },
      async logs() {
        return [
          {
            ts: '2026-01-01T00:00:00.000Z',
            level: 'info',
            message: 'log entry',
          },
        ];
      },
      async execute(input): Promise<DispatchAdapterExecutionResult> {
        return {
          status: 'succeeded',
          output: `${input.actor}:${input.objective}`,
          logs: [
            {
              ts: '2026-01-01T00:00:01.000Z',
              level: 'info',
              message: `executed ${input.runId}`,
            },
          ],
          metrics: {
            adapter: 'contract-test',
          },
        };
      },
    };

    const input = makeExecutionInput();
    const created = await adapter.create({ actor: input.actor, objective: input.objective, context: input.context });
    const followed = await adapter.followup(created.runId, input.actor, 'continue');
    const stopped = await adapter.stop(created.runId, input.actor);
    const logs = await adapter.logs(created.runId);
    const result = await adapter.execute!(input);

    expect(created.status).toBe('queued');
    expect(followed.status).toBe('running');
    expect(stopped.status).toBe('cancelled');
    expect(logs[0]?.level).toBe('info');
    expect(result.status).toBe('succeeded');
    expect(result.output).toContain('agent-contracts:Validate adapter contract');
    expect(result.metrics?.adapter).toBe('contract-test');
  });
});
