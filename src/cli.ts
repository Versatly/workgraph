import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import * as workgraph from './index.js';

type JsonCapableOptions = {
  json?: boolean;
  workspace?: string;
  vault?: string;
  sharedVault?: string;
};

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
    .description('Initialize a pure workgraph workspace (no memory category scaffolding)')
    .option('-n, --name <name>', 'Workspace name')
    .option('--no-type-dirs', 'Do not pre-create built-in type directories')
    .option('--no-bases', 'Do not generate .base files from primitive registry')
    .option('--no-readme', 'Do not create README.md')
    .option('--json', 'Emit structured JSON output')
).action((targetPath, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = path.resolve(targetPath || resolveWorkspacePath(opts));
      const result = workgraph.workspace.initWorkspace(workspacePath, {
        name: opts.name,
        createTypeDirs: opts.typeDirs,
        createBases: opts.bases,
        createReadme: opts.readme,
      });
      return result;
    },
    (result) => [
      `Initialized workgraph workspace: ${result.workspacePath}`,
      `Seeded types: ${result.seededTypes.join(', ')}`,
      `Generated .base files: ${result.generatedBases.length}`,
      `Config: ${result.configPath}`,
    ]
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
    .option('--json', 'Emit structured JSON output')
).action((threadPath, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return { thread: workgraph.thread.claim(workspacePath, threadPath, opts.actor) };
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
    .option('--json', 'Emit structured JSON output')
).action((threadPath, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return { thread: workgraph.thread.done(workspacePath, threadPath, opts.actor, opts.output) };
    },
    (result) => [`Done: ${result.thread.path}`]
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
        instance: workgraph.store.update(workspacePath, targetPath, updates, body, opts.actor),
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

const dispatchCmd = program
  .command('dispatch')
  .description('Programmatic runtime dispatch contract');

addWorkspaceOption(
  dispatchCmd
    .command('create <objective>')
    .description('Create a new run dispatch request')
    .option('-a, --actor <name>', 'Actor', DEFAULT_ACTOR)
    .option('--adapter <name>', 'Adapter name', 'cursor-cloud')
    .option('--idempotency-key <key>', 'Idempotency key')
    .option('--json', 'Emit structured JSON output')
).action((objective, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return {
        run: workgraph.dispatch.createRun(workspacePath, {
          actor: opts.actor,
          adapter: opts.adapter,
          objective,
          idempotencyKey: opts.idempotencyKey,
        }),
      };
    },
    (result) => [`Run created: ${result.run.id} [${result.run.status}]`],
  )
);

addWorkspaceOption(
  dispatchCmd
    .command('claim <threadRef>')
    .description('Claim a thread after passing quality gates')
    .option('-a, --actor <name>', 'Actor', DEFAULT_ACTOR)
    .option('--json', 'Emit structured JSON output')
).action((threadRef, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return workgraph.dispatch.claimThread(workspacePath, threadRef, opts.actor);
    },
    (result) => [
      `Claimed thread: ${result.thread.path}`,
      `Gates checked: ${result.gateCheck.gates.length}`,
    ],
  )
);

addWorkspaceOption(
  dispatchCmd
    .command('create-execute <objective>')
    .description('Create and execute a run with autonomous multi-agent coordination')
    .option('-a, --actor <name>', 'Actor', DEFAULT_ACTOR)
    .option('--adapter <name>', 'Adapter name', 'cursor-cloud')
    .option('--idempotency-key <key>', 'Idempotency key')
    .option('--agents <actors>', 'Comma-separated agent identities for autonomous execution')
    .option('--max-steps <n>', 'Maximum scheduler steps', '200')
    .option('--step-delay-ms <ms>', 'Delay between scheduling steps', '25')
    .option('--space <spaceRef>', 'Restrict execution to one space')
    .option('--no-checkpoint', 'Skip automatic checkpoint generation after execution')
    .option('--json', 'Emit structured JSON output')
).action((objective, opts) =>
  runCommand(
    opts,
    async () => {
      const workspacePath = resolveWorkspacePath(opts);
      return {
        run: await workgraph.dispatch.createAndExecuteRun(
          workspacePath,
          {
            actor: opts.actor,
            adapter: opts.adapter,
            objective,
            idempotencyKey: opts.idempotencyKey,
          },
          {
            agents: csv(opts.agents),
            maxSteps: Number.parseInt(String(opts.maxSteps), 10),
            stepDelayMs: Number.parseInt(String(opts.stepDelayMs), 10),
            space: opts.space,
            createCheckpoint: opts.checkpoint,
          },
        ),
      };
    },
    (result) => [
      `Run executed: ${result.run.id} [${result.run.status}]`,
      ...(result.run.output ? [`Output: ${result.run.output}`] : []),
      ...(result.run.error ? [`Error: ${result.run.error}`] : []),
    ],
  )
);

