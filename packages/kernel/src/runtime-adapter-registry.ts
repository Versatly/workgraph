import type { DispatchAdapter } from './runtime-adapter-contracts.js';

type DispatchAdapterFactory = () => DispatchAdapter;

const adapterFactories = new Map<string, DispatchAdapterFactory>();

export function registerDispatchAdapter(name: string, factory: DispatchAdapterFactory): void {
  const safeName = normalizeName(name);
  adapterFactories.set(safeName, factory);
}

export function resolveDispatchAdapter(name: string): DispatchAdapter {
  const safeName = normalizeName(name);
  const factory = adapterFactories.get(safeName);
  if (!factory) {
    throw new Error(`Unknown dispatch adapter "${name}". Registered adapters: ${listDispatchAdapters().join(', ') || 'none'}.`);
  }
  return factory();
}

export function listDispatchAdapters(): string[] {
  return [...adapterFactories.keys()].sort((a, b) => a.localeCompare(b));
}

function normalizeName(name: string): string {
  return String(name || '').trim().toLowerCase();
}
