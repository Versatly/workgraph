import { Command } from 'commander';
import * as workgraph from '@versatly/workgraph-kernel';
import { startWorkgraphMcpHttpServer } from '@versatly/workgraph-mcp-server';
import { registerConversationCommands } from './cli/commands/conversation.js';
import { registerMcpCommands } from './cli/commands/mcp.js';
import {
  addWorkspaceOption,
  csv,
  parseNonNegativeIntOption,
  parsePositiveIntOption,
  parsePositiveIntegerOption,
  parseSetPairs,
  parsePortOption,
  resolveWorkspacePath,
  resolveInitTargetPath,
  runCommand,
  wantsJson,
} from './cli/core.js';

const CLI_VERSION = '3.2.2';
const DEFAULT_ACTOR = process.env.WORKGRAPH_ACTOR?.trim() || 'agent';

const program = new Command();

program
  .name('workgraph')
  .description('Context graph, thread collaboration, MCP exposure, and actor registration.')
  .version(CLI_VERSION)
  .showHelpAfterError();

addWorkspaceOption(
  program
    .command('init [path]')
    .description('Initialize a workgraph workspace')
    .option('--name <name>', 'Workspace name')
    .option('--no-readme', 'Skip README/QUICKSTART generation')
    .option('--no-bases', 'Skip base file generation')
    .option('--json', 'Emit structured JSON output'),
).action((targetPath, opts) =>
  runCommand(
    opts,
    () => workgraph.workspace.initWorkspace(resolveInitTargetPath(targetPath, opts), {
      name: opts.name,
      createReadme: opts.readme,
      createBases: opts.bases,
    }),
    (result) => [
      `Initialized workspace: ${result.workspacePath}`,
      `Bootstrap trust token path: ${result.bootstrapTrustTokenPath}`,
      `Server config: ${result.serverConfigPath}`,
    ],
  ),
);

const threadCmd = program
  .command('thread')
  .description('Coordinate work through collaborative threads');

addWorkspaceOption(
  threadCmd
    .command('create <title>')
    .description('Create a thread')
    .requiredOption('--goal <text>', 'Thread goal')
    .option('-a, --actor <name>', 'Actor', DEFAULT_ACTOR)
    .option('--priority <level>', 'urgent|high|medium|low', 'medium')
    .option('--deps <refs>', 'Comma-separated dependency thread refs')
    .option('--parent <ref>', 'Parent thread ref')
    .option('--space <ref>', 'Space ref')
    .option('--context-refs <refs>', 'Comma-separated context refs')
    .option('--tags <tags>', 'Comma-separated tags')
    .option('--json', 'Emit structured JSON output'),
).action((title, opts) =>
  runCommand(
    opts,
    () => workgraph.thread.createThread(resolveWorkspacePath(opts), title, opts.goal, opts.actor, {
      priority: normalizePriority(opts.priority),
      deps: csv(opts.deps),
      parent: opts.parent,
      space: opts.space,
      context_refs: csv(opts.contextRefs),
      tags: csv(opts.tags),
    }),
    (result) => [
      `Created thread: ${result.path}`,
      `Status: ${String(result.fields.status)}`,
      `Priority: ${String(result.fields.priority)}`,
    ],
  ),
);

addWorkspaceOption(
  threadCmd
    .command('list')
    .description('List threads')
    .option('--status <status>', 'Filter by status')
    .option('--space <ref>', 'Filter by space')
    .option('--ready', 'Only show ready threads')
    .option('--json', 'Emit structured JSON output'),
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      let threads = opts.space
        ? workgraph.store.threadsInSpace(workspacePath, opts.space)
        : workgraph.store.list(workspacePath, 'thread');
      if (opts.status) {
        threads = threads.filter((entry) => String(entry.fields.status) === opts.status);
      }
      if (opts.ready) {
        const readySet = new Set(
          (opts.space
            ? workgraph.thread.listReadyThreadsInSpace(workspacePath, opts.space)
            : workgraph.thread.listReadyThreads(workspacePath)).map((entry) => entry.path),
        );
        threads = threads.filter((entry) => readySet.has(entry.path));
      }
      return { threads, count: threads.length };
    },
    (result) => {
      if (result.threads.length === 0) return ['No threads found.'];
      return [
        ...result.threads.map((entry) =>
          `[${String(entry.fields.status)}] ${String(entry.fields.priority)} ${String(entry.fields.title)} -> ${entry.path}`),
        `${result.count} thread(s)`,
      ];
    },
  ),
);

addWorkspaceOption(
  threadCmd
    .command('next')
    .description('Show or claim the next ready thread')
    .option('-a, --actor <name>', 'Actor', DEFAULT_ACTOR)
    .option('--space <ref>', 'Limit to one space')
    .option('--claim', 'Claim the next ready thread')
    .option('--json', 'Emit structured JSON output'),
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      if (opts.claim) {
        return {
          thread: opts.space
            ? workgraph.thread.claimNextReadyInSpace(workspacePath, opts.actor, opts.space)
            : workgraph.thread.claimNextReady(workspacePath, opts.actor),
        };
      }
      return {
        thread: opts.space
          ? workgraph.thread.pickNextReadyThreadInSpace(workspacePath, opts.space)
          : workgraph.thread.pickNextReadyThread(workspacePath),
      };
    },
    (result) => result.thread
      ? [
          `Thread: ${result.thread.path}`,
          `Title: ${String(result.thread.fields.title)}`,
          `Priority: ${String(result.thread.fields.priority)}`,
        ]
      : ['No ready thread found.'],
  ),
);

