#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startWorkgraphMcpHttpServer } from '../dist/mcp-http-server.js';
import * as workgraph from '../dist/index.js';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'bin', 'workgraph.js');

const argv = parseArgs(process.argv.slice(2));
const workspacePath = argv.workspacePath || fs.mkdtempSync(path.join(os.tmpdir(), 'workgraph-product-demo-'));

await ensureBuiltArtifacts();

const logLines = [];
const log = (line) => {
  logLines.push(line);
  if (!argv.silent) console.error(line);
};

log(`workspace=${workspacePath}`);

const init = await runCli(['init', workspacePath, '--json'], log);
await runCli(['policy', 'party', 'upsert', 'demo-operator', '-w', workspacePath, '--roles', 'operators', '--capabilities', 'mcp:write,thread:claim,thread:done,dispatch:run,checkpoint:create', '--json'], log);
await runCli(['policy', 'party', 'upsert', 'trigger-gate', '-w', workspacePath, '--roles', 'reviewer', '--capabilities', 'promote:sensitive', '--json'], log);

await runCli(['thread', 'create', 'Platform task A', '-w', workspacePath, '--goal', 'A', '--actor', 'lead', '--priority', 'high', '--json'], log);
await runCli(['thread', 'create', 'Platform task B', '-w', workspacePath, '--goal', 'B', '--actor', 'lead', '--deps', 'threads/platform-task-a.md', '--priority', 'medium', '--json'], log);
const cursorCloudRun = await runCli(
  ['dispatch', 'create-execute', 'Cursor cloud autonomous coordination', '-w', workspacePath, '--actor', 'lead', '--agents', 'alpha,beta', '--max-steps', '30', '--step-delay-ms', '0', '--json'],
  log,
);

const shellRun = workgraph.dispatch.createRun(workspacePath, {
  actor: 'lead',
  adapter: 'shell-worker',
  objective: 'Shell adapter production run',
  context: {
    shell_command: 'printf shell_adapter_ok',
  },
});
const shellExec = await workgraph.dispatch.executeRun(workspacePath, shellRun.id, { actor: 'lead' });

const webhookResult = await runWebhookAdapterDemo(workspacePath);

await runCli(['thread', 'create', 'Blocked trigger source', '-w', workspacePath, '--goal', 'Generate trigger event', '--actor', 'trigger-worker', '--priority', 'high', '--json'], log);
await runCli(['thread', 'claim', 'threads/blocked-trigger-source.md', '-w', workspacePath, '--actor', 'trigger-worker', '--json'], log);
await runCli(['thread', 'block', 'threads/blocked-trigger-source.md', '-w', workspacePath, '--actor', 'trigger-worker', '--blocked-by', 'external/upstream', '--reason', 'waiting upstream', '--json'], log);
await runCli(['primitive', 'create', 'trigger', 'Escalate blocked events', '-w', workspacePath, '--set', 'event=thread.blocked', '--set', 'action=dispatch.review', '--set', 'status=draft', '--actor', 'trigger-gate', '--json'], log);
await runCli(['primitive', 'update', 'triggers/escalate-blocked-events.md', '-w', workspacePath, '--set', 'status=approved', '--actor', 'trigger-gate', '--json'], log);
const triggerCycle = await runCli(['trigger', 'engine', 'run', '-w', workspacePath, '--actor', 'trigger-engine', '--max-cycles', '1', '--json'], log);

await runCli(['thread', 'create', 'Autonomy chain 1', '-w', workspacePath, '--goal', 'c1', '--actor', 'auto-lead', '--priority', 'high', '--json'], log);
await runCli(['thread', 'create', 'Autonomy chain 2', '-w', workspacePath, '--goal', 'c2', '--actor', 'auto-lead', '--deps', 'threads/autonomy-chain-1.md', '--priority', 'medium', '--json'], log);
const autonomyRun = await runCli(['autonomy', 'run', '-w', workspacePath, '--actor', 'auto-lead', '--agents', 'auto-1,auto-2', '--max-cycles', '6', '--max-idle-cycles', '1', '--poll-ms', '10', '--max-steps', '100', '--step-delay-ms', '0', '--json'], log);

const mcpHttpResult = await runMcpHttpDemo(workspacePath);
const adapters = await runCli(['dispatch', 'adapters', '--json'], log);
const ledgerVerify = await runCli(['ledger', 'verify', '-w', workspacePath, '--strict', '--json'], log);

