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
  const apiKeyEnvByActor = {
    [args.adminActor]: args.adminApiKey,
    [args.intakeActor]: args.intakeApiKey,
    [args.builderActor]: args.builderApiKey,
    [args.reviewerActor]: args.reviewerApiKey,
  };

  logLine('creating lifecycle threads', args.json);
  const intakeThread = await runCliJson(
    repoRoot,
    [
      'thread',
      'create',
      'OBJ-09 intake triage',
      '-w',
      workspacePath,
      '--goal',
      'Collect triage context and route implementation work',
      '--priority',
      'high',
      '--actor',
      args.adminActor,
      '--tags',
      'obj-09,intake',
      '--json',
    ],
    { env: toApiKeyEnv(args.adminApiKey) },
  );
  const intakeThreadPath = String(intakeThread.data.thread.path);

  const builderThread = await runCliJson(
    repoRoot,
    [
      'thread',
      'create',
      'OBJ-09 implementation',
      '-w',
      workspacePath,
      '--goal',
      'Implement coordinated fix and capture build evidence',
      '--priority',
      'high',
      '--deps',
      intakeThreadPath,
      '--actor',
      args.adminActor,
      '--tags',
      'obj-09,implementation',
      '--json',
    ],
    { env: toApiKeyEnv(args.adminApiKey) },
  );
  const builderThreadPath = String(builderThread.data.thread.path);

  const reviewerThread = await runCliJson(
    repoRoot,
    [
      'thread',
      'create',
      'OBJ-09 verification',
      '-w',
      workspacePath,
      '--goal',
      'Verify the fix and close the coordination loop',
      '--priority',
      'medium',
      '--deps',
      builderThreadPath,
      '--actor',
      args.adminActor,
      '--tags',
      'obj-09,verification',
      '--json',
    ],
    { env: toApiKeyEnv(args.adminApiKey) },
  );
  const reviewerThreadPath = String(reviewerThread.data.thread.path);

  logLine('creating conversation and plan steps', args.json);
  const conversation = await runCliJson(
    repoRoot,
    [
      'conversation',
      'create',
      'OBJ-09 execution room',
      '-w',
      workspacePath,
      '--actor',
      args.adminActor,
      '--threads',
      `${intakeThreadPath},${builderThreadPath},${reviewerThreadPath}`,
      '--tags',
      'obj-09,multi-agent',
      '--status',
      'active',
      '--json',
    ],
    { env: toApiKeyEnv(args.adminApiKey) },
  );
  const conversationPath = String(conversation.data.conversation.path);

  const intakePlanStep = await runCliJson(
    repoRoot,
    [
      'plan-step',
      'create',
      conversationPath,
      'Triage incoming issue and hand off implementation',
      '-w',
      workspacePath,
      '--actor',
      args.adminActor,
      '--thread',
      intakeThreadPath,
      '--assignee',
      args.intakeActor,
      '--order',
      '1',
      '--json',
    ],
    { env: toApiKeyEnv(args.adminApiKey) },
  );
  const intakeStepPath = String(intakePlanStep.data.step.path);

  const builderPlanStep = await runCliJson(
    repoRoot,
    [
      'plan-step',
      'create',
      conversationPath,
      'Implement and validate coordinated fix',
      '-w',
      workspacePath,
      '--actor',
      args.adminActor,
      '--thread',
      builderThreadPath,
      '--assignee',
      args.builderActor,
      '--order',
      '2',
      '--json',
    ],
    { env: toApiKeyEnv(args.adminApiKey) },
  );
  const builderStepPath = String(builderPlanStep.data.step.path);

  const reviewerPlanStep = await runCliJson(
    repoRoot,
    [
      'plan-step',
      'create',
      conversationPath,
      'Run independent QA verification',
      '-w',
      workspacePath,
      '--actor',
      args.adminActor,
      '--thread',
      reviewerThreadPath,
      '--assignee',
      args.reviewerActor,
      '--order',
      '3',
      '--json',
    ],
    { env: toApiKeyEnv(args.adminApiKey) },
  );
  const reviewerStepPath = String(reviewerPlanStep.data.step.path);

  logLine('running intake and builder lifecycle', args.json);
  await runCliJson(
    repoRoot,
    ['dispatch', 'claim', intakeThreadPath, '-w', workspacePath, '--actor', args.intakeActor, '--json'],
    { env: toApiKeyEnv(args.intakeApiKey) },
  );
  await runCliJson(
    repoRoot,
    ['plan-step', 'start', intakeStepPath, '-w', workspacePath, '--actor', args.intakeActor, '--json'],
    { env: toApiKeyEnv(args.intakeApiKey) },
  );
  await runCliJson(
    repoRoot,
    ['plan-step', 'progress', intakeStepPath, '100', '-w', workspacePath, '--actor', args.intakeActor, '--json'],
    { env: toApiKeyEnv(args.intakeApiKey) },
  );
  await runCliJson(
    repoRoot,
    [
      'thread',
      'done',
      intakeThreadPath,
      '-w',
      workspacePath,
      '--actor',
      args.intakeActor,
      '--output',
      'Triage completed with evidence https://github.com/versatly/workgraph/pull/obj-09-intake',
      '--json',
    ],
    { env: toApiKeyEnv(args.intakeApiKey) },
  );
  await runCliJson(
    repoRoot,
    ['plan-step', 'done', intakeStepPath, '-w', workspacePath, '--actor', args.intakeActor, '--json'],
    { env: toApiKeyEnv(args.intakeApiKey) },
  );

  await runCliJson(
    repoRoot,
    ['dispatch', 'claim', builderThreadPath, '-w', workspacePath, '--actor', args.builderActor, '--json'],
    { env: toApiKeyEnv(args.builderApiKey) },
  );
  await runCliJson(
    repoRoot,
    ['plan-step', 'start', builderStepPath, '-w', workspacePath, '--actor', args.builderActor, '--json'],
    { env: toApiKeyEnv(args.builderApiKey) },
  );
  await runCliJson(
    repoRoot,
    ['plan-step', 'progress', builderStepPath, '75', '-w', workspacePath, '--actor', args.builderActor, '--json'],
    { env: toApiKeyEnv(args.builderApiKey) },
  );
  await runCliJson(
    repoRoot,
    [
      'thread',
      'done',
      builderThreadPath,
      '-w',
      workspacePath,
      '--actor',
      args.builderActor,
      '--output',
      'Implementation completed with verification logs https://github.com/versatly/workgraph/pull/obj-09-build',
      '--json',
    ],
    { env: toApiKeyEnv(args.builderApiKey) },
  );
  await runCliJson(
    repoRoot,
    ['plan-step', 'done', builderStepPath, '-w', workspacePath, '--actor', args.builderActor, '--json'],
    { env: toApiKeyEnv(args.builderApiKey) },
  );

  logLine('advertising reviewer capabilities and running self-assembly', args.json);
  await runCliJson(
    repoRoot,
    [
      'primitive',
      'update',
      reviewerThreadPath,
      '-w',
      workspacePath,
      '--actor',
      args.reviewerActor,
      '--set',
      'required_capabilities=quality:review',
      '--set',
      'required_skills=qa-verification',
      '--set',
      'required_adapters=shell-worker',
      '--json',
    ],
    { env: toApiKeyEnv(args.reviewerApiKey) },
  );
  await runCliJson(
    repoRoot,
    [
      'agent',
      'heartbeat',
      args.reviewerActor,
      '-w',
      workspacePath,
      '--actor',
      args.reviewerActor,
      '--status',
      'online',
      '--current-task',
      reviewerThreadPath,
      '--capabilities',
      'thread:claim,thread:manage,dispatch:run,quality:review,skill:qa-verification,adapter:shell-worker',
      '--json',
    ],
    { env: toApiKeyEnv(args.reviewerApiKey) },
  );

  const selfAssembly = sdk.agentSelfAssembly.assembleAgent(
    workspacePath,
    args.reviewerActor,
    {
      credentialToken: args.reviewerApiKey,
      advertise: {
        capabilities: ['quality:review'],
        skills: ['qa-verification'],
        adapters: ['shell-worker'],
      },
      createPlanStepIfMissing: true,
      recoverStaleClaims: true,
    },
  );

  await runCliJson(
    repoRoot,
    ['plan-step', 'progress', reviewerStepPath, '100', '-w', workspacePath, '--actor', args.reviewerActor, '--json'],
    { env: toApiKeyEnv(args.reviewerApiKey) },
  );
  await runCliJson(
    repoRoot,
    ['plan-step', 'done', reviewerStepPath, '-w', workspacePath, '--actor', args.reviewerActor, '--json'],
    { env: toApiKeyEnv(args.reviewerApiKey) },
  );
  await runCliJson(
    repoRoot,
    [
      'thread',
      'done',
      reviewerThreadPath,
      '-w',
      workspacePath,
      '--actor',
      args.reviewerActor,
      '--output',
      'QA sign-off completed with green checks https://github.com/versatly/workgraph/pull/obj-09-qa',
      '--json',
    ],
    { env: toApiKeyEnv(args.reviewerApiKey) },
  );
  await runCliJson(
    repoRoot,
    [
      'conversation',
      'message',
      conversationPath,
      'All coordination plan-steps completed by intake, builder, and reviewer agents.',
      '-w',
      workspacePath,
      '--actor',
      args.adminActor,
      '--kind',
      'decision',
      '--thread',
      reviewerThreadPath,
      '--json',
    ],
    { env: toApiKeyEnv(args.adminApiKey) },
  );

  const conversationState = await runCliJson(
    repoRoot,
    ['conversation', 'state', conversationPath, '-w', workspacePath, '--json'],
    { env: toApiKeyEnv(args.adminApiKey) },
  );
  const readyThreads = await runCliJson(
    repoRoot,
    ['thread', 'list', '-w', workspacePath, '--ready', '--json'],
    { env: toApiKeyEnv(args.adminApiKey) },
  );

  const output = {
    workspacePath,
    conversationPath,
    threadPaths: {
      intakeThreadPath,
      builderThreadPath,
      reviewerThreadPath,
    },
    planStepPaths: {
      intakeStepPath,
      builderStepPath,
      reviewerStepPath,
    },
    selfAssembly: {
      agentName: selfAssembly.agentName,
      claimedThreadPath: selfAssembly.claimedThread?.path,
      planStepPath: selfAssembly.planStep?.path,
      warnings: selfAssembly.warnings,
    },
    conversationSummary: conversationState.data.summary,
    readyThreadCount: Number(readyThreads.data.count ?? 0),
    actorApiKeys: apiKeyEnvByActor,
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