addWorkspaceOption(
  threadCmd
    .command('show <threadPath>')
    .description('Show one thread and its ledger history')
    .option('--json', 'Emit structured JSON output'),
).action((threadPath, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const thread = workgraph.store.read(workspacePath, normalizePath(threadPath));
      if (!thread) throw new Error(`Thread not found: ${threadPath}`);
      return {
        thread,
        history: workgraph.ledger.historyOf(workspacePath, thread.path),
      };
    },
    (result) => [
      `Thread: ${result.thread.path}`,
      `Status: ${String(result.thread.fields.status)}`,
      `Owner: ${String(result.thread.fields.owner ?? 'none')}`,
      `Ledger entries: ${result.history.length}`,
    ],
  ),
);

addWorkspaceOption(
  threadCmd
    .command('participants <threadPath>')
    .description('List thread participants')
    .option('--json', 'Emit structured JSON output'),
).action((threadPath, opts) =>
  runCommand(
    opts,
    () => ({
      participants: workgraph.thread.listThreadParticipants(resolveWorkspacePath(opts), normalizePath(threadPath)),
    }),
    (result) => result.participants.length > 0
      ? result.participants.map((entry) => `${entry.actor} (${entry.role})`)
      : ['No participants recorded.'],
  ),
);

addWorkspaceOption(
  threadCmd
    .command('invite <threadPath>')
    .description('Invite another participant onto a thread')
    .requiredOption('--participant <name>', 'Participant actor')
    .option('-a, --actor <name>', 'Actor', DEFAULT_ACTOR)
    .option('--role <role>', 'owner|contributor|reviewer|observer', 'contributor')
    .option('--json', 'Emit structured JSON output'),
).action((threadPath, opts) =>
  runCommand(
    opts,
    () => workgraph.thread.inviteThreadParticipant(
      resolveWorkspacePath(opts),
      normalizePath(threadPath),
      opts.actor,
      opts.participant,
      normalizeParticipantRole(opts.role),
    ),
    (result) => [`Updated participants for ${result.path}.`],
  ),
);

addWorkspaceOption(
  threadCmd
    .command('join <threadPath>')
    .description('Join a thread as a participant')
    .option('-a, --actor <name>', 'Actor', DEFAULT_ACTOR)
    .option('--role <role>', 'contributor|reviewer|observer', 'contributor')
    .option('--json', 'Emit structured JSON output'),
).action((threadPath, opts) =>
  runCommand(
    opts,
    () => workgraph.thread.joinThread(
      resolveWorkspacePath(opts),
      normalizePath(threadPath),
      opts.actor,
      normalizeParticipantRole(opts.role),
    ),
    (result) => [`Joined ${result.path} as ${opts.actor}.`],
  ),
);

addWorkspaceOption(
  threadCmd
    .command('leave <threadPath>')
    .description('Leave a thread or remove another participant')
    .option('-a, --actor <name>', 'Actor', DEFAULT_ACTOR)
    .option('--participant <name>', 'Optional participant to remove')
    .option('--json', 'Emit structured JSON output'),
).action((threadPath, opts) =>
  runCommand(
    opts,
    () => workgraph.thread.leaveThread(
      resolveWorkspacePath(opts),
      normalizePath(threadPath),
      opts.actor,
      opts.participant,
    ),
    (result) => [`Updated participants for ${result.path}.`],
  ),
);

addWorkspaceOption(
  threadCmd
    .command('claim <threadPath>')
    .description('Claim a thread')
    .option('-a, --actor <name>', 'Actor', DEFAULT_ACTOR)
    .option('--lease-ttl-minutes <n>', 'Lease TTL minutes')
    .option('--json', 'Emit structured JSON output'),
).action((threadPath, opts) =>
  runCommand(
    opts,
    () => workgraph.thread.claim(resolveWorkspacePath(opts), normalizePath(threadPath), opts.actor, {
      leaseTtlMinutes: opts.leaseTtlMinutes ? parsePositiveIntOption(opts.leaseTtlMinutes, 'lease-ttl-minutes') : undefined,
    }),
    (result) => [`Claimed ${result.path} as ${opts.actor}.`],
  ),
);

addWorkspaceOption(
  threadCmd
    .command('release <threadPath>')
    .description('Release a claimed thread')
    .option('-a, --actor <name>', 'Actor', DEFAULT_ACTOR)
    .option('--reason <text>', 'Release reason')
    .option('--json', 'Emit structured JSON output'),
).action((threadPath, opts) =>
  runCommand(
    opts,
    () => workgraph.thread.release(resolveWorkspacePath(opts), normalizePath(threadPath), opts.actor, opts.reason),
    (result) => [`Released ${result.path} as ${opts.actor}.`],
  ),
);

