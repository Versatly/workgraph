import { describe, expect, it, vi } from 'vitest';
import { registerDefaultDispatchAdaptersIntoKernelRegistry } from '@versatly/workgraph-runtime-adapter-core';
import type { DispatchAdapter } from './runtime-adapter-contracts.js';
import {
  listDispatchAdapters,
  registerDispatchAdapter,
  resolveDispatchAdapter,
} from './runtime-adapter-registry.js';

let customCounter = 0;

function nextAdapterName(): string {
  customCounter += 1;
  return `test-custom-adapter-${customCounter}`;
}

function makeAdapter(name: string): DispatchAdapter {
  return {
    name,
    async create() {
      return { runId: `${name}-run`, status: 'queued' };
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
  };
}

describe('runtime adapter registry', () => {
  it('lists built-in adapters in sorted order', () => {
    registerDefaultDispatchAdaptersIntoKernelRegistry();
    const names = listDispatchAdapters();
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names).toEqual(expect.arrayContaining([
      'claude-code',
      'cursor-cloud',
      'http-webhook',
      'shell-worker',
    ]));
  });

  it('resolves built-in adapters with normalized adapter names', () => {
    registerDefaultDispatchAdaptersIntoKernelRegistry();
    const adapter = resolveDispatchAdapter('  CLAUDE-Code ');
    expect(adapter.name).toBe('claude-code');
  });

  it('registers and resolves custom adapters through normalized names', () => {
    const adapterName = nextAdapterName();
    const factory = vi.fn(() => makeAdapter(adapterName));

    registerDispatchAdapter(`  ${adapterName.toUpperCase()} `, factory);
    const resolvedA = resolveDispatchAdapter(adapterName);
    const resolvedB = resolveDispatchAdapter(` ${adapterName.toUpperCase()} `);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(resolvedA.name).toBe(adapterName);
    expect(resolvedB.name).toBe(adapterName);
    expect(listDispatchAdapters()).toContain(adapterName);
  });

  it('throws a helpful error for unknown adapters', () => {
    expect(() => resolveDispatchAdapter('adapter-that-does-not-exist')).toThrow(
      'Unknown dispatch adapter "adapter-that-does-not-exist".',
    );
  });
});
