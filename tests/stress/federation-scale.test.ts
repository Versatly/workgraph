import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  federation as federationModule,
  registry as registryModule,
  store as storeModule,
  thread as threadModule,
} from '@versatly/workgraph-kernel';

const federation = federationModule;
const registry = registryModule;
const store = storeModule;
const thread = threadModule;

let rootWorkspacePath: string;
let remoteWorkspacePaths: string[];

beforeEach(() => {
  rootWorkspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-stress-federation-root-'));
  registry.saveRegistry(rootWorkspacePath, registry.loadRegistry(rootWorkspacePath));
  remoteWorkspacePaths = [];
});

afterEach(() => {
  fs.rmSync(rootWorkspacePath, { recursive: true, force: true });
  for (const remotePath of remoteWorkspacePaths) {
    fs.rmSync(remotePath, { recursive: true, force: true });
  }
});

describe('stress: federation at scale', () => {
  it('supports 20 remotes, 100+ cross-links, and federated search consistency', { timeout: 30_000 }, () => {
    const remoteCount = 20;
    const threadsPerRemote = 8;
    const localThreadCount = 120;

    const remotes = Array.from({ length: remoteCount }, (_value, idx) => {
      const remotePath = fs.mkdtempSync(path.join(os.tmpdir(), `wg-stress-federation-remote-${idx}-`));
      remoteWorkspacePaths.push(remotePath);
      registry.saveRegistry(remotePath, registry.loadRegistry(remotePath));

      for (let threadIdx = 0; threadIdx < threadsPerRemote; threadIdx += 1) {
        thread.createThread(
          remotePath,
          `Remote ${idx} thread ${threadIdx}`,
          `Federated scale keyword remote-${idx} item-${threadIdx}.`,
          `remote-agent-${idx}`,
        );
      }

      const remoteId = `remote-${idx}`;
      federation.addRemoteWorkspace(rootWorkspacePath, {
        id: remoteId,
        path: remotePath,
        name: `Remote ${idx}`,
        tags: ['stress', 'federation'],
      });
      const remoteThreads = store.list(remotePath, 'thread').map((entry) => entry.path);
      return {
        id: remoteId,
        path: remotePath,
        threadPaths: remoteThreads,
      };
    });

    const localThreads = Array.from({ length: localThreadCount }, (_value, idx) =>
      thread.createThread(
        rootWorkspacePath,
        `Local federated thread ${idx}`,
        `Local side federated workload ${idx}.`,
        'local-agent',
      ));

    for (const [idx, localThread] of localThreads.entries()) {
      const remote = remotes[idx % remotes.length];
      const remoteThreadPath = remote.threadPaths[idx % remote.threadPaths.length];
      federation.linkThreadToRemoteWorkspace(
        rootWorkspacePath,
        localThread.path,
        remote.id,
        remoteThreadPath,
        'local-agent',
      );
    }

    const federatedSearch = federation.searchFederated(rootWorkspacePath, 'federated scale keyword', {
      type: 'thread',
      includeLocal: true,
    });
    expect(federatedSearch.errors).toEqual([]);
    expect(federatedSearch.results.length).toBeGreaterThanOrEqual(remoteCount * threadsPerRemote);

    const remoteResultIds = new Set(
      federatedSearch.results
        .map((entry) => entry.workspaceId)
        .filter((workspaceId) => workspaceId !== 'local'),
    );
    expect(remoteResultIds.size).toBe(remoteCount);

    const localThreadInstances = store.list(rootWorkspacePath, 'thread');
    let linkedCount = 0;
    for (const localThread of localThreadInstances) {
      const links = Array.isArray(localThread.fields.federation_links)
        ? localThread.fields.federation_links.map((entry) => String(entry))
        : [];
      for (const link of links) {
        const parsed = parseFederationLink(link);
        expect(parsed).not.toBeNull();
        const remote = remotes.find((entry) => entry.id === parsed!.remoteId);
        expect(remote).toBeDefined();
        const target = store.read(remote!.path, parsed!.remoteThreadPath);
        expect(target?.type).toBe('thread');
        linkedCount += 1;
      }
    }
    expect(linkedCount).toBeGreaterThanOrEqual(100);
  });
});

function parseFederationLink(link: string): { remoteId: string; remoteThreadPath: string } | null {
  const prefix = 'federation://';
  if (!link.startsWith(prefix)) return null;
  const payload = link.slice(prefix.length);
  const firstSlash = payload.indexOf('/');
  if (firstSlash <= 0) return null;
  const remoteId = payload.slice(0, firstSlash);
  const remoteThreadPath = payload.slice(firstSlash + 1);
  if (!remoteId || !remoteThreadPath) return null;
  return { remoteId, remoteThreadPath };
}