addWorkspaceOption(
  dispatchCmd
    .command('list')
    .description('List runs')
    .option('--status <status>', 'queued|running|succeeded|failed|cancelled')
    .option('--limit <n>', 'Result limit')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return {
        runs: workgraph.dispatch.listRuns(workspacePath, {
          status: opts.status,
          limit: opts.limit ? Number.parseInt(String(opts.limit), 10) : undefined,
        }),
      };
    },
    (result) => result.runs.map((run) => `${run.id} [${run.status}] ${run.objective}`),
  )
);

addWorkspaceOption(
  dispatchCmd
    .command('status <runId>')
    .description('Get run status by ID')
    .option('--json', 'Emit structured JSON output')
).action((runId, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return {
        run: workgraph.dispatch.status(workspacePath, runId),
      };
    },
    (result) => [`${result.run.id} [${result.run.status}]`],
  )
);

addWorkspaceOption(
  dispatchCmd
    .command('execute <runId>')
    .description('Execute a queued/running run via adapter autonomous scheduling')
    .option('-a, --actor <name>', 'Actor', DEFAULT_ACTOR)
    .option('--agents <actors>', 'Comma-separated agent identities')
    .option('--max-steps <n>', 'Maximum scheduler steps', '200')
    .option('--step-delay-ms <ms>', 'Delay between scheduling steps', '25')
    .option('--space <spaceRef>', 'Restrict execution to one space')
    .option('--no-checkpoint', 'Skip automatic checkpoint generation after execution')
    .option('--json', 'Emit structured JSON output')
).action((runId, opts) =>
  runCommand(
    opts,
    async () => {
      const workspacePath = resolveWorkspacePath(opts);
      return {
        run: await workgraph.dispatch.executeRun(workspacePath, runId, {
          actor: opts.actor,
          agents: csv(opts.agents),
          maxSteps: Number.parseInt(String(opts.maxSteps), 10),
          stepDelayMs: Number.parseInt(String(opts.stepDelayMs), 10),
          space: opts.space,
          createCheckpoint: opts.checkpoint,
        }),
      };
    },
    (result) => [
      `Run executed: ${result.run.id} [${result.run.status}]`,
      ...(result.run.output ? [`Output: ${result.run.output}`] : []),
      ...(result.run.error ? [`Error: ${result.run.error}`] : []),
    ],
  )
);

addWorkspaceOption(
  dispatchCmd
    .command('followup <runId> <input>')
    .description('Send follow-up input to a run')
    .option('-a, --actor <name>', 'Actor', DEFAULT_ACTOR)
    .option('--json', 'Emit structured JSON output')
).action((runId, input, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return {
        run: workgraph.dispatch.followup(workspacePath, runId, opts.actor, input),
      };
    },
    (result) => [`Follow-up recorded: ${result.run.id} [${result.run.status}]`],
  )
);

addWorkspaceOption(
  dispatchCmd
    .command('stop <runId>')
    .description('Cancel a run')
    .option('-a, --actor <name>', 'Actor', DEFAULT_ACTOR)
    .option('--json', 'Emit structured JSON output')
).action((runId, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return {
        run: workgraph.dispatch.stop(workspacePath, runId, opts.actor),
      };
    },
    (result) => [`Stopped run: ${result.run.id} [${result.run.status}]`],
  )
);

addWorkspaceOption(
  dispatchCmd
    .command('mark <runId>')
    .description('Set run status transition explicitly')
    .requiredOption('--status <status>', 'running|succeeded|failed|cancelled')
    .option('-a, --actor <name>', 'Actor', DEFAULT_ACTOR)
    .option('--output <text>', 'Optional output payload')
    .option('--error <text>', 'Optional error payload')
    .option('--json', 'Emit structured JSON output')
).action((runId, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const status = normalizeRunStatus(opts.status);
      return {
        run: workgraph.dispatch.markRun(workspacePath, runId, opts.actor, status, {
          output: opts.output,
          error: opts.error,
        }),
      };
    },
    (result) => [`Marked run: ${result.run.id} [${result.run.status}]`],
  )
);

addWorkspaceOption(
  dispatchCmd
    .command('logs <runId>')
    .description('Read logs from a run')
    .option('--json', 'Emit structured JSON output')
).action((runId, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return {
        runId,
        logs: workgraph.dispatch.logs(workspacePath, runId),
      };
    },
    (result) => result.logs.map((entry) => `${entry.ts} [${entry.level}] ${entry.message}`),
  )
);

