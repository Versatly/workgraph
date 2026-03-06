import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadRegistry, saveRegistry } from './registry.js';
import { ensureCliBuiltForTests } from '../../../tests/helpers/cli-build.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-schema-drift-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

beforeAll(() => {
  ensureCliBuiltForTests();
});

describe('schema drift regression', () => {
  it('locks CLI option signatures for critical commands', () => {
    const snapshots = {
      onboard: extractOptionSignatures(runCliHelp(['onboard'])),
      onboardingUpdate: extractOptionSignatures(runCliHelp(['onboarding', 'update', 'onboarding/example.md'])),
      mcpServe: extractOptionSignatures(runCliHelp(['mcp', 'serve'])),
      dispatchExecute: extractOptionSignatures(runCliHelp(['dispatch', 'execute', 'run_123'])),
      triggerFire: extractOptionSignatures(runCliHelp(['trigger', 'fire', 'triggers/example.md'])),
      query: extractOptionSignatures(runCliHelp(['query'])),
      lensList: extractOptionSignatures(runCliHelp(['lens', 'list'])),
      lensShow: extractOptionSignatures(runCliHelp(['lens', 'show', 'my-work'])),
      serverServe: extractOptionSignatures(runCliHelp(['serve'])),
    };

    expect(snapshots).toMatchSnapshot();
  });

  it('locks MCP tool metadata and input schemas', async () => {
    const { createWorkgraphMcpServer } = await loadMcpServerModule();
    const server = createWorkgraphMcpServer({
      workspacePath,
      defaultActor: 'agent-schema',
    });
    const client = new Client({
      name: 'workgraph-schema-drift-client',
      version: '1.0.0',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const listed = await client.listTools();
      const tools = listed.tools
        .map((tool) => ({
          name: tool.name,
          title: tool.title ?? null,
          description: tool.description ?? null,
          annotations: normalizeValue(tool.annotations ?? {}),
          inputSchema: normalizeValue(tool.inputSchema ?? {}),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      expect(tools).toMatchSnapshot();
    } finally {
      await client.close();
      await server.close();
    }
  });
});

function runCliHelp(args: string[]): string {
  const result = spawnSync('node', [path.resolve('bin/workgraph.js'), ...args, '--help'], {
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(
      `CLI help failed for args [${args.join(' ')}].\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function extractOptionSignatures(helpText: string): string[] {
  const lines = helpText.split('\n');
  const optionsIndex = lines.findIndex((line) => line.trim() === 'Options:');
  if (optionsIndex === -1) {
    throw new Error(`Help output missing Options section.\n${helpText}`);
  }

  const signatures: string[] = [];
  for (let index = optionsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('  ')) {
      break;
    }

    const trimmed = line.trim();
    if (!trimmed.startsWith('-')) {
      continue;
    }
    signatures.push(trimmed.split(/\s{2,}/)[0] ?? trimmed);
  }
  return signatures;
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  const sortedEntries = Object.keys(record)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => [key, normalizeValue(record[key])] as const);
  return Object.fromEntries(sortedEntries);
}

async function loadMcpServerModule(): Promise<{
  createWorkgraphMcpServer: (...args: any[]) => any;
}> {
  const moduleUrl = new URL('../../mcp-server/src/index.js', import.meta.url).toString();
  return import(moduleUrl) as Promise<{
    createWorkgraphMcpServer: (...args: any[]) => any;
  }>;
}
