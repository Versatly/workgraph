import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { loadRegistry, saveRegistry } from './registry.js';
import * as dispatch from './dispatch.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-adapters-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('dispatch production adapters', () => {
  it('executes shell-worker adapter commands successfully', async () => {
    const run = dispatch.createRun(workspacePath, {
      actor: 'adapter-tester',
      adapter: 'shell-worker',
      objective: 'Run shell adapter command',
      context: {
        shell_command: 'printf "shell-worker-ok"',
      },
    });

    const result = await dispatch.executeRun(workspacePath, run.id, {
      actor: 'adapter-tester',
    });

    expect(result.status).toBe('succeeded');
    expect(result.output).toContain('shell-worker-ok');
  });

  it('executes http-webhook adapter against third-party endpoint', async () => {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/dispatch') {
        res.setHeader('content-type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({
          status: 'succeeded',
          output: 'remote system executed run successfully',
        }));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const webhookUrl = `http://127.0.0.1:${port}/dispatch`;

    try {
      const run = dispatch.createRun(workspacePath, {
        actor: 'adapter-tester',
        adapter: 'http-webhook',
        objective: 'Run webhook adapter command',
        context: {
          webhook_url: webhookUrl,
        },
      });
      const result = await dispatch.executeRun(workspacePath, run.id, {
        actor: 'adapter-tester',
      });
      expect(result.status).toBe('succeeded');
      expect(result.output).toContain('remote system executed run successfully');
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it('executes claude-code adapter through configured command template', async () => {
    const run = dispatch.createRun(workspacePath, {
      actor: 'adapter-tester',
      adapter: 'claude-code',
      objective: 'Run claude adapter command template',
      context: {
        claude_command_template: 'printf claude_adapter_ok',
      },
    });

    const result = await dispatch.executeRun(workspacePath, run.id, {
      actor: 'adapter-tester',
    });

    expect(result.status).toBe('succeeded');
    expect(result.output).toContain('claude_adapter_ok');
  });
});
