import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projections as projectionsModule, registry as registryModule, thread as threadModule } from '@versatly/workgraph-kernel';
import { startWorkgraphServer } from './server.js';

const projections = projectionsModule;
const registry = registryModule;
const thread = threadModule;

let workspacePath: string;

describe('server projection routes', () => {
  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-server-projections-'));
    registry.saveRegistry(workspacePath, registry.loadRegistry(workspacePath));
    thread.createThread(workspacePath, 'Projection thread', 'projection thread goal', 'agent-projection');
  });

  afterEach(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it('serves named projection endpoints over HTTP', async () => {
    const handle = await startWorkgraphServer({
      workspacePath,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const runHealth = await fetch(`${handle.baseUrl}/api/projections/run-health`);
      const runHealthBody = await runHealth.json() as { ok: boolean; projection: ReturnType<typeof projections.buildRunHealthProjection> };
      expect(runHealth.status).toBe(200);
      expect(runHealthBody.ok).toBe(true);
      expect(runHealthBody.projection.scope).toBe('run');

      const overview = await fetch(`${handle.baseUrl}/api/projections/overview`);
      const overviewBody = await overview.json() as { ok: boolean; projection: { projections: Record<string, unknown> } };
      expect(overview.status).toBe(200);
      expect(overviewBody.ok).toBe(true);
      expect(Object.keys(overviewBody.projection.projections)).toEqual(expect.arrayContaining([
        'runHealth',
        'riskDashboard',
        'missionProgress',
        'transportHealth',
        'federationStatus',
        'triggerHealth',
        'autonomyHealth',
      ]));

      const controlPlaneIndex = await fetch(`${handle.baseUrl}/control-plane`);
      expect(controlPlaneIndex.status).toBe(200);
      expect(await controlPlaneIndex.text()).toContain('WorkGraph Operator Control Plane');

      const runHealthPage = await fetch(`${handle.baseUrl}/control-plane/run-health`);
      expect(runHealthPage.status).toBe(200);
      expect(await runHealthPage.text()).toContain('data-projection="run-health"');
    } finally {
      await handle.close();
    }
  });
});