const result = {
  workspacePath,
  initSummary: {
    workspacePath: init.data.workspacePath,
    generatedBases: init.data.generatedBases.length,
  },
  cursorCloud: {
    runId: cursorCloudRun.data.run.id,
    status: cursorCloudRun.data.run.status,
  },
  shellWorker: {
    runId: shellRun.id,
    status: shellExec.status,
    containsExpectedOutput: String(shellExec.output || '').includes('shell_adapter_ok'),
  },
  webhook: webhookResult,
  triggerEngine: {
    actions: triggerCycle.data.cycles[0]?.actions?.length ?? 0,
    driftOk: triggerCycle.data.cycles[0]?.drift?.ok ?? false,
  },
  autonomy: {
    cycles: autonomyRun.data.cycles.length,
    finalReadyThreads: autonomyRun.data.finalReadyThreads,
    finalDriftOk: autonomyRun.data.finalDriftOk,
  },
  mcpHttp: mcpHttpResult,
  adapters: adapters.data.adapters,
  ledgerVerify: ledgerVerify.data,
};

if (argv.logPath) {
  fs.writeFileSync(path.resolve(argv.logPath), `${logLines.join('\n')}\n`, 'utf-8');
}

console.log(JSON.stringify(result, null, 2));

async function runCli(args, logFn) {
  const { stdout, stderr } = await execFileAsync('node', [cliPath, ...args], {
    cwd: repoRoot,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (stderr && stderr.trim()) {
    logFn(`stderr(${args.slice(0, 3).join(' ')}): ${stderr.trim()}`);
  }
  const payload = JSON.parse(stdout);
  logFn(`ok(${args.slice(0, 3).join(' ')}): ${JSON.stringify(payload).slice(0, 180)}`);
  return payload;
}

async function runWebhookAdapterDemo(workspacePath) {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/dispatch') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: 'succeeded',
        output: 'third_party_webhook_success',
      }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const run = workgraph.dispatch.createRun(workspacePath, {
    actor: 'lead',
    adapter: 'http-webhook',
    objective: 'Webhook adapter production run',
    context: {
      webhook_url: `http://127.0.0.1:${port}/dispatch`,
    },
  });

  try {
    const executed = await workgraph.dispatch.executeRun(workspacePath, run.id, { actor: 'lead' });
    return {
      runId: run.id,
      status: executed.status,
      output: executed.output,
    };
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }
}

async function runMcpHttpDemo(workspacePath) {
  const token = 'demo-token';
  const handle = await startWorkgraphMcpHttpServer({
    workspacePath,
    defaultActor: 'demo-operator',
    host: '127.0.0.1',
    port: 0,
    bearerToken: token,
  });
  const client = new Client({
    name: 'product-demo-http-client',
    version: '1.0.0',
  });
  const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
    requestInit: {
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  });

  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const status = await client.callTool({
      name: 'workgraph_status',
      arguments: {},
    });
    const runCreated = await client.callTool({
      name: 'workgraph_dispatch_create',
      arguments: {
        actor: 'demo-operator',
        objective: 'MCP HTTP run',
      },
    });
    const runId = runCreated.structuredContent?.run?.id;
    const runExecuted = await client.callTool({
      name: 'workgraph_dispatch_execute',
      arguments: {
        actor: 'demo-operator',
        runId,
        agents: ['http-a', 'http-b'],
        maxSteps: 20,
        stepDelayMs: 0,
      },
    });
    return {
      url: handle.url,
      tools: tools.tools.length,
      statusError: status.isError === true,
      runId,
      runStatus: runExecuted.structuredContent?.run?.status,
    };
  } finally {
    await client.close();
    await handle.close();
  }
}

function parseArgs(args) {
  const parsed = {
    workspacePath: undefined,
    logPath: undefined,
    silent: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--workspace' && i + 1 < args.length) {
      parsed.workspacePath = path.resolve(args[++i]);
      continue;
    }
    if (arg === '--log' && i + 1 < args.length) {
      parsed.logPath = args[++i];
      continue;
    }
    if (arg === '--silent') {
      parsed.silent = true;
    }
  }
  return parsed;
}

async function ensureBuiltArtifacts() {
  const required = [
    path.join(repoRoot, 'dist', 'index.js'),
    path.join(repoRoot, 'dist', 'cli.js'),
    path.join(repoRoot, 'dist', 'mcp-http-server.js'),
  ];
  for (const file of required) {
    if (!fs.existsSync(file)) {
      throw new Error(`Missing build artifact "${file}". Run "pnpm run build" first.`);
    }
  }
}
