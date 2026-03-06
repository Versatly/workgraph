import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import * as workgraph from '@versatly/workgraph-kernel';
import { startWorkgraphServer, waitForShutdown } from '@versatly/workgraph-control-api';
import { registerAutonomyCommands } from './cli/commands/autonomy.js';
import { registerConversationCommands } from './cli/commands/conversation.js';
import { registerDispatchCommands } from './cli/commands/dispatch.js';
import { registerMcpCommands } from './cli/commands/mcp.js';
import { registerTriggerCommands } from './cli/commands/trigger.js';
import { registerWebhookCommands } from './cli/commands/webhook.js';
import {
  addWorkspaceOption,
  csv,
  installNamedIntegration,
  parseNonNegativeIntOption,
  parsePortOption,
  parsePositiveIntOption,
  parsePositiveIntegerOption,
  parsePositiveNumberOption,
  parseSetPairs,
  renderInstalledIntegrationResult,
  resolveInitTargetPath,
  resolveWorkspacePath,
  runCommand,
  type JsonCapableOptions,
  wantsJson,
} from './cli/core.js';

const DEFAULT_ACTOR =
  process.env.WORKGRAPH_AGENT ||
  process.env.USER ||
  'anonymous';

const CLI_VERSION = (() => {
  try {
    const pkgUrl = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgUrl, 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const program = new Command();
program
  .name('workgraph')
  .description('Agent-first workgraph workspace for multi-agent collaboration.')
  .version(CLI_VERSION);

program.showHelpAfterError();

addWorkspaceOption(
  program
    .command('init [path]')
    .description('Initialize or repair a workgraph workspace starter kit')
    .option('-n, --name <name>', 'Workspace name')
    .option('--no-type-dirs', 'Do not pre-create built-in type directories')
    .option('--no-bases', 'Do not generate .base files from primitive registry')
    .option('--no-readme', 'Do not create README.md/QUICKSTART.md')
    .option('--json', 'Emit structured JSON output')
).action((targetPath, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveInitTargetPath(targetPath, opts);
      const result = workgraph.workspace.initWorkspace(workspacePath, {
        name: opts.name,
        createTypeDirs: opts.typeDirs,
        createBases: opts.bases,
        createReadme: opts.readme,
      });
      return result;
    },
    (result) => {
      const roleSeeded = result.starterKit.roles.created.length + result.starterKit.roles.existing.length;
      const policySeeded = result.starterKit.policies.created.length + result.starterKit.policies.existing.length;
      const gateSeeded = result.starterKit.gates.created.length + result.starterKit.gates.existing.length;
      const spaceSeeded = result.starterKit.spaces.created.length + result.starterKit.spaces.existing.length;
      return [
        `${result.alreadyInitialized ? 'Updated' : 'Initialized'} workgraph workspace: ${result.workspacePath}`,
        `Seeded types: ${result.seededTypes.join(', ')}`,
        `Generated .base files: ${result.generatedBases.length}`,
        `Config: ${result.configPath}`,
        `Server config: ${result.serverConfigPath}`,
        `Starter kit primitives: roles=${roleSeeded} policies=${policySeeded} gates=${gateSeeded} spaces=${spaceSeeded}`,
        `Bootstrap trust token (${result.bootstrapTrustTokenPath}): ${result.bootstrapTrustToken}`,
        ...(result.quickstartPath ? [`Quickstart: ${result.quickstartPath}`] : []),
        '',
        'Next steps:',
        `1) Start server: workgraph serve -w "${result.workspacePath}"`,
        `2) Preferred registration flow: workgraph agent request agent-1 -w "${result.workspacePath}" --role roles/admin.md`,
        `   Approve request: workgraph agent review agent-1 -w "${result.workspacePath}" --decision approved --actor admin-approver`,
        `   Bootstrap fallback: workgraph agent register agent-1 -w "${result.workspacePath}" --token ${result.bootstrapTrustToken}`,
        `3) Create first thread: workgraph thread create "First coordinated task" -w "${result.workspacePath}" --goal "Validate onboarding flow" --actor agent-1`,
      ];
    }
  )
);

// ============================================================================
// thread
// ============================================================================

const threadCmd = program
  .command('thread')
  .description('Coordinate work through claimable threads');

addWorkspaceOption(
  threadCmd
    .command('create <title>')
    .description('Create a new thread')
    .requiredOption('-g, --goal <goal>', 'What success looks like')
    .option('-a, --actor <name>', 'Agent name', DEFAULT_ACTOR)
    .option('-p, --priority <level>', 'urgent | high | medium | low', 'medium')
    .option('--deps <paths>', 'Comma-separated dependency thread paths')
    .option('--parent <path>', 'Parent thread path')
    .option('--space <spaceRef>', 'Optional space ref (e.g. spaces/backend.md)')
    .option('--context <refs>', 'Comma-separated workspace doc refs for context')
    .option('--tags <tags>', 'Comma-separated tags')
    .option('--json', 'Emit structured JSON output')
).action((title, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return {
        thread: workgraph.thread.createThread(workspacePath, title, opts.goal, opts.actor, {
          priority: opts.priority,
          deps: csv(opts.deps),
          parent: opts.parent,
          space: opts.space,
          context_refs: csv(opts.context),
          tags: csv(opts.tags),
        }),
      };
    },
    (result) => [
      `Created thread: ${result.thread.path}`,
      `Status: ${String(result.thread.fields.status)}`,
      `Priority: ${String(result.thread.fields.priority)}`,
    ]
  )
);

addWorkspaceOption(
  threadCmd
    .command('list')
    .description('List threads (optionally by state/ready status)')
    .option('-s, --status <status>', 'open | active | blocked | done | cancelled')
    .option('--space <spaceRef>', 'Filter threads by space ref')
    .option('--ready', 'Only include threads ready to be claimed now')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      let threads = opts.space
        ? workgraph.store.threadsInSpace(workspacePath, opts.space)
        : workgraph.store.list(workspacePath, 'thread');
      const readySet = new Set(
        (opts.space
          ? workgraph.thread.listReadyThreadsInSpace(workspacePath, opts.space)
          : workgraph.thread.listReadyThreads(workspacePath))
          .map(t => t.path)
      );
      if (opts.status) threads = threads.filter(t => t.fields.status === opts.status);
      if (opts.ready) threads = threads.filter(t => readySet.has(t.path));
      const enriched = threads.map(t => ({
        ...t,
        ready: readySet.has(t.path),
      }));
      return { threads: enriched, count: enriched.length };
    },
    (result) => {
      if (result.threads.length === 0) return ['No threads found.'];
      return [
        ...result.threads.map((t) => {
          const status = String(t.fields.status);
          const owner = t.fields.owner ? ` (${String(t.fields.owner)})` : '';
          const ready = t.ready ? ' ready' : '';
          return `[${status}]${ready} ${String(t.fields.title)}${owner} -> ${t.path}`;
        }),
        `${result.count} thread(s)`,
      ];
    }
  )
);

addWorkspaceOption(
  threadCmd
    .command('next')
    .description('Pick the next ready thread, optionally claim it')
    .option('-a, --actor <name>', 'Agent name', DEFAULT_ACTOR)
    .option('--space <spaceRef>', 'Restrict scheduling to one space')
    .option('--claim', 'Immediately claim the next ready thread')
    .option('--fail-on-empty', 'Exit non-zero if no ready thread exists')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const thread = opts.claim
        ? (opts.space
            ? workgraph.thread.claimNextReadyInSpace(workspacePath, opts.actor, opts.space)
            : workgraph.thread.claimNextReady(workspacePath, opts.actor))
        : (opts.space
            ? workgraph.thread.pickNextReadyThreadInSpace(workspacePath, opts.space)
            : workgraph.thread.pickNextReadyThread(workspacePath));
      if (!thread && opts.failOnEmpty) {
        throw new Error('No ready threads available.');
      }
      return {
        thread,
        claimed: !!opts.claim && !!thread,
      };
    },
    (result) => {
      if (!result.thread) return ['No ready thread available.'];
      return [
        `${result.claimed ? 'Claimed' : 'Selected'} thread: ${result.thread.path}`,
        `Title: ${String(result.thread.fields.title)}`,
        ...(result.thread.fields.space ? [`Space: ${String(result.thread.fields.space)}`] : []),
      ];
    }
  )
);

addWorkspaceOption(
  threadCmd
    .command('show <threadPath>')
    .description('Show thread details and ledger history')
    .option('--json', 'Emit structured JSON output')
).action((threadPath, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const thread = workgraph.store.read(workspacePath, threadPath);
      if (!thread) throw new Error(`Thread not found: ${threadPath}`);
      const history = workgraph.ledger.historyOf(workspacePath, threadPath);
      return { thread, history };
    },
    (result) => [
      `${String(result.thread.fields.title)} (${result.thread.path})`,
      `Status: ${String(result.thread.fields.status)} Owner: ${String(result.thread.fields.owner ?? 'unclaimed')}`,
      `History entries: ${result.history.length}`,
    ]
  )
);

addWorkspaceOption(
  threadCmd
    .command('claim <threadPath>')
    .description('Claim a thread for this agent')
    .option('-a, --actor <name>', 'Agent name', DEFAULT_ACTOR)
    .option('--lease-ttl-minutes <n>', 'Claim lease TTL in minutes', '30')
    .option('--json', 'Emit structured JSON output')
).action((threadPath, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return {
        thread: workgraph.thread.claim(workspacePath, threadPath, opts.actor, {
          leaseTtlMinutes: Number.parseFloat(String(opts.leaseTtlMinutes)),
        }),
      };
    },
    (result) => [`Claimed: ${result.thread.path}`, `Owner: ${String(result.thread.fields.owner)}`]
  )
);