// ============================================================================
// trigger
// ============================================================================

const triggerCmd = program
  .command('trigger')
  .description('Trigger primitives and run dispatch lifecycle');

addWorkspaceOption(
  triggerCmd
    .command('fire <triggerPath>')
    .description('Fire an approved/active trigger and dispatch a run')
    .option('-a, --actor <name>', 'Actor', DEFAULT_ACTOR)
    .option('--event-key <key>', 'Deterministic event key for idempotency')
    .option('--objective <text>', 'Override run objective')
    .option('--json', 'Emit structured JSON output')
).action((triggerPath, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return workgraph.trigger.fireTrigger(workspacePath, triggerPath, {
        actor: opts.actor,
        eventKey: opts.eventKey,
        objective: opts.objective,
      });
    },
    (result) => [
      `Fired trigger: ${result.triggerPath}`,
      `Run: ${result.run.id} [${result.run.status}]`,
    ],
  )
);

const triggerEngineCmd = triggerCmd
  .command('engine')
  .description('Run trigger polling engine loop');

addWorkspaceOption(
  triggerEngineCmd
    .command('start')
    .description('Start foreground trigger polling loop')
    .option('-a, --actor <name>', 'Actor used for trigger actions', 'system')
    .option('--interval <seconds>', 'Polling interval seconds', '60')
    .option('--max-cycles <n>', 'Stop after N cycles (testing/helper mode)')
).action(async (opts) => {
  const workspacePath = resolveWorkspacePath(opts);
  const interval = Number.parseInt(String(opts.interval), 10);
  if (Number.isNaN(interval) || interval <= 0) {
    throw new Error(`Invalid interval "${opts.interval}". Expected a positive integer (seconds).`);
  }
  const maxCycles = opts.maxCycles ? Number.parseInt(String(opts.maxCycles), 10) : undefined;
  if (maxCycles !== undefined && (Number.isNaN(maxCycles) || maxCycles <= 0)) {
    throw new Error(`Invalid max cycles "${opts.maxCycles}". Expected a positive integer.`);
  }
  await workgraph.triggerEngine.startTriggerEngine(workspacePath, {
    actor: opts.actor,
    intervalSeconds: interval,
    maxCycles,
  });
});

addWorkspaceOption(
  triggerCmd
    .command('status')
    .description('Show trigger dashboard (last fired, next fire, counts, state)')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return workgraph.triggerEngine.triggerDashboard(workspacePath);
    },
    (result) => {
      if (result.triggers.length === 0) return ['No trigger primitives found.'];
      return result.triggers.flatMap((trigger) => [
        `${trigger.path} [${trigger.status}]`,
        `  state=${trigger.currentState} fired=${trigger.fireCount} cooldown=${trigger.cooldownSeconds}s`,
        `  last_fired=${trigger.lastFiredAt ?? 'never'} next_fire=${trigger.nextFireAt ?? 'n/a'}`,
        `  condition=${trigger.condition}`,
        `  action=${trigger.action}`,
        ...(trigger.lastError ? [`  error=${trigger.lastError}`] : []),
      ]);
    },
  )
);

addWorkspaceOption(
  triggerCmd
    .command('add-synthesis')
    .description('Add built-in auto-synthesis trigger template')
    .requiredOption('--tag <pattern>', 'Fact tag pattern (supports * wildcard)')
    .requiredOption('--threshold <n>', 'Minimum new facts to fire synthesis')
    .option('-a, --actor <name>', 'Actor to assign synthesis output threads', DEFAULT_ACTOR)
    .option('--cooldown <seconds>', 'Cooldown between synthesis fires', '0')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const threshold = Number.parseInt(String(opts.threshold), 10);
      const cooldown = Number.parseInt(String(opts.cooldown), 10);
      if (Number.isNaN(threshold) || threshold <= 0) {
        throw new Error(`Invalid threshold "${opts.threshold}". Expected a positive integer.`);
      }
      if (Number.isNaN(cooldown) || cooldown < 0) {
        throw new Error(`Invalid cooldown "${opts.cooldown}". Expected a non-negative integer.`);
      }
      return workgraph.triggerEngine.addSynthesisTrigger(workspacePath, {
        tagPattern: opts.tag,
        threshold,
        actor: opts.actor,
        cooldownSeconds: cooldown,
      });
    },
    (result) => [
      `Created synthesis trigger: ${result.trigger.path}`,
      `Status: ${String(result.trigger.fields.status)}`,
      `Tag pattern: ${String((result.trigger.fields.synthesis as Record<string, unknown>)?.tag_pattern ?? '')}`,
    ],
  )
);

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
// mcp
// ============================================================================

