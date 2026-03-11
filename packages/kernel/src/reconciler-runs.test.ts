import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { registerDefaultDispatchAdaptersIntoKernelRegistry } from '@versatly/workgraph-runtime-adapter-core';
import * as dispatch from './dispatch.js';
import * as reconciler from './reconciler.js';
import { loadRegistry, saveRegistry } from './registry.js';

let workspacePath: string;

function mockResponse(options: { ok: boolean; status: number; text: string; statusText?: string }): Response {
  return {
    ok: options.ok,
    status: options.status,
    statusText: options.statusText ?? '',
    text: async () => options.text,
  } as Response;
}

describe('dispatch run reconciler', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-reconciler-runs-'));
    saveRegistry(workspacePath, loadRegistry(workspacePath));
    registerDefaultDispatchAdaptersIntoKernelRegistry();
    vi.restoreAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it('dispatches externally, survives restart, and reconciles to completion', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({
      ok: true,
      status: 202,
      text: JSON.stringify({
        id: 'cursor-agent-123',
        status: 'queued',
      }),
    }));

    const created = dispatch.createRun(workspacePath, {
      actor: 'agent-broker',
      adapter: 'cursor-cloud',
      objective: 'Reconcile external cursor run',
      context: {
        external_broker_mode: true,
        cursor_cloud_api_base_url: 'https://cursor.example/api',
      },
    });

    const dispatched = await dispatch.executeRun(workspacePath, created.id, {
      actor: 'agent-broker',
      timeoutMs: 1_000,
    });

    expect(dispatched.status).toBe('queued');
    expect(dispatched.external?.externalRunId).toBe('cursor-agent-123');
    expect(dispatched.dispatchTracking?.retryCount).toBe(1);

    const brokerPath = path.join(workspacePath, '.workgraph', 'dispatch-broker', `${created.id}.md`);
    expect(fs.existsSync(brokerPath)).toBe(true);
    const brokerParsed = matter(fs.readFileSync(brokerPath, 'utf-8'));
    expect((brokerParsed.data as Record<string, unknown>).external).toMatchObject({
      provider: 'cursor-cloud',
      externalRunId: 'cursor-agent-123',
    });

    const runPrimitivePath = path.join(workspacePath, 'runs', `${created.id}.md`);
    const runPrimitive = matter(fs.readFileSync(runPrimitivePath, 'utf-8'));
    expect((runPrimitive.data as Record<string, unknown>).external).toMatchObject({
      provider: 'cursor-cloud',
      externalRunId: 'cursor-agent-123',
    });

    const restarted = dispatch.status(workspacePath, created.id);
    expect(restarted.external?.externalRunId).toBe('cursor-agent-123');
    expect(restarted.status).toBe('queued');

    fetchMock.mockResolvedValueOnce(mockResponse({
      ok: true,
      status: 200,
      text: JSON.stringify({
        status: 'succeeded',
        output: 'external reconciliation complete',
        updatedAt: '2026-03-11T10:00:00.000Z',
      }),
    }));

    const reconciled = await reconciler.reconcileDispatchRuns(workspacePath, 'agent-broker', {
      runId: created.id,
    });

    expect(reconciled.external.inspectedRuns).toBe(1);
    expect(reconciled.external.reconciledRuns[0]?.id).toBe(created.id);

    const finished = dispatch.status(workspacePath, created.id);
    expect(finished.status).toBe('succeeded');
    expect(finished.output).toBe('external reconciliation complete');
    expect(finished.external?.lastKnownStatus).toBe('succeeded');
    expect(finished.dispatchTracking?.lastReconciledAt).toBeTruthy();

    const refreshedPrimitive = matter(fs.readFileSync(runPrimitivePath, 'utf-8'));
    expect((refreshedPrimitive.data as Record<string, unknown>).status).toBe('succeeded');
    expect((refreshedPrimitive.data as Record<string, unknown>).external).toMatchObject({
      provider: 'cursor-cloud',
      externalRunId: 'cursor-agent-123',
      lastKnownStatus: 'succeeded',
    });
  });

  it('records cancellation requests durably and reconciles cancellation acknowledgements', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({
      ok: true,
      status: 202,
      text: JSON.stringify({
        id: 'cursor-agent-cancel-1',
        status: 'running',
      }),
    }));

    const created = dispatch.createRun(workspacePath, {
      actor: 'agent-broker',
      adapter: 'cursor-cloud',
      objective: 'Cancel external cursor run',
      context: {
        external_broker_mode: true,
        cursor_cloud_api_base_url: 'https://cursor.example/api',
      },
    });

    await dispatch.executeRun(workspacePath, created.id, {
      actor: 'agent-broker',
      timeoutMs: 1_000,
    });

    fetchMock.mockResolvedValueOnce(mockResponse({
      ok: true,
      status: 202,
      text: JSON.stringify({
        status: 'cancelled',
      }),
    }));

    const requested = dispatch.stop(workspacePath, created.id, 'agent-broker');
    expect(requested.dispatchTracking?.cancellationRequestedAt).toBeTruthy();

    await vi.waitFor(() => {
      expect(dispatch.status(workspacePath, created.id).status).toBe('cancelled');
    });

    const cancelled = dispatch.status(workspacePath, created.id);
    expect(cancelled.dispatchTracking?.cancellationAcknowledgedAt).toBeTruthy();
    expect(cancelled.status).toBe('cancelled');
  });

  it('matches inbound external reconciliation payloads by provider and external run id', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({
      ok: true,
      status: 202,
      text: JSON.stringify({
        id: 'cursor-agent-match-1',
        status: 'queued',
      }),
    }));

    const created = dispatch.createRun(workspacePath, {
      actor: 'agent-broker',
      adapter: 'cursor-cloud',
      objective: 'Match inbound external event',
      context: {
        external_broker_mode: true,
        cursor_cloud_api_base_url: 'https://cursor.example/api',
      },
    });

    await dispatch.executeRun(workspacePath, created.id, {
      actor: 'agent-broker',
      timeoutMs: 1_000,
    });

    const reconciled = dispatch.reconcileExternalRun(workspacePath, {
      actor: 'agent-broker',
      provider: 'cursor-cloud',
      externalRunId: 'cursor-agent-match-1',
      status: 'failed',
      error: 'provider reported failure',
      source: 'event',
    });

    expect(reconciled.matchedRunId).toBe(created.id);
    expect(reconciled.currentStatus).toBe('failed');
    expect(dispatch.status(workspacePath, created.id).error).toBe('provider reported failure');
  });
});