addWorkspaceOption(
  threadCmd
    .command('release <threadPath>')
    .description('Release a claimed thread back to open')
    .option('-a, --actor <name>', 'Agent name', DEFAULT_ACTOR)
    .option('--reason <reason>', 'Why you are releasing')
    .option('--json', 'Emit structured JSON output')
).action((threadPath, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return { thread: workgraph.thread.release(workspacePath, threadPath, opts.actor, opts.reason) };
    },
    (result) => [`Released: ${result.thread.path}`, `Status: ${String(result.thread.fields.status)}`]
  )
);

addWorkspaceOption(
  threadCmd
    .command('done <threadPath>')
    .description('Mark a thread done')
    .option('-a, --actor <name>', 'Agent name', DEFAULT_ACTOR)
    .option('-o, --output <text>', 'Output/result summary')
    .option('--evidence <items>', 'Comma-separated evidence values (url/path/reply/thread refs)')
    .option('--json', 'Emit structured JSON output')
).action((threadPath, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return {
        thread: workgraph.thread.done(workspacePath, threadPath, opts.actor, opts.output, {
          evidence: csv(opts.evidence),
        }),
      };
    },
    (result) => [`Done: ${result.thread.path}`]
  )
);

addWorkspaceOption(
  threadCmd
    .command('reopen <threadPath>')
    .description('Reopen a done/cancelled thread via compensating ledger op')
    .option('-a, --actor <name>', 'Agent name', DEFAULT_ACTOR)
    .option('--reason <reason>', 'Why the thread is being reopened')
    .option('--json', 'Emit structured JSON output')
).action((threadPath, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return { thread: workgraph.thread.reopen(workspacePath, threadPath, opts.actor, opts.reason) };
    },
    (result) => [`Reopened: ${result.thread.path}`, `Status: ${String(result.thread.fields.status)}`]
  )
);

addWorkspaceOption(
  threadCmd
    .command('block <threadPath>')
    .description('Mark a thread blocked')
    .requiredOption('-b, --blocked-by <dep>', 'Dependency blocking this thread')
    .option('-a, --actor <name>', 'Agent name', DEFAULT_ACTOR)
    .option('--reason <reason>', 'Why it is blocked')
    .option('--json', 'Emit structured JSON output')
).action((threadPath, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return {
        thread: workgraph.thread.block(workspacePath, threadPath, opts.actor, opts.blockedBy, opts.reason),
      };
    },
    (result) => [`Blocked: ${result.thread.path}`]
  )
);

addWorkspaceOption(
  threadCmd
    .command('unblock <threadPath>')
    .description('Unblock a thread')
    .option('-a, --actor <name>', 'Agent name', DEFAULT_ACTOR)
    .option('--json', 'Emit structured JSON output')
).action((threadPath, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return { thread: workgraph.thread.unblock(workspacePath, threadPath, opts.actor) };
    },
    (result) => [`Unblocked: ${result.thread.path}`]
  )
);

addWorkspaceOption(
  threadCmd
    .command('heartbeat [threadPath]')
    .description('Refresh thread claim lease heartbeat (one thread or all active claims for actor)')
    .option('-a, --actor <name>', 'Agent name', DEFAULT_ACTOR)
    .option('--ttl-minutes <n>', 'Lease TTL in minutes', '30')
    .option('--json', 'Emit structured JSON output')
).action((threadPath, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return workgraph.thread.heartbeatClaim(
        workspacePath,
        opts.actor,
        threadPath,
        {
          ttlMinutes: Number.parseFloat(String(opts.ttlMinutes)),
        },
      );
    },
    (result) => [
      `Heartbeat actor: ${result.actor}`,
      `Touched leases: ${result.touched.length}`,
      ...(result.touched.length > 0
        ? result.touched.map((entry) => `- ${entry.threadPath} expires=${entry.expiresAt}`)
        : []),
      ...(result.skipped.length > 0
        ? result.skipped.map((entry) => `SKIP ${entry.threadPath}: ${entry.reason}`)
        : []),
    ],
  )
);

addWorkspaceOption(
  threadCmd
    .command('reap-stale')
    .description('Reopen/release stale claimed threads whose leases expired')
    .option('-a, --actor <name>', 'Agent name', DEFAULT_ACTOR)
    .option('--limit <n>', 'Max stale leases to reap this run')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return workgraph.thread.reapStaleClaims(workspacePath, opts.actor, {
        limit: opts.limit ? Number.parseInt(String(opts.limit), 10) : undefined,
      });
    },
    (result) => [
      `Reaper actor: ${result.actor}`,
      `Scanned stale leases: ${result.scanned}`,
      `Reaped: ${result.reaped.length}`,
      ...(result.reaped.length > 0
        ? result.reaped.map((entry) => `- ${entry.threadPath} (prev=${entry.previousOwner})`)
        : []),
      ...(result.skipped.length > 0
        ? result.skipped.map((entry) => `SKIP ${entry.threadPath}: ${entry.reason}`)
        : []),
    ],
  )
);

addWorkspaceOption(
  threadCmd
    .command('leases')
    .description('List claim leases and staleness state')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const leases = workgraph.thread.listClaimLeaseStatus(workspacePath);
      return { leases, count: leases.length };
    },
    (result) => result.leases.map((lease) =>
      `${lease.stale ? 'STALE' : 'LIVE'} ${lease.owner} -> ${lease.target} expires=${lease.expiresAt}`)
  )
);

addWorkspaceOption(
  threadCmd
    .command('decompose <threadPath>')
    .description('Break a thread into sub-threads')
    .requiredOption('--sub <specs...>', 'Sub-thread specs as "title|goal"')
    .option('-a, --actor <name>', 'Agent name', DEFAULT_ACTOR)
    .option('--json', 'Emit structured JSON output')
).action((threadPath, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const subthreads = opts.sub.map((spec: string) => {
        const [title, ...goalParts] = spec.split('|');
        const goal = goalParts.join('|').trim() || title.trim();
        return { title: title.trim(), goal };
      });
      return { children: workgraph.thread.decompose(workspacePath, threadPath, subthreads, opts.actor) };
    },
    (result) => [`Created ${result.children.length} sub-thread(s).`]
  )
);

// ============================================================================
// agent presence
// ============================================================================

const agentCmd = program
  .command('agent')
  .description('Track agent presence heartbeats');

addWorkspaceOption(
  agentCmd
    .command('heartbeat <name>')
    .description('Create/update an agent presence heartbeat')
    .option('-a, --actor <name>', 'Actor writing the heartbeat', DEFAULT_ACTOR)
    .option('--status <status>', 'online | busy | offline', 'online')
    .option('--current-task <threadRef>', 'Current task/thread slug for this agent')
    .option('--capabilities <items>', 'Comma-separated capability tags')
    .option('--json', 'Emit structured JSON output')
).action((name, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return {
        presence: workgraph.agent.heartbeat(workspacePath, name, {
          actor: opts.actor,
          status: normalizeAgentPresenceStatus(opts.status),
          currentTask: opts.currentTask,
          capabilities: csv(opts.capabilities),
        }),
      };
    },
    (result) => [
      `Heartbeat: ${String(result.presence.fields.name)} [${String(result.presence.fields.status)}]`,
      `Last seen: ${String(result.presence.fields.last_seen)}`,
      `Current task: ${String(result.presence.fields.current_task ?? 'none')}`,
    ],
  )
);

addWorkspaceOption(
  agentCmd
    .command('register <name>')
    .description('Register an agent using bootstrap token fallback (legacy/hybrid mode)')
    .option('--token <token>', 'Bootstrap trust token (or WORKGRAPH_TRUST_TOKEN env)')
    .option('--role <role>', 'Role slug/path override (default from trust token)')
    .option('--capabilities <items>', 'Comma-separated extra capabilities')
    .option('--status <status>', 'online | busy | offline', 'online')
    .option('--current-task <threadRef>', 'Optional current task/thread ref')
    .option('-a, --actor <name>', 'Actor writing registration artifacts')
    .option('--json', 'Emit structured JSON output')
).action((name, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const token = String(opts.token ?? process.env.WORKGRAPH_TRUST_TOKEN ?? '').trim();
      if (!token) {
        throw new Error('Missing trust token. Provide --token or set WORKGRAPH_TRUST_TOKEN.');
      }
      return workgraph.agent.registerAgent(workspacePath, name, {
        token,
        role: opts.role,
        capabilities: csv(opts.capabilities),
        status: normalizeAgentPresenceStatus(opts.status),
        currentTask: opts.currentTask,
        actor: opts.actor,
      });
    },
    (result) => [
      `Registered agent: ${result.agentName}`,
      `Role: ${result.role} (${result.rolePath})`,
      `Capabilities: ${result.capabilities.join(', ') || 'none'}`,
      `Presence: ${result.presence.path}`,
      `Policy party: ${result.policyParty.id}`,
      `Bootstrap token: ${result.trustTokenPath} [${result.trustTokenStatus}]`,
      ...(result.credential ? [`Credential: ${result.credential.id} [${result.credential.status}]`] : []),
      ...(result.apiKey ? [`API key (store securely, shown once): ${result.apiKey}`] : []),
    ],
  )
);