addWorkspaceOption(
  threadCmd
    .command('done <threadPath>')
    .description('Mark a thread done')
    .option('-a, --actor <name>', 'Actor', DEFAULT_ACTOR)
    .option('--output <text>', 'Completion output')
    .option('--evidence <items>', 'Comma-separated evidence items')
    .option('--json', 'Emit structured JSON output'),
).action((threadPath, opts) =>
  runCommand(
    opts,
    () => workgraph.thread.done(resolveWorkspacePath(opts), normalizePath(threadPath), opts.actor, opts.output, {
      evidence: csv(opts.evidence),
    }),
    (result) => [`Completed ${result.path} as ${opts.actor}.`],
  ),
);

addWorkspaceOption(
  threadCmd
    .command('reopen <threadPath>')
    .description('Reopen a done or cancelled thread')
    .option('-a, --actor <name>', 'Actor', DEFAULT_ACTOR)
    .option('--reason <text>', 'Reopen reason')
    .option('--json', 'Emit structured JSON output'),
).action((threadPath, opts) =>
  runCommand(
    opts,
    () => workgraph.thread.reopen(resolveWorkspacePath(opts), normalizePath(threadPath), opts.actor, opts.reason),
    (result) => [`Reopened ${result.path} as ${opts.actor}.`],
  ),
);

addWorkspaceOption(
  threadCmd
    .command('block <threadPath>')
    .description('Block a thread')
    .option('-a, --actor <name>', 'Actor', DEFAULT_ACTOR)
    .option('--blocked-by <ref>', 'Blocking dependency', 'external/manual')
    .option('--reason <text>', 'Blocking reason')
    .option('--json', 'Emit structured JSON output'),
).action((threadPath, opts) =>
  runCommand(
    opts,
    () => workgraph.thread.block(
      resolveWorkspacePath(opts),
      normalizePath(threadPath),
      opts.actor,
      opts.blockedBy,
      opts.reason,
    ),
    (result) => [`Blocked ${result.path} as ${opts.actor}.`],
  ),
);

addWorkspaceOption(
  threadCmd
    .command('unblock <threadPath>')
    .description('Unblock a thread')
    .option('-a, --actor <name>', 'Actor', DEFAULT_ACTOR)
    .option('--json', 'Emit structured JSON output'),
).action((threadPath, opts) =>
  runCommand(
    opts,
    () => workgraph.thread.unblock(resolveWorkspacePath(opts), normalizePath(threadPath), opts.actor),
    (result) => [`Unblocked ${result.path} as ${opts.actor}.`],
  ),
);

addWorkspaceOption(
  threadCmd
    .command('heartbeat [threadPath]')
    .description('Refresh one or more claim heartbeats')
    .option('-a, --actor <name>', 'Actor', DEFAULT_ACTOR)
    .option('--ttl-minutes <n>', 'Lease TTL minutes')
    .option('--json', 'Emit structured JSON output'),
).action((threadPath, opts) =>
  runCommand(
    opts,
    () => workgraph.thread.heartbeatClaim(resolveWorkspacePath(opts), opts.actor, threadPath ? normalizePath(threadPath) : undefined, {
      ttlMinutes: opts.ttlMinutes ? parsePositiveIntOption(opts.ttlMinutes, 'ttl-minutes') : undefined,
    }),
    (result) => [
      `Touched: ${result.touched.length}`,
      `Skipped: ${result.skipped.length}`,
    ],
  ),
);

addWorkspaceOption(
  threadCmd
    .command('reap-stale')
    .description('Reap stale claims')
    .option('-a, --actor <name>', 'Actor', DEFAULT_ACTOR)
    .option('--limit <n>', 'Maximum claims to reap')
    .option('--json', 'Emit structured JSON output'),
).action((opts) =>
  runCommand(
    opts,
    () => workgraph.thread.reapStaleClaims(resolveWorkspacePath(opts), opts.actor, {
      limit: opts.limit ? parsePositiveIntOption(opts.limit, 'limit') : undefined,
    }),
    (result) => [
      `Scanned: ${result.scanned}`,
      `Reaped: ${result.reaped.length}`,
      `Skipped: ${result.skipped.length}`,
    ],
  ),
);

addWorkspaceOption(
  threadCmd
    .command('leases')
    .description('List claim lease status')
    .option('--json', 'Emit structured JSON output'),
).action((opts) =>
  runCommand(
    opts,
    () => ({ leases: workgraph.thread.listClaimLeaseStatus(resolveWorkspacePath(opts)) }),
    (result) => result.leases.length > 0
      ? result.leases.map((lease) => `${lease.target} owner=${lease.owner} stale=${lease.stale}`)
      : ['No claim leases found.'],
  ),
);

