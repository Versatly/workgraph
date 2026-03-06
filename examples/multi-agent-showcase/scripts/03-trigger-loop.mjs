#!/usr/bin/env node

import {
  ensureBuild,
  loadSdk,
  logLine,
  resolveRepoRoot,
  runCliJson,
} from './lib/demo-utils.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.workspacePath) {
    throw new Error('Missing required --workspace argument.');
  }

  const repoRoot = resolveRepoRoot(import.meta.url);
  if (!args.skipBuild) {
    logLine('building dist artifacts', args.json);
    await ensureBuild(repoRoot);
  }
  const sdk = await loadSdk(repoRoot);
  const workspacePath = args.workspacePath;

  logLine('creating active trigger for thread-complete events', args.json);
  const shellCommand = `"${process.execPath}" -e "console.log('obj09-trigger-ok'); console.log('https://github.com/versatly/workgraph/pull/obj-09-trigger');"`;
  const trigger = sdk.store.create(
    workspacePath,
    'trigger',
    {
      title: 'OBJ-09 thread completion trigger',
      status: 'active',
      condition: {
        type: 'event',
        event: 'thread-complete',
      },
      action: {
        type: 'dispatch-run',
        objective: 'React to completed thread {{matched_event_latest_target}}',
        adapter: 'shell-worker',
        context: {
          shell_command: shellCommand,
        },
      },
      cooldown: 0,
      tags: ['obj-09', 'trigger'],
    },
    '# OBJ-09 Trigger\n\nDispatches a shell-worker run after thread completion events.\n',
    args.adminActor,
  );

  // First cycle initializes event cursor for deterministic behavior.
  await runCliJson(
    repoRoot,
    [
      'trigger',
      'engine',
      'run',
      '-w',
      workspacePath,
      '--actor',
      args.adminActor,
      '--execute-runs',
      '--agents',
      `${args.intakeActor},${args.builderActor},${args.reviewerActor}`,
      '--max-steps',
      '40',
      '--step-delay-ms',
      '0',
      '--timeout-ms',
      '30000',
      '--json',
    ],
    { env: toApiKeyEnv(args.adminApiKey) },
  );

  logLine('creating a source thread and completing it', args.json);
  const sourceThread = await runCliJson(
    repoRoot,
    [
      'thread',
      'create',
      'OBJ-09 trigger source',
      '-w',
      workspacePath,
      '--goal',
      'Emit one completion event for trigger execution',
      '--actor',
      args.adminActor,
      '--priority',
      'high',
      '--tags',
      'obj-09,trigger-source',
      '--json',
    ],
    { env: toApiKeyEnv(args.adminApiKey) },
  );
  const sourceThreadPath = String(sourceThread.data.thread.path);

  await runCliJson(
    repoRoot,
    ['thread', 'claim', sourceThreadPath, '-w', workspacePath, '--actor', args.intakeActor, '--json'],
    { env: toApiKeyEnv(args.intakeApiKey) },
  );
  await runCliJson(
    repoRoot,
    [
      'thread',
      'done',
      sourceThreadPath,
      '-w',
      workspacePath,
      '--actor',
      args.intakeActor,
      '--output',
      'Trigger source completed for OBJ-09 evidence loop https://github.com/versatly/workgraph/pull/obj-09-trigger-source',
      '--json',
    ],
    { env: toApiKeyEnv(args.intakeApiKey) },
  );

  logLine('running trigger-run-evidence loop', args.json);
  const secondCycle = await runCliJson(
    repoRoot,
    [
      'trigger',
      'engine',
      'run',
      '-w',
      workspacePath,
      '--actor',
      args.adminActor,
      '--execute-runs',
      '--agents',
      `${args.intakeActor},${args.builderActor},${args.reviewerActor}`,
      '--max-steps',
      '40',
      '--step-delay-ms',
      '0',
      '--timeout-ms',
      '30000',
      '--json',
    ],
    { env: toApiKeyEnv(args.adminApiKey) },
  );

  const executedRuns = Array.isArray(secondCycle.data.executedRuns) ? secondCycle.data.executedRuns : [];
  const triggeredRun = executedRuns[0];
  if (!triggeredRun || !triggeredRun.runId) {
    throw new Error('Expected at least one executed run from trigger engine.');
  }
  const runId = String(triggeredRun.runId);

  const runStatus = await runCliJson(
    repoRoot,
    ['dispatch', 'status', runId, '-w', workspacePath, '--json'],
    { env: toApiKeyEnv(args.adminApiKey) },
  );
  const runLogs = await runCliJson(
    repoRoot,
    ['dispatch', 'logs', runId, '-w', workspacePath, '--json'],
    { env: toApiKeyEnv(args.adminApiKey) },
  );
  const ledgerSnapshot = await runCliJson(
    repoRoot,
    ['ledger', 'show', '-w', workspacePath, '--count', '20', '--json'],
    { env: toApiKeyEnv(args.adminApiKey) },
  );

  const output = {
    workspacePath,
    triggerPath: trigger.path,
    sourceThreadPath,
    triggerLoop: {
      runId,
      status: String(runStatus.data.run.status),
      evidenceCount: Number(runStatus.data.run?.evidenceChain?.count ?? 0),
      logEntries: Array.isArray(runLogs.data.logs) ? runLogs.data.logs.length : 0,
      cycleFired: Number(secondCycle.data.cycle?.fired ?? 0),
    },
    ledgerSnapshotCount: Number(ledgerSnapshot.data.count ?? 0),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function parseArgs(args) {
  const parsed = {
    workspacePath: '',
    adminActor: 'governance-admin',
    intakeActor: 'agent-intake',
    builderActor: 'agent-builder',
    reviewerActor: 'agent-reviewer',
    adminApiKey: '',
    intakeApiKey: '',
    builderApiKey: '',
    reviewerApiKey: '',
    skipBuild: false,
    json: false,
  };
  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = String(args[idx] ?? '');
    if ((arg === '--workspace' || arg === '-w') && idx + 1 < args.length) {
      parsed.workspacePath = String(args[idx + 1]);
      idx += 1;
      continue;
    }
    if (arg === '--admin-api-key' && idx + 1 < args.length) {
      parsed.adminApiKey = String(args[idx + 1]);
      idx += 1;
      continue;
    }
    if (arg === '--intake-api-key' && idx + 1 < args.length) {
      parsed.intakeApiKey = String(args[idx + 1]);
      idx += 1;
      continue;
    }
    if (arg === '--builder-api-key' && idx + 1 < args.length) {
      parsed.builderApiKey = String(args[idx + 1]);
      idx += 1;
      continue;
    }
    if (arg === '--reviewer-api-key' && idx + 1 < args.length) {
      parsed.reviewerApiKey = String(args[idx + 1]);
      idx += 1;
      continue;
    }
    if (arg === '--skip-build') {
      parsed.skipBuild = true;
      continue;
    }
    if (arg === '--json') {
      parsed.json = true;
    }
  }
  return parsed;
}

function toApiKeyEnv(apiKey) {
  if (!apiKey) return undefined;
  return { WORKGRAPH_API_KEY: apiKey };
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