addWorkspaceOption(
  agentCmd
    .command('request <name>')
    .description('Submit an approval-based agent registration request')
    .option('--role <role>', 'Requested role slug/path (default: roles/contributor.md)')
    .option('--capabilities <items>', 'Comma-separated requested extra capabilities')
    .option('-a, --actor <name>', 'Actor submitting the request')
    .option('--note <text>', 'Optional request note')
    .option('--json', 'Emit structured JSON output')
).action((name, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return workgraph.agent.submitRegistrationRequest(workspacePath, name, {
        role: opts.role,
        capabilities: csv(opts.capabilities),
        actor: opts.actor,
        note: opts.note,
      });
    },
    (result) => [
      `Submitted registration request for ${result.agentName}`,
      `Request: ${result.request.path}`,
      `Requested role: ${result.requestedRolePath}`,
      `Requested capabilities: ${result.requestedCapabilities.join(', ') || 'none'}`,
    ],
  )
);

addWorkspaceOption(
  agentCmd
    .command('review <requestRef>')
    .description('Approve or reject a pending registration request')
    .requiredOption('--decision <decision>', 'approved | rejected')
    .option('-a, --actor <name>', 'Reviewer actor', DEFAULT_ACTOR)
    .option('--role <role>', 'Approved role slug/path (for approved decisions)')
    .option('--capabilities <items>', 'Comma-separated approved extra capabilities')
    .option('--scopes <items>', 'Comma-separated credential scopes (defaults to approved capabilities)')
    .option('--expires-at <isoDate>', 'Optional credential expiry ISO date')
    .option('--note <text>', 'Optional review note')
    .option('--json', 'Emit structured JSON output')
).action((requestRef, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const decision = String(opts.decision ?? '').trim().toLowerCase();
      if (decision !== 'approved' && decision !== 'rejected') {
        throw new Error('Invalid --decision value. Expected approved|rejected.');
      }
      return workgraph.agent.reviewRegistrationRequest(
        workspacePath,
        requestRef,
        opts.actor,
        decision,
        {
          role: opts.role,
          capabilities: csv(opts.capabilities),
          scopes: csv(opts.scopes),
          expiresAt: opts.expiresAt,
          note: opts.note,
        },
      );
    },
    (result) => [
      `Reviewed request: ${result.request.path}`,
      `Decision: ${result.decision}`,
      `Approval record: ${result.approval.path}`,
      ...(result.policyParty
        ? [`Policy party: ${result.policyParty.id} (${result.policyParty.roles.join(', ')})`]
        : []),
      ...(result.credential ? [`Credential: ${result.credential.id} [${result.credential.status}]`] : []),
      ...(result.apiKey ? [`API key (store securely, shown once): ${result.apiKey}`] : []),
    ],
  )
);

addWorkspaceOption(
  agentCmd
    .command('credential-list')
    .description('List issued agent credentials')
    .option('--actor <name>', 'Filter by actor id')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const credentials = workgraph.agent.listAgentCredentials(workspacePath, opts.actor);
      return {
        credentials,
        count: credentials.length,
      };
    },
    (result) => {
      if (result.credentials.length === 0) return ['No credentials found.'];
      return [
        ...result.credentials.map((credential) =>
          `${credential.id} actor=${credential.actor} status=${credential.status} scopes=${credential.scopes.join(', ') || 'none'}`
        ),
        `${result.count} credential(s)`,
      ];
    },
  )
);

addWorkspaceOption(
  agentCmd
    .command('credential-revoke <credentialId>')
    .description('Revoke an issued credential')
    .option('-a, --actor <name>', 'Actor revoking the credential', DEFAULT_ACTOR)
    .option('--reason <text>', 'Optional revocation reason')
    .option('--json', 'Emit structured JSON output')
).action((credentialId, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return {
        credential: workgraph.agent.revokeAgentCredential(
          workspacePath,
          credentialId,
          opts.actor,
          opts.reason,
        ),
      };
    },
    (result) => [
      `Revoked credential: ${result.credential.id}`,
      `Actor: ${result.credential.actor}`,
      `Status: ${result.credential.status}`,
    ],
  )
);

addWorkspaceOption(
  agentCmd
    .command('list')
    .description('List known agent presence entries')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const agents = workgraph.agent.list(workspacePath);
      return {
        agents,
        count: agents.length,
      };
    },
    (result) => {
      if (result.agents.length === 0) return ['No agent presence entries found.'];
      return [
        ...result.agents.map((entry) => {
          const name = String(entry.fields.name ?? entry.path);
          const status = String(entry.fields.status ?? 'unknown');
          const task = String(entry.fields.current_task ?? 'none');
          const lastSeen = String(entry.fields.last_seen ?? 'unknown');
          return `${name} [${status}] task=${task} last_seen=${lastSeen}`;
        }),
        `${result.count} agent(s)`,
      ];
    },
  )
);

// ============================================================================
// primitive
// ============================================================================

const primitiveCmd = program
  .command('primitive')
  .description('Manage primitive type definitions and instances');

addWorkspaceOption(
  primitiveCmd
    .command('define <name>')
    .description('Define a new primitive type')
    .requiredOption('-d, --description <desc>', 'Type description')
    .option('-a, --actor <name>', 'Agent name', DEFAULT_ACTOR)
    .option('--fields <specs...>', 'Field definitions as "name:type"')
    .option('--dir <directory>', 'Storage directory override')
    .option('--json', 'Emit structured JSON output')
).action((name, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const fields: Record<string, workgraph.FieldDefinition> = {};
      for (const spec of opts.fields ?? []) {
        const [fieldName, fieldType = 'string'] = String(spec).split(':');
        fields[fieldName.trim()] = { type: fieldType.trim() as workgraph.FieldDefinition['type'] };
      }
      const type = workgraph.registry.defineType(
        workspacePath,
        name,
        opts.description,
        fields,
        opts.actor,
        opts.dir
      );
      workgraph.bases.syncPrimitiveRegistryManifest(workspacePath);
      const baseResult = workgraph.bases.generateBasesFromPrimitiveRegistry(workspacePath, {
        includeNonCanonical: true,
      });
      return {
        type,
        basesGenerated: baseResult.generated.length,
      };
    },
    (result) => [
      `Defined type: ${result.type.name}`,
      `Directory: ${result.type.directory}/`,
      `Bases generated: ${result.basesGenerated}`,
    ]
  )
);

registerPrimitiveSchemaCommand('schema', 'Show supported fields for a primitive type');
registerPrimitiveSchemaCommand('fields', 'Alias for schema');

// ============================================================================
// bases
// ============================================================================

const basesCmd = program
  .command('bases')
  .description('Generate Obsidian .base files from primitive-registry.yaml');

addWorkspaceOption(
  basesCmd
    .command('sync-registry')
    .description('Sync .workgraph/primitive-registry.yaml from active registry')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const manifest = workgraph.bases.syncPrimitiveRegistryManifest(workspacePath);
      return {
        primitiveCount: manifest.primitives.length,
        manifestPath: '.workgraph/primitive-registry.yaml',
      };
    },
    (result) => [
      `Synced primitive registry manifest: ${result.manifestPath}`,
      `Primitives: ${result.primitiveCount}`,
    ]
  )
);

addWorkspaceOption(
  basesCmd
    .command('generate')
    .description('Generate .base files by reading primitive-registry.yaml')
    .option('--all', 'Include non-canonical primitives')
    .option('--refresh-registry', 'Refresh primitive-registry.yaml before generation')
    .option('--output-dir <path>', 'Output directory for .base files (default: .workgraph/bases)')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      if (opts.refreshRegistry) {
        workgraph.bases.syncPrimitiveRegistryManifest(workspacePath);
      }
      return workgraph.bases.generateBasesFromPrimitiveRegistry(workspacePath, {
        includeNonCanonical: !!opts.all,
        outputDirectory: opts.outputDir,
      });
    },
    (result) => [
      `Generated ${result.generated.length} .base file(s)`,
      `Directory: ${result.outputDirectory}`,
    ]
  )
);

addWorkspaceOption(
  primitiveCmd
    .command('list')
    .description('List primitive types')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const types = workgraph.registry.listTypes(workspacePath);
      return { types, count: types.length };
    },
    (result) => result.types.map(t => `${t.name} (${t.directory}/) ${t.builtIn ? '[built-in]' : ''}`)
  )
);

function registerPrimitiveSchemaCommand(commandName: string, description: string): void {
  addWorkspaceOption(
    primitiveCmd
      .command(`${commandName} <typeName>`)
      .description(description)
      .option('--json', 'Emit structured JSON output')
  ).action((typeName, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const typeDef = workgraph.registry.getType(workspacePath, typeName);
        if (!typeDef) {
          throw new Error(`Unknown primitive type "${typeName}". Use \`workgraph primitive list\` to inspect available types.`);
        }
        const fields = Object.entries(typeDef.fields).map(([name, definition]) => ({
          name,
          type: definition.type,
          required: definition.required === true,
          default: definition.default,
          enum: definition.enum ?? [],
          description: definition.description ?? '',
          template: definition.template ?? undefined,
          pattern: definition.pattern ?? undefined,
          refTypes: definition.refTypes ?? [],
        }));
        return {
          type: typeDef.name,
          description: typeDef.description,
          directory: typeDef.directory,
          builtIn: typeDef.builtIn,
          fields,
        };
      },
      (result) => [
        `Type: ${result.type}`,
        `Directory: ${result.directory}/`,
        `Built-in: ${result.builtIn}`,
        ...result.fields.map((field) =>
          `- ${field.name}: ${field.type}${field.required ? ' (required)' : ''}${field.description ? ` — ${field.description}` : ''}`),
      ],
    )
  );
}

