/**
 * Trigger-to-run dispatch helpers.
 */

import { createHash } from 'node:crypto';
import * as dispatch from './dispatch.js';
import * as ledger from './ledger.js';
import * as store from './store.js';
import type { DispatchRun } from './types.js';

export interface FireTriggerOptions {
  actor: string;
  eventKey?: string;
  objective?: string;
  adapter?: string;
  context?: Record<string, unknown>;
}

export interface FireTriggerResult {
  triggerPath: string;
  run: DispatchRun;
  idempotencyKey: string;
}

export interface FireTriggerAndExecuteOptions extends FireTriggerOptions {
  execute?: boolean;
  retryFailed?: boolean;
  executeInput?: Omit<dispatch.DispatchExecuteInput, 'actor'>;
  retryInput?: Omit<dispatch.DispatchRetryInput, 'actor'>;
}

export interface FireTriggerAndExecuteResult extends FireTriggerResult {
  executed: boolean;
  retriedFromRunId?: string;
}

export function fireTrigger(
  workspacePath: string,
  triggerPath: string,
  options: FireTriggerOptions,
): FireTriggerResult {
  const trigger = store.read(workspacePath, triggerPath);
  if (!trigger) throw new Error(`Trigger not found: ${triggerPath}`);
  if (trigger.type !== 'trigger') throw new Error(`Target is not a trigger primitive: ${triggerPath}`);

  const triggerStatus = String(trigger.fields.status ?? 'draft');
  if (!['approved', 'active'].includes(triggerStatus)) {
    throw new Error(`Trigger must be approved/active to fire. Current status: ${triggerStatus}`);
  }

  const objective = options.objective
    ?? `Trigger ${String(trigger.fields.title ?? triggerPath)} fired action ${String(trigger.fields.action ?? 'run')}`;
  const eventSeed = options.eventKey ?? new Date().toISOString();
  const idempotencyKey = buildIdempotencyKey(triggerPath, eventSeed, objective);

  const run = dispatch.createRun(workspacePath, {
    actor: options.actor,
    adapter: options.adapter,
    objective,
    context: {
      trigger_path: triggerPath,
      trigger_event: String(trigger.fields.event ?? ''),
      ...options.context,
    },
    idempotencyKey,
  });

  ledger.append(workspacePath, options.actor, 'create', triggerPath, 'trigger', {
    fired: true,
    event_key: eventSeed,
    run_id: run.id,
    idempotency_key: idempotencyKey,
  });

  return {
    triggerPath,
    run,
    idempotencyKey,
  };
}

export async function fireTriggerAndExecute(
  workspacePath: string,
  triggerPath: string,
  options: FireTriggerAndExecuteOptions,
): Promise<FireTriggerAndExecuteResult> {
  const fired = fireTrigger(workspacePath, triggerPath, options);
  if (options.execute === false) {
    return {
      ...fired,
      executed: false,
    };
  }

  if (fired.run.status === 'failed' && options.retryFailed) {
    const retried = await dispatch.retryRun(workspacePath, fired.run.id, {
      actor: options.actor,
      ...(options.retryInput ?? {}),
    });
    return {
      triggerPath: fired.triggerPath,
      idempotencyKey: fired.idempotencyKey,
      run: retried,
      executed: true,
      retriedFromRunId: fired.run.id,
    };
  }

  if (fired.run.status === 'queued' || fired.run.status === 'running') {
    const executed = await dispatch.executeRun(workspacePath, fired.run.id, {
      actor: options.actor,
      ...(options.executeInput ?? {}),
    });
    return {
      triggerPath: fired.triggerPath,
      idempotencyKey: fired.idempotencyKey,
      run: executed,
      executed: true,
    };
  }

  return {
    ...fired,
    executed: false,
  };
}

function buildIdempotencyKey(triggerPath: string, eventSeed: string, objective: string): string {
  return createHash('sha256')
    .update(`${triggerPath}:${eventSeed}:${objective}`)
    .digest('hex')
    .slice(0, 32);
}
