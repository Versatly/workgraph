import {
  runtimeAdapterRegistry,
} from '@versatly/workgraph-kernel';
import { ClaudeCodeAdapter } from '@versatly/workgraph-adapter-claude-code';
import { CursorCloudAdapter } from '@versatly/workgraph-adapter-cursor-cloud';
import { HttpWebhookAdapter } from '@versatly/workgraph-adapter-http-webhook';
import { ShellWorkerAdapter } from '@versatly/workgraph-adapter-shell-worker';

export function registerDefaultDispatchAdaptersIntoKernelRegistry(): string[] {
  runtimeAdapterRegistry.registerDispatchAdapter('claude-code', () => new ClaudeCodeAdapter());
  runtimeAdapterRegistry.registerDispatchAdapter('cursor-cloud', () => new CursorCloudAdapter());
  runtimeAdapterRegistry.registerDispatchAdapter('http-webhook', () => new HttpWebhookAdapter());
  runtimeAdapterRegistry.registerDispatchAdapter('shell-worker', () => new ShellWorkerAdapter());
  return runtimeAdapterRegistry.listDispatchAdapters();
}