addWorkspaceOption(
  primitiveCmd
    .command('create <type> <title>')
    .description('Create an instance of any primitive type')
    .option('-a, --actor <name>', 'Agent name', DEFAULT_ACTOR)
    .option('--set <fields...>', 'Set fields as "key=value"')
    .option('--body <text>', 'Markdown body content', '')
    .option('--json', 'Emit structured JSON output')
).action((type, title, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const fields: Record<string, unknown> = { title, ...parseSetPairs(opts.set ?? []) };
      return {
        instance: workgraph.store.create(workspacePath, type, fields, opts.body, opts.actor),
      };
    },
    (result) => [`Created ${result.instance.type}: ${result.instance.path}`]
  )
);

addWorkspaceOption(
  primitiveCmd
    .command('update <path>')
    .description('Update an existing primitive instance')
    .option('-a, --actor <name>', 'Agent name', DEFAULT_ACTOR)
    .option('--set <fields...>', 'Set fields as "key=value"')
    .option('--etag <etag>', 'Expected etag for optimistic concurrency')
    .option('--body <text>', 'Replace markdown body content')
    .option('--body-file <path>', 'Read markdown body content from file')
    .option('--json', 'Emit structured JSON output')
).action((targetPath, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const updates = parseSetPairs(opts.set ?? []);
      let body: string | undefined = opts.body;
      if (opts.bodyFile) {
        body = fs.readFileSync(path.resolve(opts.bodyFile), 'utf-8');
      }
      return {
        instance: workgraph.store.update(workspacePath, targetPath, updates, body, opts.actor, {
          expectedEtag: opts.etag,
        }),
      };
    },
    (result) => [`Updated ${result.instance.type}: ${result.instance.path}`]
  )
);

// ============================================================================
// skill
// ============================================================================

const skillCmd = program
  .command('skill')
  .description('Manage native skill primitives in shared workgraph vaults');

addWorkspaceOption(
  skillCmd
    .command('write <title>')
    .description('Create or update a skill primitive')
    .option('-a, --actor <name>', 'Agent name', DEFAULT_ACTOR)
    .option('--owner <name>', 'Skill owner')
    .option('--skill-version <semver>', 'Skill version')
    .option('--status <status>', 'draft | proposed | active | deprecated | archived')
    .option('--distribution <mode>', 'Distribution mode', 'tailscale-shared-vault')
    .option('--tailscale-path <path>', 'Shared Tailscale workspace path')
    .option('--reviewers <list>', 'Comma-separated reviewer names')
    .option('--depends-on <list>', 'Comma-separated skill dependencies (slug/path)')
    .option('--expected-updated-at <iso>', 'Optimistic concurrency guard for updates')
    .option('--tags <list>', 'Comma-separated tags')
    .option('--body <text>', 'Skill markdown content')
    .option('--body-file <path>', 'Read markdown content from file')
    .option('--json', 'Emit structured JSON output')
).action((title, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      let body = opts.body ?? '';
      if (opts.bodyFile) {
        const absBodyFile = path.resolve(opts.bodyFile);
        body = fs.readFileSync(absBodyFile, 'utf-8');
      }
      const instance = workgraph.skill.writeSkill(
        workspacePath,
        title,
        body,
        opts.actor,
        {
          owner: opts.owner,
          version: opts.skillVersion,
          status: opts.status,
          distribution: opts.distribution,
          tailscalePath: opts.tailscalePath,
          reviewers: csv(opts.reviewers),
          dependsOn: csv(opts.dependsOn),
          expectedUpdatedAt: opts.expectedUpdatedAt,
          tags: csv(opts.tags),
        }
      );
      workgraph.bases.syncPrimitiveRegistryManifest(workspacePath);
      workgraph.bases.generateBasesFromPrimitiveRegistry(workspacePath, { includeNonCanonical: true });
      return { skill: instance };
    },
    (result) => [
      `Wrote skill: ${result.skill.path}`,
      `Status: ${String(result.skill.fields.status)} Version: ${String(result.skill.fields.version)}`,
    ]
  )
);

addWorkspaceOption(
  skillCmd
    .command('load <skillRef>')
    .description('Load one skill primitive by slug or path')
    .option('--json', 'Emit structured JSON output')
).action((skillRef, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return { skill: workgraph.skill.loadSkill(workspacePath, skillRef) };
    },
    (result) => [
      `Skill: ${String(result.skill.fields.title)}`,
      `Path: ${result.skill.path}`,
      `Status: ${String(result.skill.fields.status)}`,
    ]
  )
);

addWorkspaceOption(
  skillCmd
    .command('list')
    .description('List skills')
    .option('--status <status>', 'Filter by status')
    .option('--updated-since <iso>', 'Filter by updated timestamp (ISO-8601)')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const skills = workgraph.skill.listSkills(workspacePath, {
        status: opts.status,
        updatedSince: opts.updatedSince,
      });
      return { skills, count: skills.length };
    },
    (result) => result.skills.map((skill) =>
      `${String(skill.fields.title)} [${String(skill.fields.status)}] -> ${skill.path}`)
  )
);

addWorkspaceOption(
  skillCmd
    .command('history <skillRef>')
    .description('Show ledger history entries for one skill')
    .option('--limit <n>', 'Limit number of returned entries')
    .option('--json', 'Emit structured JSON output')
).action((skillRef, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return {
        entries: workgraph.skill.skillHistory(workspacePath, skillRef, {
          limit: opts.limit ? Number.parseInt(String(opts.limit), 10) : undefined,
        }),
      };
    },
    (result) => result.entries.map((entry) => `${entry.ts} ${entry.op} ${entry.actor}`),
  )
);

addWorkspaceOption(
  skillCmd
    .command('diff <skillRef>')
    .description('Show latest field-change summary for one skill')
    .option('--json', 'Emit structured JSON output')
).action((skillRef, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return workgraph.skill.skillDiff(workspacePath, skillRef);
    },
    (result) => [
      `Skill: ${result.path}`,
      `Latest: ${result.latestEntryTs ?? 'none'}`,
      `Previous: ${result.previousEntryTs ?? 'none'}`,
      `Changed fields: ${result.changedFields.join(', ') || 'none'}`,
    ],
  )
);

addWorkspaceOption(
  skillCmd
    .command('propose <skillRef>')
    .description('Move a skill into proposed state and open review thread')
    .option('-a, --actor <name>', 'Agent name', DEFAULT_ACTOR)
    .option('--proposal-thread <path>', 'Explicit proposal thread path')
    .option('--no-create-thread', 'Do not create a proposal thread automatically')
    .option('--space <spaceRef>', 'Space for created proposal thread')
    .option('--reviewers <list>', 'Comma-separated reviewers')
    .option('--json', 'Emit structured JSON output')
).action((skillRef, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return {
        skill: workgraph.skill.proposeSkill(workspacePath, skillRef, opts.actor, {
          proposalThread: opts.proposalThread,
          createThreadIfMissing: opts.createThread,
          space: opts.space,
          reviewers: csv(opts.reviewers),
        }),
      };
    },
    (result) => [
      `Proposed skill: ${result.skill.path}`,
      `Proposal thread: ${String(result.skill.fields.proposal_thread ?? 'none')}`,
    ]
  )
);

addWorkspaceOption(
  skillCmd
    .command('promote <skillRef>')
    .description('Promote a proposed/draft skill to active')
    .option('-a, --actor <name>', 'Agent name', DEFAULT_ACTOR)
    .option('--skill-version <semver>', 'Explicit promoted version')
    .option('--json', 'Emit structured JSON output')
).action((skillRef, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return {
        skill: workgraph.skill.promoteSkill(workspacePath, skillRef, opts.actor, {
          version: opts.skillVersion,
        }),
      };
    },
    (result) => [
      `Promoted skill: ${result.skill.path}`,
      `Status: ${String(result.skill.fields.status)} Version: ${String(result.skill.fields.version)}`,
    ]
  )
);

// ============================================================================
// integration
// ============================================================================

const integrationCmd = program
  .command('integration')
  .description('Manage optional third-party integrations');

addWorkspaceOption(
  integrationCmd
    .command('list')
    .description('List supported optional integrations')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => ({
      integrations: workgraph.integration.listIntegrations(),
    }),
    (result) => result.integrations.map((integration) =>
      `${integration.id} (${integration.defaultTitle}) -> ${integration.defaultSourceUrl}`)
  )
);

addWorkspaceOption(
  integrationCmd
    .command('install <integrationName>')
    .description('Install an optional integration into this workspace')
    .option('-a, --actor <name>', 'Agent name', DEFAULT_ACTOR)
    .option('--owner <name>', 'Skill owner override')
    .option('--title <title>', 'Skill title to store in workgraph')
    .option('--source-url <url>', 'Source URL override for integration content')
    .option('--force', 'Overwrite an existing imported integration skill')
    .option('--json', 'Emit structured JSON output')
).action((integrationName, opts) =>
  runCommand(
    opts,
    () => installNamedIntegration(resolveWorkspacePath(opts), integrationName, opts),
    renderInstalledIntegrationResult,
  )
);

addWorkspaceOption(
  integrationCmd
    .command('clawdapus')
    .description('Import Clawdapus SKILL.md into this workspace')
    .option('-a, --actor <name>', 'Agent name', DEFAULT_ACTOR)
    .option('--owner <name>', 'Skill owner override')
    .option('--title <title>', 'Skill title to store in workgraph', 'clawdapus')
    .option(
      '--source-url <url>',
      'Source URL for Clawdapus SKILL.md',
      workgraph.clawdapus.DEFAULT_CLAWDAPUS_SKILL_URL,
    )
    .option('--force', 'Overwrite an existing imported Clawdapus skill')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => installNamedIntegration(resolveWorkspacePath(opts), 'clawdapus', opts),
    renderInstalledIntegrationResult,
  )
);