addWorkspaceOption(
  threadCmd
    .command('decompose <threadPath>')
    .description('Create child threads under one parent thread')
    .requiredOption('--subthread <title::goal...>', 'Repeatable child thread spec', collectSubthreadSpecs, [])
    .option('-a, --actor <name>', 'Actor', DEFAULT_ACTOR)
    .option('--json', 'Emit structured JSON output'),
).action((threadPath, opts) =>
  runCommand(
    opts,
    () => ({
      threads: workgraph.thread.decompose(resolveWorkspacePath(opts), normalizePath(threadPath), opts.subthread, opts.actor),
    }),
    (result) => result.threads.map((entry) => `Created child thread: ${entry.path}`),
  ),
);

const agentCmd = program
  .command('agent')
  .description('Manage actor registration, credentials, and presence');

addWorkspaceOption(
  agentCmd
    .command('heartbeat <name>')
    .description('Write an actor presence heartbeat')
    .option('-a, --actor <actor>', 'Actor performing the update', DEFAULT_ACTOR)
    .option('--status <status>', 'online|busy|offline', 'online')
    .option('--current-task <text>', 'Current task')
    .option('--capabilities <items>', 'Comma-separated capabilities')
    .option('--json', 'Emit structured JSON output'),
).action((name, opts) =>
  runCommand(
    opts,
    () => workgraph.agent.heartbeat(resolveWorkspacePath(opts), name, {
      actor: opts.actor,
      status: normalizePresenceStatus(opts.status),
      currentTask: opts.currentTask,
      capabilities: csv(opts.capabilities),
    }),
    (result) => [`Heartbeated ${String(result.fields.name)} (${String(result.fields.status)}).`],
  ),
);

addWorkspaceOption(
  agentCmd
    .command('register <name>')
    .description('Register an actor using a trust token')
    .option('-a, --actor <actor>', 'Actor performing the update', DEFAULT_ACTOR)
    .option('--token <token>', 'Trust token (or WORKGRAPH_TRUST_TOKEN env)')
    .option('--role <role>', 'Role ref')
    .option('--capabilities <items>', 'Comma-separated capabilities')
    .option('--status <status>', 'online|busy|offline', 'online')
    .option('--current-task <text>', 'Current task')
    .option('--json', 'Emit structured JSON output'),
).action((name, opts) =>
  runCommand(
    opts,
    () => {
      const token = readNonEmptyString(opts.token) ?? process.env.WORKGRAPH_TRUST_TOKEN;
      if (!token) {
        throw new Error('Missing trust token. Provide --token or set WORKGRAPH_TRUST_TOKEN.');
      }
      return workgraph.agent.registerAgent(resolveWorkspacePath(opts), name, {
        token,
        actor: opts.actor,
        role: opts.role,
        capabilities: csv(opts.capabilities),
        status: normalizePresenceStatus(opts.status),
        currentTask: opts.currentTask,
      });
    },
    (result) => [
      `Registered actor: ${result.agentName}`,
      `Role: ${result.role}`,
      `Presence: ${result.presence.path}`,
    ],
  ),
);

addWorkspaceOption(
  agentCmd
    .command('request <name>')
    .description('Submit an actor registration request')
    .option('-a, --actor <actor>', 'Actor performing the update', DEFAULT_ACTOR)
    .option('--role <role>', 'Requested role ref')
    .option('--capabilities <items>', 'Comma-separated capabilities')
    .option('--note <text>', 'Request note')
    .option('--json', 'Emit structured JSON output'),
).action((name, opts) =>
  runCommand(
    opts,
    () => workgraph.agent.submitRegistrationRequest(resolveWorkspacePath(opts), name, {
      actor: opts.actor,
      role: opts.role,
      capabilities: csv(opts.capabilities),
      note: opts.note,
    }),
    (result) => [
      `Submitted request: ${result.request.path}`,
      `Requested role: ${result.requestedRolePath}`,
    ],
  ),
);

addWorkspaceOption(
  agentCmd
    .command('review <requestRef>')
    .description('Approve or reject a registration request')
    .requiredOption('--decision <decision>', 'approved|rejected')
    .option('-a, --actor <actor>', 'Reviewer actor', DEFAULT_ACTOR)
    .option('--role <role>', 'Approved role ref')
    .option('--capabilities <items>', 'Comma-separated capabilities')
    .option('--scopes <items>', 'Comma-separated credential scopes')
    .option('--expires-at <iso>', 'Credential expiry')
    .option('--note <text>', 'Review note')
    .option('--json', 'Emit structured JSON output'),
).action((requestRef, opts) =>
  runCommand(
    opts,
    () => workgraph.agent.reviewRegistrationRequest(
      resolveWorkspacePath(opts),
      requestRef,
      opts.actor,
      normalizeRegistrationDecision(opts.decision),
      {
        role: opts.role,
        capabilities: csv(opts.capabilities),
        scopes: csv(opts.scopes),
        expiresAt: opts.expiresAt,
        note: opts.note,
      },
    ),
    (result) => [
      `Reviewed request: ${result.request.path}`,
      `Decision: ${result.decision}`,
      `Approval: ${result.approval.path}`,
    ],
  ),
);

