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
  process.env.CLAWVAULT_AGENT ||
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
    .description('Sync .clawvault/primitive-registry.yaml from active registry')
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const manifest = workgraph.bases.syncPrimitiveRegistryManifest(workspacePath);
      return {
        primitiveCount: manifest.primitives.length,
        manifestPath: '.clawvault/primitive-registry.yaml',
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
    .option('--output-dir <path>', 'Output directory for .base files (default: .clawvault/bases)')
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
      const fields: Record<string, unknown> = { title };
      for (const pair of opts.set ?? []) {
        const eqIdx = String(pair).indexOf('=');
        if (eqIdx === -1) continue;
        const key = String(pair).slice(0, eqIdx).trim();
        let value: unknown = String(pair).slice(eqIdx + 1).trim();
        if (typeof value === 'string' && value.includes(',')) {
          value = value.split(',').map(v => v.trim());
        }
        fields[key] = value;
      }
      return {
        instance: workgraph.store.create(workspacePath, type, fields, opts.body, opts.actor),
      };
    },
    (result) => [`Created ${result.instance.type}: ${result.instance.path}`]
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
    .option('--version <semver>', 'Skill version')
    .option('--status <status>', 'draft | proposed | active | deprecated | archived')
    .option('--distribution <mode>', 'Distribution mode', 'tailscale-shared-vault')
    .option('--tailscale-path <path>', 'Shared Tailscale workspace path')
    .option('--reviewers <list>', 'Comma-separated reviewer names')
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
          version: opts.version,
          status: opts.status,
          distribution: opts.distribution,
          tailscalePath: opts.tailscalePath,
          reviewers: csv(opts.reviewers),
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
    .option('--json', 'Emit structured JSON output')
).action((opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      const skills = workgraph.skill.listSkills(workspacePath, { status: opts.status });
      return { skills, count: skills.length };
    },
    (result) => result.skills.map((skill) =>
      `${String(skill.fields.title)} [${String(skill.fields.status)}] -> ${skill.path}`)
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
    .option('--version <semver>', 'Explicit promoted version')
    .option('--json', 'Emit structured JSON output')
).action((skillRef, opts) =>
  runCommand(
    opts,
    () => {
      const workspacePath = resolveWorkspacePath(opts);
      return {
        skill: workgraph.skill.promoteSkill(workspacePath, skillRef, opts.actor, {
          version: opts.version,
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

program.parse();

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
  if (process.env.CLAWVAULT_PATH) return path.resolve(process.env.CLAWVAULT_PATH);
  return process.cwd();
}

function csv(value?: string): string[] | undefined {
  if (!value) return undefined;
  return String(value).split(',').map(s => s.trim()).filter(Boolean);
}

function wantsJson(opts: JsonCapableOptions): boolean {
  if (opts.json) return true;
  if (process.env.WORKGRAPH_JSON === '1') return true;
  return false;
}

function runCommand<T>(
  opts: JsonCapableOptions,
  action: () => T,
  renderText: (result: T) => string[]
): void {
  try {
    const result = action();
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
