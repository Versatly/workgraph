#!/usr/bin/env node

import path from 'node:path';
import {
  ensureBuild,
  logLine,
  resolveRepoRoot,
  resolveWorkspace,
  runCliJson,
} from './lib/demo-utils.mjs';

const AGENTS = {
  admin: 'governance-admin',
  intake: 'agent-intake',
  builder: 'agent-builder',
  reviewer: 'agent-reviewer',
};

const roleByAgent = {
  [AGENTS.intake]: 'roles/contributor.md',
  [AGENTS.builder]: 'roles/contributor.md',
  [AGENTS.reviewer]: 'roles/viewer.md',
};

async function main() {
  const repoRoot = resolveRepoRoot(import.meta.url);
  const resolved = resolveWorkspace(process.argv.slice(2));
  if (!resolved.skipBuild) {
    logLine('building dist artifacts', resolved.json);
    await ensureBuild(repoRoot);
  }
  const workspacePath = resolved.workspacePath;

  logLine('initializing workspace', resolved.json);
  const init = await runCliJson(repoRoot, ['init', workspacePath, '--json']);
  const bootstrapTrustToken = String(init.data.bootstrapTrustToken);

  logLine('registering governance admin', resolved.json);
  const adminRegistration = await runCliJson(repoRoot, [
    'agent',
    'register',
    AGENTS.admin,
    '-w',
    workspacePath,
    '--token',
    bootstrapTrustToken,
    '--role',
    'roles/admin.md',
    '--capabilities',
    'policy:manage,agent:approve-registration,agent:register,dispatch:run,thread:claim,thread:manage',
    '--actor',
    AGENTS.admin,
    '--json',
  ]);
  const adminApiKey = String(adminRegistration.data.apiKey ?? '');

  const approvals = [];
  for (const agent of [AGENTS.intake, AGENTS.builder, AGENTS.reviewer]) {
    logLine(`requesting registration for ${agent}`, resolved.json);
    const request = await runCliJson(
      repoRoot,
      [
        'agent',
        'request',
        agent,
        '-w',
        workspacePath,
        '--actor',
        agent,
        '--role',
        roleByAgent[agent],
        '--capabilities',
        'thread:claim,thread:manage,dispatch:run,agent:heartbeat',
        '--note',
        `OBJ-09 demo onboarding for ${agent}`,
        '--json',
      ],
      { env: adminApiKey ? { WORKGRAPH_API_KEY: adminApiKey } : undefined },
    );
    const requestPath = String(request.data.request.path);

    logLine(`approving registration for ${agent}`, resolved.json);
    const review = await runCliJson(
      repoRoot,
      [
        'agent',
        'review',
        requestPath,
        '-w',
        workspacePath,
        '--decision',
        'approved',
        '--actor',
        AGENTS.admin,
        '--role',
        roleByAgent[agent],
        '--capabilities',
        'thread:claim,thread:manage,dispatch:run,agent:heartbeat',
        '--json',
      ],
      { env: adminApiKey ? { WORKGRAPH_API_KEY: adminApiKey } : undefined },
    );
    approvals.push({
      agent,
      requestPath,
      approvalPath: String(review.data.approval.path),
      apiKey: String(review.data.apiKey ?? ''),
    });
  }

  logLine('publishing initial agent heartbeats', resolved.json);
  for (const approval of approvals) {
    await runCliJson(
      repoRoot,
      [
        'agent',
        'heartbeat',
        approval.agent,
        '-w',
        workspacePath,
        '--actor',
        approval.agent,
        '--status',
        'online',
        '--capabilities',
        'thread:claim,thread:manage,dispatch:run,agent:heartbeat',
        '--json',
      ],
      { env: approval.apiKey ? { WORKGRAPH_API_KEY: approval.apiKey } : undefined },
    );
  }

  const agents = await runCliJson(
    repoRoot,
    ['agent', 'list', '-w', workspacePath, '--json'],
    { env: adminApiKey ? { WORKGRAPH_API_KEY: adminApiKey } : undefined },
  );
  const credentials = await runCliJson(
    repoRoot,
    ['agent', 'credential-list', '-w', workspacePath, '--json'],
    { env: adminApiKey ? { WORKGRAPH_API_KEY: adminApiKey } : undefined },
  );

  const output = {
    workspacePath,
    bootstrapTrustToken,
    admin: {
      actor: AGENTS.admin,
      apiKey: adminApiKey,
      credentialId: String(adminRegistration.data.credential?.id ?? ''),
    },
    approvals,
    governanceSnapshot: {
      agentCount: Number(agents.data.count ?? 0),
      credentialCount: Number(credentials.data.count ?? 0),
    },
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