// ============================================================================
// ledger
// ============================================================================

const ledgerCmd = program
  .command('ledger')
  .description('Inspect the append-only workgraph ledger');

addWorkspaceOption(
  ledgerCmd
    .command('show')
    .description('Show recent ledger entries')
    .option('-n, --count <n>', 'Number of entries', '20')
    .option('--actor <name>', 'Filter by actor')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const count = Number.parseInt(String(opts.count), 10);
      const safeCount = Number.isNaN(count) ? 20 : count;
      let entries = workgraph.ledger.recent(workspacePath, safeCount);
      if (opts.actor) entries = entries.filter(e => e.actor === opts.actor);
      return { entries, count: entries.length };
    },
    (result) => result.entries.map(e => `${e.ts} ${e.op} ${e.actor} ${e.target}`)
  )
);

addWorkspaceOption(
  ledgerCmd
    .command('history <targetPath>')
    .description('Show full history of a target path')
    .option('--json', 'Emit structured JSON output')
).action((targetPath, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const entries = workgraph.ledger.historyOf(workspacePath, targetPath);
      return { target: targetPath, entries, count: entries.length };
    },
    (result) => result.entries.map(e => `${e.ts} ${e.op} ${e.actor}`)
  )
);

addWorkspaceOption(
  ledgerCmd
    .command('claims')
    .description('Show active claims')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const claimsMap = workgraph.ledger.allClaims(workspacePath);
      const claims = [...claimsMap.entries()].map(([target, owner]) => ({ target, owner }));
      return { claims, count: claims.length };
    },
    (result) => result.claims.map(c => `${c.owner} -> ${c.target}`)
  )
);

addWorkspaceOption(
  ledgerCmd
    .command('query')
    .description('Query ledger with structured filters')
    .option('--actor <name>', 'Filter by actor')
    .option('--op <operation>', 'Filter by operation')
    .option('--type <primitiveType>', 'Filter by primitive type')
    .option('--target <path>', 'Filter by exact target path')
    .option('--target-includes <text>', 'Filter by target substring')
    .option('--since <iso>', 'Filter entries on/after ISO timestamp')
    .option('--until <iso>', 'Filter entries on/before ISO timestamp')
    .option('--limit <n>', 'Limit number of results')
    .option('--offset <n>', 'Offset into result set')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return {
        entries: workgraph.ledger.query(workspacePath, {
          actor: opts.actor,
          op: opts.op,
          type: opts.type,
          target: opts.target,
          targetIncludes: opts.targetIncludes,
          since: opts.since,
          until: opts.until,
          limit: opts.limit ? Number.parseInt(String(opts.limit), 10) : undefined,
          offset: opts.offset ? Number.parseInt(String(opts.offset), 10) : undefined,
        }),
      };
    },
    (result) => result.entries.map((entry) => `${entry.ts} ${entry.op} ${entry.actor} ${entry.target}`)
  )
);

addWorkspaceOption(
  ledgerCmd
    .command('blame <targetPath>')
    .description('Show actor attribution summary for one target')
    .option('--json', 'Emit structured JSON output')
).action((targetPath, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return workgraph.ledger.blame(workspacePath, targetPath);
    },
    (result) => [
      `Target: ${result.target}`,
      `Entries: ${result.totalEntries}`,
      ...result.actors.map((actor) => `${actor.actor}: ${actor.count} change(s)`),
    ]
  )
);

addWorkspaceOption(
  ledgerCmd
    .command('verify')
    .description('Verify tamper-evident ledger hash-chain integrity')
    .option('--strict', 'Treat missing hash fields as verification failures')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return workgraph.ledger.verifyHashChain(workspacePath, { strict: !!opts.strict });
    },
    (result) => [
      `Hash-chain valid: ${result.ok}`,
      `Entries: ${result.entries}`,
      `Last hash: ${result.lastHash}`,
      ...(result.issues.length > 0 ? result.issues.map((issue) => `ISSUE: ${issue}`) : []),
      ...(result.warnings.length > 0 ? result.warnings.map((warning) => `WARN: ${warning}`) : []),
    ]
  )
);

addWorkspaceOption(
  ledgerCmd
    .command('reconcile')
    .description('Audit thread files against ledger claims, leases, and dependency wiring')
    .option('--fail-on-issues', 'Exit non-zero when issues are found')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const report = workgraph.threadAudit.reconcileThreadState(workspacePath);
      if (opts.failOnIssues && !report.ok) {
        throw new Error(`Ledger reconcile found ${report.issues.length} issue(s).`);
      }
      return report;
    },
    (result) => [
      `Reconcile ok: ${result.ok}`,
      `Threads: ${result.totalThreads} Claims: ${result.totalClaims} Leases: ${result.totalLeases}`,
      ...(result.issues.length > 0
        ? result.issues.map((issue) => `${issue.kind}: ${issue.path} — ${issue.message}`)
        : ['No reconcile issues found.']),
    ]
  )
);

addWorkspaceOption(
  ledgerCmd
    .command('seal')
    .description('Rebuild ledger index + hash-chain state from ledger.jsonl')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const index = workgraph.ledger.rebuildIndex(workspacePath);
      const chain = workgraph.ledger.rebuildHashChainState(workspacePath);
      return {
        indexClaims: Object.keys(index.claims).length,
        chainCount: chain.count,
        chainLastHash: chain.lastHash,
      };
    },
    (result) => [
      `Rebuilt ledger index claims: ${result.indexClaims}`,
      `Rebuilt chain entries: ${result.chainCount}`,
    ]
  )
);

// ============================================================================
// diagnostics / developer experience
// ============================================================================

addWorkspaceOption(
  program
    .command('doctor')
    .description('Diagnose vault health, warnings, and repairable issues')
    .option('--fix', 'Auto-repair safe issues (orphan links, stale claims/runs)')
    .option('--stale-after-minutes <n>', 'Threshold for stale claims/runs in minutes', '60')
    .option('-a, --actor <name>', 'Actor used for --fix mutations', DEFAULT_ACTOR)
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const staleAfterMinutes = Number.parseInt(String(opts.staleAfterMinutes), 10);
      const safeStaleAfterMinutes = Number.isNaN(staleAfterMinutes) ? 60 : Math.max(1, staleAfterMinutes);
      return workgraph.diagnostics.diagnoseVaultHealth(workspacePath, {
        fix: !!opts.fix,
        actor: opts.actor,
        staleAfterMs: safeStaleAfterMinutes * 60 * 1000,
      });
    },
    (result) => workgraph.diagnostics.renderDoctorReport(result),
  )
);

addWorkspaceOption(
  program
    .command('replay')
    .description('Replay ledger events chronologically with typed filters')
    .option('--type <type>', 'create | update | transition')
    .option('--actor <name>', 'Filter by actor')
    .option('--primitive <ref>', 'Filter by primitive path/type substring')
    .option('--since <iso>', 'Filter events on/after ISO timestamp')
    .option('--until <iso>', 'Filter events on/before ISO timestamp')
    .option('--no-color', 'Disable colorized output')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return workgraph.diagnostics.replayLedger(workspacePath, {
        type: opts.type,
        actor: opts.actor,
        primitive: opts.primitive,
        since: opts.since,
        until: opts.until,
      });
    },
    (result) => workgraph.diagnostics.renderReplayText(result, {
      color: opts.color !== false && !wantsJson(opts),
    }),
  )
);

addWorkspaceOption(
  program
    .command('viz')
    .description('Render an ASCII wiki-link graph of primitives in this vault')
    .option('--focus <slugOrPath>', 'Center the graph on a specific node')
    .option('--depth <n>', 'Traversal depth from each root', '2')
    .option('--top <n>', 'When large, show top N most-connected roots', '10')
    .option('--no-color', 'Disable colorized output')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const parsedDepth = Number.parseInt(String(opts.depth), 10);
      const parsedTop = Number.parseInt(String(opts.top), 10);
      return workgraph.diagnostics.visualizeVaultGraph(workspacePath, {
        focus: opts.focus,
        depth: Number.isNaN(parsedDepth) ? 2 : Math.max(1, parsedDepth),
        top: Number.isNaN(parsedTop) ? 10 : Math.max(1, parsedTop),
        color: opts.color !== false && !wantsJson(opts),
      });
    },
    (result) => [
      ...result.rendered.split('\n'),
      '',
      `Nodes: ${result.nodeCount}`,
      `Edges: ${result.edgeCount}`,
      ...(result.focus ? [`Focus: ${result.focus}`] : []),
    ],
  )
);

addWorkspaceOption(
  program
    .command('stats')
    .description('Show detailed vault statistics and graph/ledger health metrics')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return workgraph.diagnostics.computeVaultStats(workspacePath);
    },
    (result) => workgraph.diagnostics.renderStatsReport(result),
  )
);

addWorkspaceOption(
  program
    .command('changelog')
    .description('Generate a human-readable changelog from ledger events')
    .requiredOption('--since <date>', 'Include entries on/after this date (ISO-8601)')
    .option('--until <date>', 'Include entries on/before this date (ISO-8601)')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return workgraph.diagnostics.generateLedgerChangelog(workspacePath, {
        since: opts.since,
        until: opts.until,
      });
    },
    (result) => workgraph.diagnostics.renderChangelogText(result),
  )
);