addWorkspaceOption(
  agentCmd
    .command('credential-list')
    .description('List actor credentials')
    .option('--actor-filter <name>', 'Optional actor filter')
    .option('--json', 'Emit structured JSON output'),
).action((opts) =>
  runCommand(
    opts,
    () => ({
      credentials: workgraph.agent.listAgentCredentials(resolveWorkspacePath(opts), opts.actorFilter),
    }),
    (result) => result.credentials.length > 0
      ? result.credentials.map((entry) => `${entry.id} actor=${entry.actor} status=${entry.status}`)
      : ['No credentials found.'],
  ),
);

addWorkspaceOption(
  agentCmd
    .command('credential-revoke <credentialId>')
    .description('Revoke an actor credential')
    .option('-a, --actor <actor>', 'Actor performing the update', DEFAULT_ACTOR)
    .option('--reason <text>', 'Revocation reason')
    .option('--json', 'Emit structured JSON output'),
).action((credentialId, opts) =>
  runCommand(
    opts,
    () => workgraph.agent.revokeAgentCredential(resolveWorkspacePath(opts), credentialId, opts.actor, opts.reason),
    (result) => [`Revoked credential ${result.id} for ${result.actor}.`],
  ),
);

addWorkspaceOption(
  agentCmd
    .command('list')
    .description('List actor presence entries')
    .option('--json', 'Emit structured JSON output'),
).action((opts) =>
  runCommand(
    opts,
    () => ({ agents: workgraph.agent.list(resolveWorkspacePath(opts)) }),
    (result) => result.agents.length > 0
      ? result.agents.map((entry) => `${String(entry.fields.name)} (${String(entry.fields.status)}) -> ${entry.path}`)
      : ['No actors found.'],
  ),
);

const primitiveCmd = program
  .command('primitive')
  .description('Manage primitive schemas and instances');

addWorkspaceOption(
  primitiveCmd
    .command('define <name>')
    .description('Define a new primitive type')
    .requiredOption('--description <text>', 'Type description')
    .option('-a, --actor <actor>', 'Actor', DEFAULT_ACTOR)
    .option('--directory <dir>', 'Storage directory')
    .option('--field <name:type>', 'Repeatable field definition', collectFieldSpecs, [])
    .option('--json', 'Emit structured JSON output'),
).action((name, opts) =>
  runCommand(
    opts,
    () => workgraph.registry.defineType(
      resolveWorkspacePath(opts),
      name,
      opts.description,
      parseFieldDefinitions(opts.field),
      opts.actor,
      opts.directory,
    ),
    (result) => [
      `Defined primitive type: ${result.name}`,
      `Directory: ${result.directory}`,
    ],
  ),
);

addWorkspaceOption(
  primitiveCmd
    .command('list')
    .description('List registered primitive types')
    .option('--json', 'Emit structured JSON output'),
).action((opts) =>
  runCommand(
    opts,
    () => ({ types: workgraph.registry.listTypes(resolveWorkspacePath(opts)) }),
    (result) => result.types.map((type) => `${type.name} -> ${type.directory}`),
  ),
);

addWorkspaceOption(
  primitiveCmd
    .command('create <type> <title>')
    .description('Create a primitive instance')
    .option('-a, --actor <actor>', 'Actor', DEFAULT_ACTOR)
    .option('--body <markdown>', 'Markdown body')
    .option('--set <key=value>', 'Repeatable field assignment', collectSetPairs, [])
    .option('--json', 'Emit structured JSON output'),
).action((type, title, opts) =>
  runCommand(
    opts,
    () => workgraph.store.create(
      resolveWorkspacePath(opts),
      type,
      {
        title,
        ...mergeSetPairs(opts.set),
      },
      opts.body ?? '',
      opts.actor,
    ),
    (result) => [`Created primitive: ${result.path}`],
  ),
);

addWorkspaceOption(
  primitiveCmd
    .command('update <path>')
    .description('Update a primitive instance')
    .option('-a, --actor <actor>', 'Actor', DEFAULT_ACTOR)
    .option('--body <markdown>', 'Replace markdown body')
    .option('--set <key=value>', 'Repeatable field assignment', collectSetPairs, [])
    .option('--etag <etag>', 'Expected etag for optimistic concurrency')
    .option('--json', 'Emit structured JSON output'),
).action((targetPath, opts) =>
  runCommand(
    opts,
    () => workgraph.store.update(
      resolveWorkspacePath(opts),
      normalizePath(targetPath),
      mergeSetPairs(opts.set),
      opts.body,
      opts.actor,
      {
        expectedEtag: opts.etag,
      },
    ),
    (result) => [`Updated primitive: ${result.path}`],
  ),
);

addWorkspaceOption(
  program
    .command('status')
    .description('Show workspace status')
    .option('--json', 'Emit structured JSON output'),
).action((opts) =>
  runCommand(
    opts,
    () => workgraph.orientation.statusSnapshot(resolveWorkspacePath(opts)),
    (result) => [
      `Threads: total=${result.threads.total} open=${result.threads.open} active=${result.threads.active} blocked=${result.threads.blocked} done=${result.threads.done}`,
      `Claims: ${result.claims.active}`,
      `Primitives: ${result.primitives.total}`,
    ],
  ),
);

