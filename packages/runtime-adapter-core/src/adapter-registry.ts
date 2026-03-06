import { runtimeAdapterRegistry } from '@versatly/workgraph-kernel';
import type { DispatchAdapter } from './contracts.js';
import { ShellSubprocessAdapter } from './shell-adapter.js';
import { WebhookDispatchAdapter } from './webhook-adapter.js';

export type DispatchAdapterFactory = () => DispatchAdapter;

const adapterFactories = new Map<string, DispatchAdapterFactory>([
  ['shell-subprocess', () => new ShellSubprocessAdapter()],
  ['webhook', () => new WebhookDispatchAdapter()],
]);

export function registerDispatchAdapter(name: string, factory: DispatchAdapterFactory): void {
  const safeName = normalizeName(name);
  if (!safeName) {
    throw new Error('Adapter name must be a non-empty string.');
  }
  adapterFactories.set(safeName, factory);
}

export function findDispatchAdapter(name: string): DispatchAdapter | undefined {
  const safeName = normalizeName(name);
  if (!safeName) return undefined;
  const factory = adapterFactories.get(safeName);
  return factory ? factory() : undefined;
}

export function resolveDispatchAdapter(name: string): DispatchAdapter {
  const safeName = normalizeName(name);
  const adapter = findDispatchAdapter(safeName);
  if (!adapter) {
    throw new Error(`Unknown dispatch adapter "${name}". Registered adapters: ${listDispatchAdapters().join(', ') || 'none'}.`);
  }
  return adapter;
}

export function listDispatchAdapters(): string[] {
  return [...adapterFactories.keys()].sort((a, b) => a.localeCompare(b));
}

export function registerDispatchAdaptersIntoKernelRegistry(): string[] {
  const registered = listDispatchAdapters();
  for (const name of registered) {
    runtimeAdapterRegistry.registerDispatchAdapter(name, () => resolveDispatchAdapter(name));
  }
  return registered;
}

function normalizeName(name: string): string {
  return String(name || '').trim().toLowerCase();
}