addWorkspaceOption(
  program
    .command('command-center')
    .description('Generate a markdown command center from workgraph state')
    .option('-a, --actor <name>', 'Agent name', DEFAULT_ACTOR)
    .option('-o, --output <path>', 'Output markdown path', 'Command Center.md')
    .option('-n, --recent <count>', 'Recent ledger entries to include', '15')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const parsedRecent = Number.parseInt(String(opts.recent), 10);
      const safeRecent = Number.isNaN(parsedRecent) ? 15 : parsedRecent;
      return workgraph.commandCenter.generateCommandCenter(workspacePath, {
        actor: opts.actor,
        outputPath: opts.output,
        recentCount: safeRecent,
      });
    },
    (result) => [
      `Generated command center: ${result.outputPath}`,
      `Threads: total=${result.stats.totalThreads} open=${result.stats.openThreads} active=${result.stats.activeThreads} blocked=${result.stats.blockedThreads}`,
      `Claims: ${result.stats.activeClaims} Recent events: ${result.stats.recentEvents}`,
    ]
  )
);

// ============================================================================
// orientation
// ============================================================================

addWorkspaceOption(
  program
    .command('status')
    .description('Show workspace situational status snapshot')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return workgraph.orientation.statusSnapshot(workspacePath);
    },
    (result) => [
      `Threads: total=${result.threads.total} open=${result.threads.open} active=${result.threads.active} blocked=${result.threads.blocked} done=${result.threads.done}`,
      `Ready threads: ${result.threads.ready} Active claims: ${result.claims.active}`,
      `Primitive types: ${Object.keys(result.primitives.byType).length}`,
    ],
  )
);

addWorkspaceOption(
  program
    .command('brief')
    .description('Show actor-centric operational brief')
    .option('-a, --actor <name>', 'Agent name', DEFAULT_ACTOR)
    .option('--recent <count>', 'Recent activity count', '12')
    .option('--next <count>', 'Next ready threads to include', '5')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return workgraph.orientation.brief(workspacePath, opts.actor, {
        recentCount: Number.parseInt(String(opts.recent), 10),
        nextCount: Number.parseInt(String(opts.next), 10),
      });
    },
    (result) => [
      `Brief for ${result.actor}`,
      `My claims: ${result.myClaims.length}`,
      `Blocked threads: ${result.blockedThreads.length}`,
      `Next ready: ${result.nextReadyThreads.map((item) => item.path).join(', ') || 'none'}`,
    ],
  )
);

addWorkspaceOption(
  program
    .command('checkpoint <summary>')
    .description('Create a checkpoint primitive for hand-off continuity')
    .option('-a, --actor <name>', 'Agent name', DEFAULT_ACTOR)
    .option('--next <items>', 'Comma-separated next actions')
    .option('--blocked <items>', 'Comma-separated blockers')
    .option('--tags <items>', 'Comma-separated tags')
    .option('--json', 'Emit structured JSON output')
).action((summary, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return {
        checkpoint: workgraph.orientation.checkpoint(workspacePath, opts.actor, summary, {
          next: csv(opts.next),
          blocked: csv(opts.blocked),
          tags: csv(opts.tags),
        }),
      };
    },
    (result) => [`Created checkpoint: ${result.checkpoint.path}`],
  )
);

addWorkspaceOption(
  program
    .command('intake <observation>')
    .description('Capture intake observation as lightweight checkpoint note')
    .option('-a, --actor <name>', 'Agent name', DEFAULT_ACTOR)
    .option('--tags <items>', 'Comma-separated tags')
    .option('--json', 'Emit structured JSON output')
).action((observation, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return {
        intake: workgraph.orientation.intake(workspacePath, opts.actor, observation, {
          tags: csv(opts.tags),
        }),
      };
    },
    (result) => [`Captured intake: ${result.intake.path}`],
  )
);

// ============================================================================
// lenses
// ============================================================================

const lensCmd = program
  .command('lens')
  .description('Generate deterministic context lenses for situational awareness');

addWorkspaceOption(
  lensCmd
    .command('list')
    .description('List built-in context lenses')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => ({
      lenses: workgraph.lens.listContextLenses(),
    }),
    (result) => result.lenses.map((lens) => `lens://${lens.id} - ${lens.description}`)
  )
);

addWorkspaceOption(
  lensCmd
    .command('show <lensId>')
    .description('Generate one context lens snapshot')
    .option('-a, --actor <name>', 'Actor identity for actor-scoped lenses', DEFAULT_ACTOR)
    .option('--lookback-hours <hours>', 'Lookback window in hours', '24')
    .option('--stale-hours <hours>', 'Stale threshold in hours', '24')
    .option('--limit <n>', 'Maximum items per section', '10')
    .option('-o, --output <path>', 'Write lens markdown to workspace-relative output path')
    .option('--json', 'Emit structured JSON output')
).action((lensId, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const lensOptions = {
        actor: opts.actor,
        lookbackHours: parsePositiveNumberOption(opts.lookbackHours, 'lookback-hours'),
        staleHours: parsePositiveNumberOption(opts.staleHours, 'stale-hours'),
        limit: parsePositiveIntegerOption(opts.limit, 'limit'),
      };
      if (opts.output) {
        return workgraph.lens.materializeContextLens(workspacePath, lensId, {
          ...lensOptions,
          outputPath: opts.output,
        });
      }
      return workgraph.lens.generateContextLens(workspacePath, lensId, lensOptions);
    },
    (result) => {
      const metricSummary = Object.entries(result.metrics)
        .map(([metric, value]) => `${metric}=${value}`)
        .join(' ');
      const sectionSummary = result.sections
        .map((section) => `${section.id}:${section.items.length}`)
        .join(' ');
      const lines = [
        `Lens: ${result.lens}`,
        `Generated: ${result.generatedAt}`,
        ...(result.actor ? [`Actor: ${result.actor}`] : []),
        `Metrics: ${metricSummary || 'none'}`,
        `Sections: ${sectionSummary || 'none'}`,
      ];
      if (isMaterializedLensResult(result)) {
        lines.push(`Saved markdown: ${result.outputPath}`);
        return lines;
      }
      return [...lines, '', ...result.markdown.split('\n')];
    },
  )
);

// ============================================================================
// query/search
// ============================================================================

addWorkspaceOption(
  program
    .command('query')
    .description('Query primitive instances with multi-field filters')
    .option('--type <type>', 'Primitive type')
    .option('--status <status>', 'Status value')
    .option('--owner <owner>', 'Owner/actor value')
    .option('--tag <tag>', 'Tag filter')
    .option('--text <text>', 'Full-text contains filter')
    .option('--path-includes <text>', 'Path substring filter')
    .option('--updated-after <iso>', 'Updated at or after')
    .option('--updated-before <iso>', 'Updated at or before')
    .option('--created-after <iso>', 'Created at or after')
    .option('--created-before <iso>', 'Created at or before')
    .option('--limit <n>', 'Result limit')
    .option('--offset <n>', 'Result offset')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const results = workgraph.query.queryPrimitives(workspacePath, {
        type: opts.type,
        status: opts.status,
        owner: opts.owner,
        tag: opts.tag,
        text: opts.text,
        pathIncludes: opts.pathIncludes,
        updatedAfter: opts.updatedAfter,
        updatedBefore: opts.updatedBefore,
        createdAfter: opts.createdAfter,
        createdBefore: opts.createdBefore,
        limit: opts.limit ? Number.parseInt(String(opts.limit), 10) : undefined,
        offset: opts.offset ? Number.parseInt(String(opts.offset), 10) : undefined,
      });
      return { results, count: results.length };
    },
    (result) => result.results.map((item) => `${item.type} ${item.path}`),
  )
);

addWorkspaceOption(
  program
    .command('search <text>')
    .description('Keyword search across markdown body/frontmatter with optional QMD-compatible mode')
    .option('--type <type>', 'Limit to primitive type')
    .option('--mode <mode>', 'auto | core | qmd', 'auto')
    .option('--limit <n>', 'Result limit')
    .option('--json', 'Emit structured JSON output')
).action((text, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const result = workgraph.searchQmdAdapter.search(workspacePath, text, {
        mode: opts.mode,
        type: opts.type,
        limit: opts.limit ? Number.parseInt(String(opts.limit), 10) : undefined,
      });
      return {
        ...result,
        count: result.results.length,
      };
    },
    (result) => [
      `Mode: ${result.mode}`,
      ...(result.fallbackReason ? [`Note: ${result.fallbackReason}`] : []),
      ...result.results.map((item) => `${item.type} ${item.path}`),
    ],
  )
);

// ============================================================================
// board/graph
// ============================================================================

const boardCmd = program
  .command('board')
  .description('Generate and sync Obsidian Kanban board views');

addWorkspaceOption(
  boardCmd
    .command('generate')
    .description('Generate Obsidian Kanban board markdown from thread states')
    .option('-o, --output <path>', 'Output board path', 'ops/Workgraph Board.md')
    .option('--include-cancelled', 'Include cancelled lane')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return workgraph.board.generateKanbanBoard(workspacePath, {
        outputPath: opts.output,
        includeCancelled: !!opts.includeCancelled,
      });
    },
    (result) => [
      `Generated board: ${result.outputPath}`,
      `Backlog=${result.counts.backlog} InProgress=${result.counts.inProgress} Blocked=${result.counts.blocked} Done=${result.counts.done}`,
    ],
  )
);