addWorkspaceOption(
  program
    .command('brief')
    .description('Show actor-centric collaboration brief')
    .option('-a, --actor <actor>', 'Actor', DEFAULT_ACTOR)
    .option('--recent-count <n>', 'Recent activity count')
    .option('--next-count <n>', 'Next thread count')
    .option('--json', 'Emit structured JSON output'),
).action((opts) =>
  runCommand(
    opts,
    () => workgraph.orientation.brief(resolveWorkspacePath(opts), opts.actor, {
      recentCount: opts.recentCount ? parsePositiveIntOption(opts.recentCount, 'recent-count') : undefined,
      nextCount: opts.nextCount ? parsePositiveIntOption(opts.nextCount, 'next-count') : undefined,
    }),
    (result) => [
      `Actor: ${result.actor}`,
      `Claims: ${result.myClaims.length}`,
      `Blocked: ${result.blockedThreads.length}`,
      `Next ready: ${result.nextReadyThreads.length}`,
    ],
  ),
);

addWorkspaceOption(
  program
    .command('query')
    .description('Query primitives')
    .option('--type <type>', 'Primitive type')
    .option('--status <status>', 'Status filter')
    .option('--owner <owner>', 'Owner filter')
    .option('--tag <tag>', 'Tag filter')
    .option('--text <text>', 'Text filter')
    .option('--path-includes <text>', 'Path substring filter')
    .option('--updated-after <iso>', 'Updated after')
    .option('--updated-before <iso>', 'Updated before')
    .option('--created-after <iso>', 'Created after')
    .option('--created-before <iso>', 'Created before')
    .option('--limit <n>', 'Limit')
    .option('--offset <n>', 'Offset')
    .option('--json', 'Emit structured JSON output'),
).action((opts) =>
  runCommand(
    opts,
    () => {
      const results = workgraph.query.queryPrimitives(resolveWorkspacePath(opts), {
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
        limit: opts.limit ? parsePositiveIntOption(opts.limit, 'limit') : undefined,
        offset: opts.offset ? parseNonNegativeIntOption(opts.offset, 'offset') : undefined,
      });
      return { results, count: results.length };
    },
    (result) => result.results.length > 0
      ? [
          ...result.results.map((entry) => `${entry.type} ${entry.path}`),
          `${result.count} primitive(s)`,
        ]
      : ['No primitives matched the query.'],
  ),
);

addWorkspaceOption(
  program
    .command('search <text>')
    .description('Keyword search primitive content')
    .option('--type <type>', 'Primitive type')
    .option('--limit <n>', 'Limit')
    .option('--json', 'Emit structured JSON output'),
).action((text, opts) =>
  runCommand(
    opts,
    () => {
      const results = workgraph.query.keywordSearch(resolveWorkspacePath(opts), text, {
        type: opts.type,
        limit: opts.limit ? parsePositiveIntOption(opts.limit, 'limit') : undefined,
      });
      return { query: text, results, count: results.length };
    },
    (result) => result.results.length > 0
      ? [
          ...result.results.map((entry) => `${entry.type} ${entry.path}`),
          `${result.count} result(s)`,
        ]
      : ['No search results found.'],
  ),
);

const lensCmd = program
  .command('lens')
  .description('Generate context lenses');

addWorkspaceOption(
  lensCmd
    .command('list')
    .description('List built-in lenses')
    .option('--json', 'Emit structured JSON output'),
).action((opts) =>
  runCommand(
    opts,
    () => ({ lenses: workgraph.lens.listContextLenses() }),
    (result) => result.lenses.map((entry) => `${entry.id}: ${entry.description}`),
  ),
);

addWorkspaceOption(
  lensCmd
    .command('show <lensId>')
    .description('Generate or materialize one lens')
    .option('-a, --actor <actor>', 'Actor', DEFAULT_ACTOR)
    .option('--lookback-hours <n>', 'Lookback hours')
    .option('--stale-hours <n>', 'Stale hours')
    .option('--limit <n>', 'Item limit')
    .option('--output <path>', 'Write markdown to a file')
    .option('--json', 'Emit structured JSON output'),
).action((lensId, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const sharedOptions = {
        actor: opts.actor,
        lookbackHours: opts.lookbackHours ? parsePositiveIntOption(opts.lookbackHours, 'lookback-hours') : undefined,
        staleHours: opts.staleHours ? parsePositiveIntOption(opts.staleHours, 'stale-hours') : undefined,
        limit: opts.limit ? parsePositiveIntOption(opts.limit, 'limit') : undefined,
      };
      if (opts.output) {
        return workgraph.lens.materializeContextLens(workspacePath, lensId, {
          ...sharedOptions,
          outputPath: opts.output,
        });
      }
      return workgraph.lens.generateContextLens(workspacePath, lensId, sharedOptions);
    },
    (result) => [
      `Lens: ${result.lens}`,
      `Sections: ${result.sections.length}`,
      ...('outputPath' in result ? [`Output: ${result.outputPath}`] : []),
    ],
  ),
);

const graphCmd = program
  .command('graph')
  .description('Inspect context graph structure');

