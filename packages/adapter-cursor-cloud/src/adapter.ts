import type { DispatchAdapter, DispatchAdapterCreateInput, DispatchAdapterRunStatus } from '../../runtime-adapter-core/src/contracts.js';

/**
 * MVP cursor-cloud adapter stub.
 * This preserves the contract surface while runtime transport is integrated.
 */
export class CursorCloudAdapter implements DispatchAdapter {
  name = 'cursor-cloud';

  async create(_input: DispatchAdapterCreateInput): Promise<DispatchAdapterRunStatus> {
    return { runId: 'stub-run', status: 'queued' };
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

  async logs(runId: string): Promise<Array<{ ts: string; level: 'info' | 'warn' | 'error'; message: string }>> {
    return [{
      ts: new Date().toISOString(),
      level: 'info',
      message: `Cursor Cloud adapter stub logs for ${runId}`,
    }];
  }
}
