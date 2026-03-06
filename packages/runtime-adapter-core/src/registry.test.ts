import { describe, expect, it } from 'vitest';
import {
  RuntimeAdapterRegistry,
  createDefaultRuntimeAdapterRegistry,
  toKernelDispatchAdapterName,
} from './registry.js';
import type { RuntimeDispatchAdapter } from './contracts.js';

describe('runtime adapter registry', () => {
  it('resolves built-ins by canonical name and alias', () => {
    const registry = createDefaultRuntimeAdapterRegistry();
    expect(registry.resolve('shell').name).toBe('shell');
    expect(registry.resolve('subprocess').name).toBe('shell');
    expect(registry.resolve('webhook').name).toBe('webhook');
    expect(registry.resolve('http-webhook').name).toBe('webhook');
  });

  it('lists adapters with aliases', () => {
    const registry = createDefaultRuntimeAdapterRegistry();
    const listed = registry.list({ includeAliases: true });
    expect(listed).toEqual([
      { name: 'shell', aliases: ['subprocess', 'shell-worker'] },
      { name: 'webhook', aliases: ['http-webhook'] },
    ]);
  });

  it('supports custom runtime adapter registrations', () => {
    const registry = new RuntimeAdapterRegistry();
    registry.register('custom', (): RuntimeDispatchAdapter => ({
      name: 'custom',
      async create() {
        return { runId: 'custom-run', status: 'queued' };
      },
      async dispatch() {
        return {
          adapter: 'custom',
          runId: 'custom-run',
          status: 'queued',
          startedAt: new Date().toISOString(),
        };
      },
      async status(runId: string) {
        return { runId, status: 'running' };
      },
      async poll(runId: string) {
        const now = new Date().toISOString();
        return {
          runId,
          status: 'running',
          adapter: 'custom',
          startedAt: now,
          updatedAt: now,
        };
      },
      async followup(runId: string) {
        return { runId, status: 'running' };
      },
      async stop(runId: string) {
        return { runId, status: 'cancelled' };
      },
      async cancel(runId: string) {
        const now = new Date().toISOString();
        return {
          runId,
          status: 'cancelled',
          adapter: 'custom',
          startedAt: now,
          updatedAt: now,
        };
      },
      async logs() {
        return [];
      },
      async execute() {
        return { status: 'succeeded', logs: [] };
      },
      async healthCheck() {
        return {
          ok: true,
          adapter: 'custom',
          checkedAt: new Date().toISOString(),
          message: 'ok',
        };
      },
    }), { aliases: ['custom-alias'] });

    expect(registry.resolve('CUSTOM-ALIAS').name).toBe('custom');
  });
});

describe('toKernelDispatchAdapterName', () => {
  it('maps runtime aliases to kernel adapter names', () => {
    expect(toKernelDispatchAdapterName('shell')).toBe('shell-worker');
    expect(toKernelDispatchAdapterName('subprocess')).toBe('shell-worker');
    expect(toKernelDispatchAdapterName('shell-worker')).toBe('shell-worker');
    expect(toKernelDispatchAdapterName('webhook')).toBe('http-webhook');
    expect(toKernelDispatchAdapterName('http-webhook')).toBe('http-webhook');
    expect(toKernelDispatchAdapterName('cursor-cloud')).toBe('cursor-cloud');
    expect(toKernelDispatchAdapterName('claude-code')).toBe('claude-code');
  });
});