addWorkspaceOption(
  graphCmd
    .command('index')
    .description('Refresh wiki-link graph index')
    .option('--json', 'Emit structured JSON output'),
).action((opts) =>
  runCommand(
    opts,
    () => workgraph.graph.refreshWikiLinkGraphIndex(resolveWorkspacePath(opts)),
    (result) => [`Indexed ${result.nodes.length} nodes and ${result.edges.length} edges.`],
  ),
);

addWorkspaceOption(
  graphCmd
    .command('hygiene')
    .description('Report graph hygiene metrics')
    .option('--json', 'Emit structured JSON output'),
).action((opts) =>
  runCommand(
    opts,
    () => workgraph.graph.graphHygieneReport(resolveWorkspacePath(opts)),
    (result) => [
      `Nodes: ${result.nodeCount}`,
      `Edges: ${result.edgeCount}`,
      `Broken links: ${result.brokenLinkCount}`,
      `Orphans: ${result.orphanCount}`,
    ],
  ),
);

addWorkspaceOption(
  graphCmd
    .command('neighborhood <nodeRef>')
    .description('Show graph neighborhood for one primitive')
    .option('--depth <n>', 'Neighborhood depth', '2')
    .option('--refresh', 'Rebuild index before query')
    .option('--json', 'Emit structured JSON output'),
).action((nodeRef, opts) =>
  runCommand(
    opts,
    () => workgraph.graph.graphNeighborhoodQuery(resolveWorkspacePath(opts), nodeRef, {
      depth: parseNonNegativeIntOption(opts.depth, 'depth'),
      refresh: !!opts.refresh,
    }),
    (result) => [
      `Center: ${result.center.path}`,
      `Connected nodes: ${result.connectedNodes.length}`,
      `Edges: ${result.edges.length}`,
    ],
  ),
);

addWorkspaceOption(
  graphCmd
    .command('impact <nodeRef>')
    .description('Show inbound references to one primitive')
    .option('--refresh', 'Rebuild index before query')
    .option('--json', 'Emit structured JSON output'),
).action((nodeRef, opts) =>
  runCommand(
    opts,
    () => workgraph.graph.graphImpactAnalysis(resolveWorkspacePath(opts), nodeRef, {
      refresh: !!opts.refresh,
    }),
    (result) => [
      `Target: ${result.target.path}`,
      `References: ${result.totalReferences}`,
      `Groups: ${result.groups.length}`,
    ],
  ),
);

addWorkspaceOption(
  graphCmd
    .command('context <nodeRef>')
    .description('Assemble a context bundle around one primitive')
    .option('--budget <tokens>', 'Token budget', '2000')
    .option('--refresh', 'Rebuild index before query')
    .option('--json', 'Emit structured JSON output'),
).action((nodeRef, opts) =>
  runCommand(
    opts,
    () => workgraph.graph.graphContextAssembly(resolveWorkspacePath(opts), nodeRef, {
      budgetTokens: parsePositiveIntegerOption(opts.budget, 'budget'),
      refresh: !!opts.refresh,
    }),
    (result) => [
      `Center: ${result.center.path}`,
      `Used tokens: ${result.usedTokens}/${result.budgetTokens}`,
      `Sections: ${result.sections.length}`,
    ],
  ),
);

addWorkspaceOption(
  graphCmd
    .command('edges <nodeRef>')
    .description('Inspect typed edges for one primitive')
    .option('--refresh', 'Rebuild index before query')
    .option('--json', 'Emit structured JSON output'),
).action((nodeRef, opts) =>
  runCommand(
    opts,
    () => workgraph.graph.graphTypedEdges(resolveWorkspacePath(opts), nodeRef, {
      refresh: !!opts.refresh,
    }),
    (result) => [
      `Node: ${result.node.path}`,
      `Outgoing: ${result.outgoing.length}`,
      `Incoming: ${result.incoming.length}`,
    ],
  ),
);

addWorkspaceOption(
  graphCmd
    .command('export <nodeRef>')
    .description('Export a subgraph to markdown files')
    .option('--depth <n>', 'Neighborhood depth', '2')
    .option('--output-dir <path>', 'Output directory')
    .option('--refresh', 'Rebuild index before query')
    .option('--json', 'Emit structured JSON output'),
).action((nodeRef, opts) =>
  runCommand(
    opts,
    () => workgraph.graph.graphExportSubgraph(resolveWorkspacePath(opts), nodeRef, {
      depth: parseNonNegativeIntOption(opts.depth, 'depth'),
      outputDir: opts.outputDir,
      refresh: !!opts.refresh,
    }),
    (result) => [
      `Exported nodes: ${result.exportedNodes.length}`,
      `Output directory: ${result.outputDirectory}`,
      `Manifest: ${result.manifestPath}`,
    ],
  ),
);

registerConversationCommands(program, DEFAULT_ACTOR);
registerMcpCommands(program, DEFAULT_ACTOR);

