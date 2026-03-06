import type { RuntimeDispatchAdapter } from './contracts.js';
import { ShellSubprocessAdapter } from './shell-subprocess-adapter.js';
import { WebhookAdapter } from './webhook-adapter.js';

type RuntimeAdapterFactory = () => RuntimeDispatchAdapter;

interface RuntimeAdapterEntry {
  name: string;
  aliases: string[];
  factory: RuntimeAdapterFactory;
}

export interface RuntimeAdapterListItem {
  name: string;
  aliases: string[];
}

export class RuntimeAdapterRegistry {
  private readonly entries = new Map<string, RuntimeAdapterEntry>();
  private readonly aliases = new Map<string, string>();

  register(name: string, factory: RuntimeAdapterFactory, options: { aliases?: string[] } = {}): void {
    const canonicalName = normalizeName(name);
    const aliases = [...new Set((options.aliases ?? []).map(normalizeName).filter(Boolean))]
      .filter((alias) => alias !== canonicalName);
    this.entries.set(canonicalName, {
      name: canonicalName,
      aliases,
      factory,
    });
    this.aliases.set(canonicalName, canonicalName);
    for (const alias of aliases) {
      this.aliases.set(alias, canonicalName);
    }
  }

  resolve(name: string): RuntimeDispatchAdapter {
    const canonicalName = this.resolveCanonicalName(name);
    const entry = this.entries.get(canonicalName);
    if (!entry) {
      throw new Error(`Unknown runtime adapter "${name}". Available adapters: ${this.list().map((item) => item.name).join(', ')}.`);
    }
    return entry.factory();
  }

  resolveCanonicalName(name: string): string {
    const normalized = normalizeName(name);
    return this.aliases.get(normalized) ?? normalized;
  }

  list(options: { includeAliases?: boolean } = {}): RuntimeAdapterListItem[] {
    const includeAliases = options.includeAliases === true;
    return [...this.entries.values()]
      .map((entry) => ({
        name: entry.name,
        aliases: includeAliases ? [...entry.aliases] : [],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

export function createDefaultRuntimeAdapterRegistry(): RuntimeAdapterRegistry {
  const registry = new RuntimeAdapterRegistry();
  registry.register('shell', () => new ShellSubprocessAdapter(), {
    aliases: ['subprocess', 'shell-worker'],
  });
  registry.register('webhook', () => new WebhookAdapter(), {
    aliases: ['http-webhook'],
  });
  return registry;
}

/**
 * Dispatch module in kernel still uses legacy adapter names.
 */
export function toKernelDispatchAdapterName(name: string): string {
  const normalized = normalizeName(name);
  if (normalized === 'shell' || normalized === 'subprocess' || normalized === 'shell-worker') {
    return 'shell-worker';
  }
  if (normalized === 'webhook' || normalized === 'http-webhook') {
    return 'http-webhook';
  }
  if (normalized === 'cursor-cloud') {
    return 'cursor-cloud';
  }
  return normalized;
}

function normalizeName(name: string): string {
  return String(name ?? '').trim().toLowerCase();
}
