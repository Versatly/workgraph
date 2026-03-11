import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as dispatch from '../dispatch.js';
import * as federation from '../federation.js';
import { saveRegistry, loadRegistry } from '../registry.js';
import * as store from '../store.js';
import * as thread from '../thread.js';
import * as transport from '../transport/index.js';
import * as projections from './index.js';

let workspacePath: string;
let remoteWorkspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-projections-'));
  remoteWorkspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-projections-remote-'));
  saveRegistry(workspacePath, loadRegistry(workspacePath));
  saveRegistry(remoteWorkspacePath, loadRegistry(remoteWorkspacePath));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
  fs.rmSync(remoteWorkspacePath, { recursive: true, force: true });
});

describe('projection builders', () => {
  it('builds stable run, risk, transport, federation, trigger, and autonomy projections', () => {
    const blockedThread = thread.createThread(workspacePath, 'Blocked projection thread', 'blocked work', 'agent-a');
    thread.claim(workspacePath, blockedThread.path, 'agent-a');
    thread.block(workspacePath, blockedThread.path, 'agent-a', 'external/dependency', 'waiting');

    const run = dispatch.createRun(workspacePath, {
      actor: 'agent-a',
      objective: 'Projection run',
    });
    dispatch.markRun(workspacePath, run.id, 'agent-a', 'running');
    dispatch.markRun(workspacePath, run.id, 'agent-a', 'failed', {
      error: 'failed run',
    });

    const envelope = transport.createTransportEnvelope({
      direction: 'outbound',
      channel: 'test',
      topic: 'projection',
      source: 'test',
      target: 'target',
      payload: {
        ok: true,
      },
    });
    const outbox = transport.createTransportOutboxRecord(workspacePath, {
      envelope,
      deliveryHandler: 'test',
      deliveryTarget: 'target',
    });
    transport.markTransportOutboxFailed(workspacePath, outbox.id, {
      message: 'delivery failed',
    });

    federation.ensureFederationConfig(remoteWorkspacePath);
    thread.createThread(remoteWorkspacePath, 'Remote projection thread', 'remote work', 'agent-remote');
    federation.addRemoteWorkspace(workspacePath, {
      id: 'remote-main',
      path: remoteWorkspacePath,
    });

    store.create(workspacePath, 'trigger', {
      title: 'Projection trigger',
      status: 'active',
      condition: { type: 'manual' },
      action: {
        type: 'dispatch-run',
        objective: 'Projection trigger run',
      },
      cooldown: 0,
    }, '# Trigger\n', 'system');

    const runHealth = projections.buildRunHealthProjection(workspacePath);
    expect(runHealth.summary.totalRuns).toBeGreaterThan(0);

    const risk = projections.buildRiskDashboardProjection(workspacePath);
    expect(risk.summary.blockedThreads).toBeGreaterThan(0);

    const transportHealth = projections.buildTransportHealthProjection(workspacePath);
    expect(transportHealth.summary.deadLetterCount).toBe(1);

    const federationStatus = projections.buildFederationStatusProjection(workspacePath);
    expect(federationStatus.summary.remotes).toBe(1);

    const triggerHealth = projections.buildTriggerHealthProjection(workspacePath);
    expect(triggerHealth.summary.totalTriggers).toBe(1);

    const autonomyHealth = projections.buildAutonomyHealthProjection(workspacePath);
    expect(typeof autonomyHealth.summary.running).toBe('boolean');
  });
});