addWorkspaceOption(
  boardCmd
    .command('sync')
    .description('Sync existing board markdown from current thread states')
    .option('-o, --output <path>', 'Output board path', 'ops/Workgraph Board.md')
    .option('--include-cancelled', 'Include cancelled lane')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return workgraph.board.syncKanbanBoard(workspacePath, {
        outputPath: opts.output,
        includeCancelled: !!opts.includeCancelled,
      });
    },
    (result) => [
      `Synced board: ${result.outputPath}`,
      `Backlog=${result.counts.backlog} InProgress=${result.counts.inProgress} Blocked=${result.counts.blocked} Done=${result.counts.done}`,
    ],
  )
);

const graphCmd = program
  .command('graph')
  .description('Wiki-link graph indexing and hygiene');

addWorkspaceOption(
  graphCmd
    .command('index')
    .description('Build wiki-link graph index')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return workgraph.graph.refreshWikiLinkGraphIndex(workspacePath);
    },
    (result) => [
      `Nodes: ${result.nodes.length}`,
      `Edges: ${result.edges.length}`,
      `Broken links: ${result.brokenLinks.length}`,
    ],
  )
);

addWorkspaceOption(
  graphCmd
    .command('hygiene')
    .description('Generate graph hygiene report (orphans, broken links, hubs)')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return workgraph.graph.graphHygieneReport(workspacePath);
    },
    (result) => [
      `Nodes=${result.nodeCount} Edges=${result.edgeCount}`,
      `Orphans=${result.orphanCount} BrokenLinks=${result.brokenLinkCount}`,
      `Top hub: ${result.hubs[0]?.node ?? 'none'}`,
    ],
  )
);

addWorkspaceOption(
  graphCmd
    .command('neighborhood <slug>')
    .description('Find connected primitives within N wiki-link hops')
    .option('--depth <n>', 'Traversal depth (default: 2)', '2')
    .option('--refresh', 'Refresh graph index before querying')
    .option('--json', 'Emit structured JSON output')
).action((slug, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return workgraph.graph.graphNeighborhoodQuery(workspacePath, slug, {
        depth: parseNonNegativeIntOption(opts.depth, 'depth'),
        refresh: !!opts.refresh,
      });
    },
    (result) => [
      `Center: ${result.center.path} (${result.center.exists ? 'exists' : 'missing'})`,
      `Depth: ${result.depth}`,
      `Connected nodes: ${result.connectedNodes.length}`,
      `Edges in neighborhood: ${result.edges.length}`,
    ],
  )
);

addWorkspaceOption(
  graphCmd
    .command('impact <slug>')
    .description('Analyze reverse-link impact for a primitive')
    .option('--refresh', 'Refresh graph index before querying')
    .option('--json', 'Emit structured JSON output')
).action((slug, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return workgraph.graph.graphImpactAnalysis(workspacePath, slug, {
        refresh: !!opts.refresh,
      });
    },
    (result) => [
      `Target: ${result.target.path} (${result.target.exists ? 'exists' : 'missing'})`,
      `Total references: ${result.totalReferences}`,
      ...result.groups.map((group) => `${group.type}: ${group.referenceCount}`),
    ],
  )
);

addWorkspaceOption(
  graphCmd
    .command('context <slug>')
    .description('Assemble token-budgeted markdown context from graph neighborhood')
    .option('--budget <tokens>', 'Approx token budget (chars/4)', '2000')
    .option('--refresh', 'Refresh graph index before querying')
    .option('--json', 'Emit structured JSON output')
).action((slug, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return workgraph.graph.graphContextAssembly(workspacePath, slug, {
        budgetTokens: parsePositiveIntOption(opts.budget, 'budget'),
        refresh: !!opts.refresh,
      });
    },
    (result) => [
      `Center: ${result.center.path}`,
      `Budget: ${result.budgetTokens} tokens`,
      `Used: ${result.usedTokens} tokens`,
      `Sections: ${result.sections.length}`,
      '',
      result.markdown,
    ],
  )
);

addWorkspaceOption(
  graphCmd
    .command('edges <slug>')
    .description('Show typed incoming/outgoing edges for one primitive')
    .option('--refresh', 'Refresh graph index before querying')
    .option('--json', 'Emit structured JSON output')
).action((slug, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return workgraph.graph.graphTypedEdges(workspacePath, slug, {
        refresh: !!opts.refresh,
      });
    },
    (result) => [
      `Node: ${result.node.path} (${result.node.exists ? 'exists' : 'missing'})`,
      `Outgoing edges: ${result.outgoing.length}`,
      `Incoming edges: ${result.incoming.length}`,
      ...result.outgoing.map((edge) => `OUT ${edge.type} ${edge.from} -> ${edge.to}`),
      ...result.incoming.map((edge) => `IN  ${edge.type} ${edge.from} -> ${edge.to}`),
    ],
  )
);

addWorkspaceOption(
  graphCmd
    .command('export <slug>')
    .description('Export a markdown subgraph directory around a center primitive')
    .option('--depth <n>', 'Traversal depth (default: 2)', '2')
    .option('--format <format>', 'Export format (default: md)', 'md')
    .option('--output-dir <path>', 'Output directory (default under .workgraph/graph-exports)')
    .option('--refresh', 'Refresh graph index before querying')
    .option('--json', 'Emit structured JSON output')
).action((slug, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const format = String(opts.format ?? 'md').trim().toLowerCase();
      if (format !== 'md') {
        throw new Error(`Invalid --format "${opts.format}". Supported formats: md.`);
      }
      return workgraph.graph.graphExportSubgraph(workspacePath, slug, {
        depth: parseNonNegativeIntOption(opts.depth, 'depth'),
        format,
        outputDir: opts.outputDir,
        refresh: !!opts.refresh,
      });
    },
    (result) => [
      `Exported subgraph: ${result.outputDirectory}`,
      `Center: ${result.center.path}`,
      `Depth: ${result.depth}`,
      `Nodes: ${result.exportedNodes.length}`,
      `Edges: ${result.exportedEdgeCount}`,
      `Manifest: ${result.manifestPath}`,
    ],
  )
);

addWorkspaceOption(
  graphCmd
    .command('neighbors <nodePath>')
    .description('Query incoming/outgoing wiki-link neighbors for one node')
    .option('--refresh', 'Refresh graph index before querying')
    .option('--json', 'Emit structured JSON output')
).action((nodePath, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return workgraph.graph.graphNeighborhood(workspacePath, nodePath, {
        refresh: !!opts.refresh,
      });
    },
    (result) => [
      `Node: ${result.node} (${result.exists ? 'exists' : 'missing'})`,
      `Outgoing: ${result.outgoing.length}`,
      `Incoming: ${result.incoming.length}`,
    ],
  )
);

// ============================================================================
// policy
// ============================================================================

const policyCmd = program
  .command('policy')
  .description('Manage policy parties and capabilities');

const policyPartyCmd = policyCmd
  .command('party')
  .description('Manage registered policy parties');

addWorkspaceOption(
  policyPartyCmd
    .command('upsert <id>')
    .description('Create or update a policy party')
    .option('--roles <roles>', 'Comma-separated roles')
    .option('--capabilities <caps>', 'Comma-separated capabilities')
    .option('--json', 'Emit structured JSON output')
).action((id, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return {
        party: workgraph.policy.upsertParty(workspacePath, id, {
          roles: csv(opts.roles),
          capabilities: csv(opts.capabilities),
        }),
      };
    },
    (result) => [`Upserted policy party: ${result.party.id}`],
  )
);

addWorkspaceOption(
  policyPartyCmd
    .command('get <id>')
    .description('Get one policy party')
    .option('--json', 'Emit structured JSON output')
).action((id, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const party = workgraph.policy.getParty(workspacePath, id);
      if (!party) throw new Error(`Policy party not found: ${id}`);
      return { party };
    },
    (result) => [`${result.party.id} roles=${result.party.roles.join(',')}`],
  )
);

addWorkspaceOption(
  policyPartyCmd
    .command('list')
    .description('List policy parties')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const registry = workgraph.policy.loadPolicyRegistry(workspacePath);
      return {
        parties: Object.values(registry.parties),
      };
    },
    (result) => result.parties.map((party) => `${party.id} [${party.roles.join(', ')}]`),
  )
);

// ============================================================================
// gate
// ============================================================================

const gateCmd = program
  .command('gate')
  .description('Evaluate thread quality gates before claim');

addWorkspaceOption(
  gateCmd
    .command('check <threadRef>')
    .description('Check policy-gate status for one thread')
    .option('--json', 'Emit structured JSON output')
).action((threadRef, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return workgraph.gate.checkThreadGates(workspacePath, threadRef);
    },
    (result) => {
      const header = [`Gate check for ${result.threadPath}: ${result.allowed ? 'PASSED' : 'FAILED'}`];
      if (result.gates.length === 0) {
        return [...header, 'No gates configured.'];
      }
      const details = result.gates.map((gate) => {
        const failingRules = gate.rules.filter((rule) => !rule.ok);
        const gateLabel = gate.gatePath ?? gate.gateRef;
        if (failingRules.length === 0) {
          return `[pass] ${gateLabel}`;
        }
        return `[fail] ${gateLabel} :: ${failingRules.map((rule) => rule.message).join('; ')}`;
      });
      return [...header, ...details];
    },
  )
);

// ============================================================================
// dispatch
// ============================================================================

registerDispatchCommands(program, DEFAULT_ACTOR);

// ============================================================================
// trigger
// ============================================================================

registerTriggerCommands(program, DEFAULT_ACTOR);

