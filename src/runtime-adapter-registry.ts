import { CursorCloudAdapter } from './adapter-cursor-cloud.js';
import { HttpWebhookAdapter } from './adapter-http-webhook.js';
import { ShellWorkerAdapter } from './adapter-shell-worker.js';
import type { DispatchAdapter } from './runtime-adapter-contracts.js';

type DispatchAdapterFactory = () => DispatchAdapter;

const adapterFactories = new Map<string, DispatchAdapterFactory>([
  ['cursor-cloud', () => new CursorCloudAdapter()],
  ['shell-worker', () => new ShellWorkerAdapter()],
  ['http-webhook', () => new HttpWebhookAdapter()],
]);

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