const mcpCmd = program
  .command('mcp')
  .description('Run Workgraph MCP server');

addWorkspaceOption(
  mcpCmd
    .command('serve')
    .description('Serve stdio MCP tools/resources for this workspace')
    .option('-a, --actor <name>', 'Default actor for MCP write tools', DEFAULT_ACTOR)
    .option('--read-only', 'Disable all MCP write tools')
).action(async (opts) => {
  const workspacePath = resolveWorkspacePath(opts);
  console.error(`Starting MCP server for workspace: ${workspacePath}`);
  await workgraph.mcpServer.startWorkgraphMcpServer({
    workspacePath,
    defaultActor: opts.actor,
    readOnly: !!opts.readOnly,
  });
});

await program.parseAsync();

function addWorkspaceOption<T extends Command>(command: T): T {
  return command
    .option('-w, --workspace <path>', 'Workgraph workspace path')
    .option('--vault <path>', 'Alias for --workspace')
    .option('--shared-vault <path>', 'Shared vault path (e.g. mounted via Tailscale)');
}

function resolveWorkspacePath(opts: JsonCapableOptions): string {
  const explicit = opts.workspace || opts.vault || opts.sharedVault;
  if (explicit) return path.resolve(explicit);
  if (process.env.WORKGRAPH_SHARED_VAULT) return path.resolve(process.env.WORKGRAPH_SHARED_VAULT);
  if (process.env.WORKGRAPH_PATH) return path.resolve(process.env.WORKGRAPH_PATH);
  return process.cwd();
}

function parseSetPairs(pairs: string[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eqIdx = String(pair).indexOf('=');
    if (eqIdx === -1) continue;
    const key = String(pair).slice(0, eqIdx).trim();
    const raw = String(pair).slice(eqIdx + 1).trim();
    if (!key) continue;
    fields[key] = parseScalar(raw);
  }
  return fields;
}

function csv(value?: string): string[] | undefined {
  if (!value) return undefined;
  return String(value).split(',').map(s => s.trim()).filter(Boolean);
}

type IntegrationInstallCliOptions = JsonCapableOptions & {
  actor: string;
  owner?: string;
  title?: string;
  sourceUrl?: string;
  force?: boolean;
};

function installNamedIntegration(
  workspacePath: string,
  integrationName: string,
  opts: IntegrationInstallCliOptions,
): Promise<workgraph.InstallSkillIntegrationResult> {
  return workgraph.integration.installIntegration(workspacePath, integrationName, {
    actor: opts.actor,
    owner: opts.owner,
    title: opts.title,
    sourceUrl: opts.sourceUrl,
    force: !!opts.force,
  });
}

function renderInstalledIntegrationResult(result: workgraph.InstallSkillIntegrationResult): string[] {
  return [
    `${result.replacedExisting ? 'Updated' : 'Installed'} ${result.provider} integration skill: ${result.skill.path}`,
    `Source: ${result.sourceUrl}`,
    `Status: ${String(result.skill.fields.status)}`,
  ];
}

function parseScalar(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (value === '') return '';
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => parseScalar(item.trim()));
  }
  if (value.includes(',')) {
    return value.split(',').map((item) => parseScalar(item.trim()));
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeRunStatus(status: string): 'running' | 'succeeded' | 'failed' | 'cancelled' {
  const normalized = String(status).toLowerCase();
  if (normalized === 'running' || normalized === 'succeeded' || normalized === 'failed' || normalized === 'cancelled') {
    return normalized;
  }
  throw new Error(`Invalid run status "${status}". Expected running|succeeded|failed|cancelled.`);
}

function normalizeOnboardingStatus(status: string): 'active' | 'paused' | 'completed' {
  const normalized = String(status).toLowerCase();
  if (normalized === 'active' || normalized === 'paused' || normalized === 'completed') {
    return normalized;
  }
  throw new Error(`Invalid onboarding status "${status}". Expected active|paused|completed.`);
}

function wantsJson(opts: JsonCapableOptions): boolean {
  if (opts.json) return true;
  if (process.env.WORKGRAPH_JSON === '1') return true;
  return false;
}

async function runCommand<T>(
  opts: JsonCapableOptions,
  action: () => T | Promise<T>,
  renderText: (result: T) => string[]
): Promise<void> {
  try {
    const result = await action();
    if (wantsJson(opts)) {
      console.log(JSON.stringify({ ok: true, data: result }, null, 2));
      return;
    }
    const lines = renderText(result);
    for (const line of lines) console.log(line);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (wantsJson(opts)) {
      console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`Error: ${message}`);
    }
    process.exit(1);
  }
}