addWorkspaceOption(
  program
    .command('serve')
    .description('Serve the MCP HTTP endpoint for this workspace')
    .option('-a, --actor <name>', 'Default actor for MCP writes', DEFAULT_ACTOR)
    .option('--read-only', 'Disable MCP write tools')
    .option('--port <port>', 'HTTP port')
    .option('--host <host>', 'Bind host')
    .option('--endpoint-path <path>', 'MCP endpoint path')
    .option('--token <token>', 'Bearer token for HTTP access')
    .option('--json', 'Emit structured JSON output'),
).action(async (opts) => {
  const workspacePath = resolveWorkspacePath(opts);
  const serverConfig = workgraph.serverConfig.loadServerConfig(workspacePath);
  const handle = await startWorkgraphMcpHttpServer({
    workspacePath,
    defaultActor: opts.actor,
    readOnly: !!opts.readOnly,
    host: opts.host ?? serverConfig?.host ?? '127.0.0.1',
    port: opts.port ? parsePortOption(opts.port) : serverConfig?.port,
    endpointPath: opts.endpointPath ?? serverConfig?.endpointPath,
    bearerToken: readNonEmptyString(opts.token) ?? serverConfig?.bearerToken,
  });

  if (wantsJson(opts)) {
    console.log(JSON.stringify({
      ok: true,
      data: {
        host: handle.host,
        port: handle.port,
        endpointPath: handle.endpointPath,
        healthUrl: handle.healthUrl,
        url: handle.url,
      },
    }, null, 2));
  } else {
    console.log(`Serving MCP HTTP on ${handle.url}`);
    console.log(`Health: ${handle.healthUrl}`);
  }

  await waitForShutdown(handle.close);
});

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

function normalizePriority(value: string): 'urgent' | 'high' | 'medium' | 'low' {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'urgent' || normalized === 'high' || normalized === 'medium' || normalized === 'low') {
    return normalized;
  }
  throw new Error(`Invalid priority "${value}". Expected urgent|high|medium|low.`);
}

function normalizePresenceStatus(value: string): 'online' | 'busy' | 'offline' {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'online' || normalized === 'busy' || normalized === 'offline') {
    return normalized;
  }
  throw new Error(`Invalid status "${value}". Expected online|busy|offline.`);
}

function normalizeParticipantRole(value: string): 'owner' | 'contributor' | 'reviewer' | 'observer' {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'owner' || normalized === 'contributor' || normalized === 'reviewer' || normalized === 'observer') {
    return normalized;
  }
  throw new Error(`Invalid role "${value}". Expected owner|contributor|reviewer|observer.`);
}

function normalizeRegistrationDecision(value: string): 'approved' | 'rejected' {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'approved' || normalized === 'rejected') {
    return normalized;
  }
  throw new Error(`Invalid decision "${value}". Expected approved|rejected.`);
}

function normalizePath(value: string): string {
  const trimmed = String(value).trim().replace(/\\/g, '/').replace(/^\.\//, '');
  return trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
}

function collectSetPairs(value: string, existing: string[]): string[] {
  existing.push(value);
  return existing;
}

function mergeSetPairs(values: string[]): Record<string, unknown> {
  return values.reduce<Record<string, unknown>>((acc, entry) => {
    Object.assign(acc, parseSetPairs([entry]));
    return acc;
  }, {});
}

function collectFieldSpecs(value: string, existing: string[]): string[] {
  existing.push(value);
  return existing;
}

function parseFieldDefinitions(values: string[]): Record<string, workgraph.FieldDefinition> {
  const fields: Record<string, workgraph.FieldDefinition> = {};
  for (const value of values) {
    const [namePart, typePart] = String(value).split(':');
    const name = readNonEmptyString(namePart);
    const type = readNonEmptyString(typePart);
    if (!name || !type) {
      throw new Error(`Invalid field definition "${value}". Expected name:type.`);
    }
    fields[name] = {
      type: parseFieldType(type),
    };
  }
  return fields;
}

function parseFieldType(value: string): workgraph.FieldDefinition['type'] {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'string' ||
    normalized === 'number' ||
    normalized === 'boolean' ||
    normalized === 'list' ||
    normalized === 'date' ||
    normalized === 'ref' ||
    normalized === 'any'
  ) {
    return normalized;
  }
  throw new Error(`Invalid field type "${value}". Expected string|number|boolean|list|date|ref|any.`);
}

function collectSubthreadSpecs(
  value: string,
  existing: Array<{ title: string; goal: string; deps?: string[] }>,
): Array<{ title: string; goal: string; deps?: string[] }> {
  const [title, goal, deps] = String(value).split('::');
  if (!readNonEmptyString(title) || !readNonEmptyString(goal)) {
    throw new Error(`Invalid subthread spec "${value}". Expected title::goal[::dep1,dep2].`);
  }
  existing.push({
    title: title.trim(),
    goal: goal.trim(),
    ...(readNonEmptyString(deps) ? { deps: deps.split(',').map((entry) => entry.trim()).filter(Boolean) } : {}),
  });
  return existing;
}

async function waitForShutdown(close: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let closing = false;
    const stop = async () => {
      if (closing) return;
      closing = true;
      cleanup();
      try {
        await close();
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    const onSigint = () => { void stop(); };
    const onSigterm = () => { void stop(); };
    const cleanup = () => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    };
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
  });
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