// ============================================================================
// webhook gateway
// ============================================================================

registerWebhookCommands(program, DEFAULT_ACTOR);

// ============================================================================
// conversation + plan-step
// ============================================================================

registerConversationCommands(program, DEFAULT_ACTOR);

// ============================================================================
// onboarding
// ============================================================================

addWorkspaceOption(
  program
    .command('onboard')
    .description('Guided agent-first workspace setup and starter artifacts')
    .option('-a, --actor <name>', 'Actor', DEFAULT_ACTOR)
    .option('--spaces <list>', 'Comma-separated space names')
    .option('--no-demo-threads', 'Skip starter onboarding threads')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return workgraph.onboard.onboardWorkspace(workspacePath, {
        actor: opts.actor,
        spaces: csv(opts.spaces),
        createDemoThreads: opts.demoThreads,
      });
    },
    (result) => [
      `Onboarded actor: ${result.actor}`,
      `Spaces created: ${result.spacesCreated.length}`,
      `Threads created: ${result.threadsCreated.length}`,
      `Board: ${result.boardPath}`,
      `Command center: ${result.commandCenterPath}`,
      `Onboarding primitive: ${result.onboardingPath}`,
    ],
  )
);

const onboardingCmd = program
  .command('onboarding')
  .description('Manage onboarding primitive lifecycle');

addWorkspaceOption(
  onboardingCmd
    .command('show <onboardingPath>')
    .description('Show one onboarding primitive')
    .option('--json', 'Emit structured JSON output')
).action((onboardingPath, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const onboarding = workgraph.store.read(workspacePath, onboardingPath);
      if (!onboarding) throw new Error(`Onboarding primitive not found: ${onboardingPath}`);
      if (onboarding.type !== 'onboarding') throw new Error(`Target is not onboarding primitive: ${onboardingPath}`);
      return { onboarding };
    },
    (result) => [
      `Onboarding: ${result.onboarding.path}`,
      `Status: ${String(result.onboarding.fields.status)}`,
      `Actor: ${String(result.onboarding.fields.actor)}`,
    ],
  )
);

addWorkspaceOption(
  onboardingCmd
    .command('update <onboardingPath>')
    .description('Update onboarding lifecycle status')
    .requiredOption('--status <status>', 'active|paused|completed')
    .option('-a, --actor <name>', 'Actor', DEFAULT_ACTOR)
    .option('--json', 'Emit structured JSON output')
).action((onboardingPath, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return {
        onboarding: workgraph.onboard.updateOnboardingStatus(
          workspacePath,
          onboardingPath,
          normalizeOnboardingStatus(opts.status),
          opts.actor,
        ),
      };
    },
    (result) => [`Updated onboarding: ${result.onboarding.path} [${String(result.onboarding.fields.status)}]`],
  )
);

// ============================================================================
// autonomy
// ============================================================================

registerAutonomyCommands(program, DEFAULT_ACTOR);

// ============================================================================
// serve (http server)
// ============================================================================

addWorkspaceOption(
  program
    .command('serve')
    .description('Serve Workgraph HTTP MCP server + REST API')
    .option('--port <port>', 'HTTP port (defaults to server config or 8787)')
    .option('--host <host>', 'Bind host (defaults to server config or 0.0.0.0)')
    .option('--token <token>', 'Optional bearer token for MCP + REST auth')
    .option('-a, --actor <name>', 'Default actor for thread mutations'),
).action(async (opts) => {
  const workspacePath = resolveWorkspacePath(opts);
  const serverConfig = workgraph.serverConfig.loadServerConfig(workspacePath);
  const port = opts.port !== undefined
    ? parsePortOption(opts.port)
    : (serverConfig?.port ?? 8787);
  const host = opts.host
    ? String(opts.host)
    : (serverConfig?.host ?? '0.0.0.0');
  const defaultActor = opts.actor
    ? String(opts.actor)
    : (serverConfig?.defaultActor ?? DEFAULT_ACTOR);
  const endpointPath = serverConfig?.endpointPath;
  const bearerToken = opts.token
    ? String(opts.token)
    : serverConfig?.bearerToken;
  const handle = await startWorkgraphServer({
    workspacePath,
    host,
    port,
    endpointPath,
    bearerToken,
    defaultActor,
  });
  console.log(`Server URL: ${handle.baseUrl}`);
  console.log(`MCP endpoint: ${handle.url}`);
  console.log(`Health: ${handle.healthUrl}`);
  console.log(`Status API: ${handle.baseUrl}/api/status`);
  await waitForShutdown(handle, {
    onSignal: (signal) => {
      console.error(`Received ${signal}; shutting down...`);
    },
    onClosed: () => {
      console.error('Server stopped.');
    },
  });
});

// ============================================================================
// mcp
// ============================================================================

registerMcpCommands(program, DEFAULT_ACTOR);

// ============================================================================
// swarm
// ============================================================================

const swarmCmd = program
  .command('swarm')
  .description('Decompose goals into tasks and orchestrate agent swarms');

addWorkspaceOption(
  swarmCmd
    .command('deploy <planFile>')
    .description('Deploy a swarm plan (JSON) into the workspace as threads')
    .option('-a, --actor <name>', 'Actor name', DEFAULT_ACTOR)
    .option('--json', 'Emit structured JSON output')
).action((planFile, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const planPath = path.resolve(planFile);
      const planData = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
      return workgraph.swarm.deployPlan(workspacePath, planData, opts.actor);
    },
    (result) => [
      `Swarm deployed: ${result.spaceSlug}`,
      `Threads: ${result.threadPaths.length}`,
      `Status: ${result.status}`,
    ],
  )
);

addWorkspaceOption(
  swarmCmd
    .command('status <spaceSlug>')
    .description('Show swarm progress')
    .option('--json', 'Emit structured JSON output')
).action((spaceSlug, opts) =>
  runCommand(
    opts,
    () => workgraph.swarm.getSwarmStatus(resolveWorkspacePath(opts), spaceSlug),
    (result) => [
      `Swarm: ${result.deployment.spaceSlug} [${result.deployment.status}]`,
      `Progress: ${result.done}/${result.total} (${result.percentComplete}%)`,
      `Claimed: ${result.claimed} | Open: ${result.open} | Blocked: ${result.blocked}`,
      `Ready to claim: ${result.readyToClaim}`,
    ],
  )
);

addWorkspaceOption(
  swarmCmd
    .command('claim <spaceSlug>')
    .description('Claim the next available task in a swarm')
    .option('-a, --actor <name>', 'Worker agent name', DEFAULT_ACTOR)
    .option('--json', 'Emit structured JSON output')
).action((spaceSlug, opts) =>
  runCommand(
    opts,
    () => {
      const result = workgraph.swarm.workerClaim(resolveWorkspacePath(opts), spaceSlug, opts.actor);
      if (!result) return { claimed: false, message: 'No tasks available' };
      return { claimed: true, path: result.path, title: result.fields.title };
    },
    (result) => result.claimed
      ? [`Claimed: ${result.path} — ${result.title}`]
      : ['No tasks available to claim'],
  )
);

addWorkspaceOption(
  swarmCmd
    .command('complete <threadPath>')
    .description('Mark a swarm task as done with result')
    .option('-a, --actor <name>', 'Worker agent name', DEFAULT_ACTOR)
    .requiredOption('--result <text>', 'Result text (or @file to read from file)')
    .option('--json', 'Emit structured JSON output')
).action((threadPath, opts) =>
  runCommand(
    opts,
    () => {
      let resultText = opts.result;
      if (resultText.startsWith('@')) {
        resultText = fs.readFileSync(resultText.slice(1), 'utf-8');
      }
      return workgraph.swarm.workerComplete(resolveWorkspacePath(opts), threadPath, opts.actor, resultText);
    },
    (result) => [`Completed: ${result.path}`],
  )
);

addWorkspaceOption(
  swarmCmd
    .command('synthesize <spaceSlug>')
    .description('Merge all completed task results into a single document')
    .option('-o, --output <file>', 'Output file path')
    .option('--json', 'Emit structured JSON output')
).action((spaceSlug, opts) =>
  runCommand(
    opts,
    () => {
      const result = workgraph.swarm.synthesize(resolveWorkspacePath(opts), spaceSlug);
      if (opts.output) {
        fs.writeFileSync(path.resolve(opts.output), result.markdown);
      }
      return result;
    },
    (result) => [
      `Synthesized: ${result.completedCount}/${result.totalCount} tasks`,
      opts.output ? `Written to: ${opts.output}` : result.markdown,
    ],
  )
);

await program.parseAsync();

function isMaterializedLensResult(
  value: workgraph.WorkgraphLensResult | workgraph.WorkgraphMaterializedLensResult,
): value is workgraph.WorkgraphMaterializedLensResult {
  return typeof (value as workgraph.WorkgraphMaterializedLensResult).outputPath === 'string';
}

function normalizeAgentPresenceStatus(status: string): 'online' | 'busy' | 'offline' {
  const normalized = String(status).toLowerCase();
  if (normalized === 'online' || normalized === 'busy' || normalized === 'offline') {
    return normalized;
  }
  throw new Error(`Invalid agent status "${status}". Expected online|busy|offline.`);
}

function normalizeOnboardingStatus(status: string): 'active' | 'paused' | 'completed' {
  const normalized = String(status).toLowerCase();
  if (normalized === 'active' || normalized === 'paused' || normalized === 'completed') {
    return normalized;
  }
  throw new Error(`Invalid onboarding status "${status}". Expected active|paused|completed.`);
}
