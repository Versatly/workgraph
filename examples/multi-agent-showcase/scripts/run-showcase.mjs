#!/usr/bin/env node

import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  ensureBuild,
  logLine,
  resolveRepoRoot,
  resolveWorkspace,
  runCliJson,
} from './lib/demo-utils.mjs';

const execFileAsync = promisify(execFile);

async function main() {
  const repoRoot = resolveRepoRoot(import.meta.url);
  const resolved = resolveWorkspace(process.argv.slice(2));
  const workspacePath = resolved.workspacePath;

  if (!resolved.skipBuild) {
    logLine('building dist artifacts', resolved.json);
    await ensureBuild(repoRoot);
  }

  const scriptDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
  logLine('phase 1/3: governance and registration', resolved.json);
  const governance = await runScriptJson(scriptDir, '01-governance.mjs', [
    '--workspace',
    workspacePath,
    '--json',
    ...(resolved.skipBuild ? ['--skip-build'] : []),
  ]);

  const approvalByAgent = new Map();
  for (const approval of governance.approvals ?? []) {
    approvalByAgent.set(String(approval.agent), String(approval.apiKey ?? ''));
  }

  logLine('phase 2/3: collaborative execution with self-assembly', resolved.json);
  const collaboration = await runScriptJson(scriptDir, '02-collaboration.mjs', [
    '--workspace',
    workspacePath,
    '--admin-api-key',
    String(governance.admin?.apiKey ?? ''),
    '--intake-api-key',
    String(approvalByAgent.get('agent-intake') ?? ''),
    '--builder-api-key',
    String(approvalByAgent.get('agent-builder') ?? ''),
    '--reviewer-api-key',
    String(approvalByAgent.get('agent-reviewer') ?? ''),
    '--json',
    ...(resolved.skipBuild ? ['--skip-build'] : []),
  ]);

  logLine('phase 3/3: trigger -> run -> evidence loop', resolved.json);
  const triggerLoop = await runScriptJson(scriptDir, '03-trigger-loop.mjs', [
    '--workspace',
    workspacePath,
    '--admin-api-key',
    String(governance.admin?.apiKey ?? ''),
    '--intake-api-key',
    String(approvalByAgent.get('agent-intake') ?? ''),
    '--builder-api-key',
    String(approvalByAgent.get('agent-builder') ?? ''),
    '--reviewer-api-key',
    String(approvalByAgent.get('agent-reviewer') ?? ''),
    '--json',
    ...(resolved.skipBuild ? ['--skip-build'] : []),
  ]);

  const threadList = await runCliJson(
    repoRoot,
    ['thread', 'list', '-w', workspacePath, '--json'],
    {
      env: governance.admin?.apiKey ? { WORKGRAPH_API_KEY: String(governance.admin.apiKey) } : undefined,
    },
  );
  const dispatchRuns = await runCliJson(
    repoRoot,
    ['dispatch', 'list', '-w', workspacePath, '--json'],
    {
      env: governance.admin?.apiKey ? { WORKGRAPH_API_KEY: String(governance.admin.apiKey) } : undefined,
    },
  );
  const ledgerRecent = await runCliJson(
    repoRoot,
    ['ledger', 'show', '-w', workspacePath, '--count', '25', '--json'],
    {
      env: governance.admin?.apiKey ? { WORKGRAPH_API_KEY: String(governance.admin.apiKey) } : undefined,
    },
  );

  const demoChecks = {
    governance: Number(governance.governanceSnapshot?.agentCount ?? 0) >= 4,
    selfAssemblyClaimedReviewerThread:
      String(collaboration.selfAssembly?.claimedThreadPath ?? '') === String(collaboration.threadPaths?.reviewerThreadPath ?? ''),
    planStepCoordinated:
      String(collaboration.selfAssembly?.planStepPath ?? '') === String(collaboration.planStepPaths?.reviewerStepPath ?? ''),
    triggerRunEvidence:
      String(triggerLoop.triggerLoop?.status ?? '') === 'succeeded'
      && Number(triggerLoop.triggerLoop?.evidenceCount ?? 0) > 0,
    ledgerActivity:
      Number(triggerLoop.ledgerSnapshotCount ?? 0) > 0,
  };
  const pass = Object.values(demoChecks).every(Boolean);

  const output = {
    ok: pass,
    workspacePath,
    providedWorkspacePath: resolved.providedByUser,
    checks: demoChecks,
    phases: {
      governance,
      collaboration,
      triggerLoop,
    },
    rollup: {
      threadCount: Number(threadList.data.count ?? 0),
      runCount: Array.isArray(dispatchRuns.data.runs) ? dispatchRuns.data.runs.length : 0,
      ledgerEntryCount: Number(ledgerRecent.data.count ?? 0),
    },
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!pass) {
    process.exitCode = 1;
  }
}

async function runScriptJson(scriptDir, scriptName, args) {
  const scriptPath = path.join(scriptDir, scriptName);
  const { stdout, stderr } = await execFileAsync('node', [scriptPath, ...args], {
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  });
  const output = String(stdout ?? '').trim();
  try {
    return JSON.parse(output);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Script ${scriptName} did not emit valid JSON: ${detail}\nstdout:\n${output}\nstderr:\n${String(stderr ?? '')}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
