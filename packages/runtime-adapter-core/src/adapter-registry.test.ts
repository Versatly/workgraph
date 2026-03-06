import { describe, expect, it, vi } from 'vitest';
import type { DispatchAdapter } from './contracts.js';
import {
  findDispatchAdapter,
  listDispatchAdapters,
  registerDispatchAdapter,
  registerDispatchAdaptersIntoKernelRegistry,
  resolveDispatchAdapter,
} from './adapter-registry.js';

let customCounter = 0;

function nextAdapterName(): string {
  customCounter += 1;
  return `runtime-core-custom-${customCounter}`;
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

describe('runtime adapter core registry', () => {
  it('lists built-in adapters in sorted order', () => {
    const names = listDispatchAdapters();
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names).toEqual(expect.arrayContaining([
      'shell-subprocess',
      'webhook',
    ]));
  });

  it('finds and resolves built-in adapters with normalized names', () => {
    const found = findDispatchAdapter('  WEBHOOK ');
    const resolved = resolveDispatchAdapter(' shell-subprocess ');

    expect(found?.name).toBe('webhook');
    expect(resolved.name).toBe('shell-subprocess');
  });

  it('registers and resolves custom adapters through normalized names', () => {
    const adapterName = nextAdapterName();
    const factory = vi.fn(() => makeAdapter(adapterName));

    registerDispatchAdapter(`  ${adapterName.toUpperCase()} `, factory);
    const resolvedA = resolveDispatchAdapter(adapterName);
    const resolvedB = findDispatchAdapter(` ${adapterName.toUpperCase()} `);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(resolvedA.name).toBe(adapterName);
    expect(resolvedB?.name).toBe(adapterName);
    expect(listDispatchAdapters()).toContain(adapterName);
  });

  it('throws a helpful error for unknown adapters', () => {
    expect(() => resolveDispatchAdapter('adapter-that-does-not-exist')).toThrow(
      'Unknown dispatch adapter "adapter-that-does-not-exist".',
    );
  });

  it('registers all adapters into kernel runtime registry', () => {
    const registered = registerDispatchAdaptersIntoKernelRegistry();
    expect(registered).toEqual(expect.arrayContaining(['shell-subprocess', 'webhook']));
  });
});
