import { Command } from 'commander';
import * as workgraph from '@versatly/workgraph-kernel';
import {
  addWorkspaceOption,
  csv,
  resolveWorkspacePath,
  runCommand,
} from '../core.js';

export function registerTriggerCommands(program: Command, defaultActor: string): void {
  const triggerCmd = program
    .command('trigger')
    .description('Programmable trigger primitives and evaluation engine');

  addWorkspaceOption(
    triggerCmd
      .command('create <name>')
      .description('Create a trigger primitive (cron|webhook|event|manual)')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--type <type>', 'cron|webhook|event|manual', 'event')
      .option('--condition <value>', 'Condition as cron text or JSON')
      .option('--action <value>', 'Action as objective text or JSON')
      .option('--objective <text>', 'Dispatch objective template shortcut')
      .option('--adapter <name>', 'Dispatch adapter shortcut')
      .option('--context <json>', 'Dispatch context JSON object shortcut')
      .option('--enabled <bool>', 'Enable trigger (true|false)', 'true')
      .option('--cooldown <seconds>', 'Cooldown seconds', '0')
      .option('--tags <tags>', 'Comma-separated tags')
      .option('--body <text>', 'Markdown body')
      .option('--path <path>', 'Optional trigger markdown path override')
      .option('--json', 'Emit structured JSON output'),
  ).action((name, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          trigger: workgraph.trigger.createTrigger(workspacePath, {
            actor: opts.actor,
            name,
            type: parseTriggerType(opts.type),
            condition: parseUnknownOption(opts.condition),
            action: resolveActionInput(opts),
            enabled: parseOptionalBoolean(opts.enabled, 'enabled'),
            cooldown: parseOptionalInt(opts.cooldown, 'cooldown') ?? 0,
            tags: csv(opts.tags),
            body: opts.body,
            path: opts.path,
          }),
        };
      },
      (result) => [
        `Created trigger: ${result.trigger.path}`,
        `Type: ${String(result.trigger.fields.type ?? 'event')}`,
        `Enabled: ${String(result.trigger.fields.enabled ?? true)}`,
      ],
    ),
  );

  addWorkspaceOption(
    triggerCmd
      .command('list')
      .description('List trigger primitives')
      .option('--type <type>', 'Filter by cron|webhook|event|manual')
      .option('--enabled <bool>', 'Filter by enabled state (true|false)')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const triggers = workgraph.trigger.listTriggers(workspacePath, {
          type: opts.type ? parseTriggerType(opts.type) : undefined,
          enabled: parseOptionalBoolean(opts.enabled, 'enabled'),
        });
        return {
          triggers,
          count: triggers.length,
        };
      },
      (result) => {
        if (result.triggers.length === 0) return ['No triggers found.'];
        return [
          ...result.triggers.map((trigger) =>
            `[${String(trigger.fields.type ?? 'event')}] enabled=${String(trigger.fields.enabled ?? true)} ${trigger.path}`),
          `${result.count} trigger(s)`,
        ];
      },
    ),
  );

  addWorkspaceOption(
    triggerCmd
      .command('show <triggerRef>')
      .description('Show one trigger primitive')
      .option('--json', 'Emit structured JSON output'),
  ).action((triggerRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const trigger = workgraph.trigger.showTrigger(workspacePath, triggerRef);
        const history = workgraph.trigger.triggerHistory(workspacePath, triggerRef);
        return {
          trigger,
          historyCount: history.length,
        };
      },
      (result) => [
        `Trigger: ${result.trigger.path}`,
        `Name: ${String(result.trigger.fields.name ?? result.trigger.fields.title ?? result.trigger.path)}`,
        `Type: ${String(result.trigger.fields.type ?? 'event')} Enabled: ${String(result.trigger.fields.enabled ?? true)}`,
        `History entries: ${result.historyCount}`,
      ],
    ),
  );

  addWorkspaceOption(
    triggerCmd
      .command('update <triggerRef>')
      .description('Update a trigger primitive')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--name <name>', 'Rename trigger')
      .option('--type <type>', 'cron|webhook|event|manual')
      .option('--condition <value>', 'Condition as cron text or JSON')
      .option('--action <value>', 'Action as objective text or JSON')
      .option('--objective <text>', 'Dispatch objective template shortcut')
      .option('--adapter <name>', 'Dispatch adapter shortcut')
      .option('--context <json>', 'Dispatch context JSON object shortcut')
      .option('--enabled <bool>', 'Enable trigger (true|false)')
      .option('--cooldown <seconds>', 'Cooldown seconds')
      .option('--tags <tags>', 'Comma-separated tags')
      .option('--body <text>', 'Replace markdown body')
      .option('--json', 'Emit structured JSON output'),
  ).action((triggerRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          trigger: workgraph.trigger.updateTrigger(workspacePath, triggerRef, {
            actor: opts.actor,
            name: opts.name,
            type: opts.type ? parseTriggerType(opts.type) : undefined,
            condition: opts.condition !== undefined ? parseUnknownOption(opts.condition) : undefined,
            action: resolveActionInput(opts, true),
            enabled: parseOptionalBoolean(opts.enabled, 'enabled'),
            cooldown: parseOptionalInt(opts.cooldown, 'cooldown'),
            tags: opts.tags !== undefined ? (csv(opts.tags) ?? []) : undefined,
            body: opts.body,
          }),
        };
      },
      (result) => [
        `Updated trigger: ${result.trigger.path}`,
        `Type: ${String(result.trigger.fields.type ?? 'event')}`,
        `Enabled: ${String(result.trigger.fields.enabled ?? true)}`,
      ],
    ),
  );

  addWorkspaceOption(
    triggerCmd
      .command('delete <triggerRef>')
      .description('Delete a trigger primitive (soft archive)')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--json', 'Emit structured JSON output'),
  ).action((triggerRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        workgraph.trigger.deleteTrigger(workspacePath, triggerRef, opts.actor);
        return { deleted: triggerRef };
      },
      (result) => [`Deleted trigger: ${result.deleted}`],
    ),
  );

  addWorkspaceOption(
    triggerCmd
      .command('enable <triggerRef>')
      .description('Enable a trigger primitive')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--json', 'Emit structured JSON output'),
  ).action((triggerRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          trigger: workgraph.trigger.enableTrigger(workspacePath, triggerRef, opts.actor),
        };
      },
      (result) => [`Enabled trigger: ${result.trigger.path}`],
    ),
  );

  addWorkspaceOption(
    triggerCmd
      .command('disable <triggerRef>')
      .description('Disable a trigger primitive')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--json', 'Emit structured JSON output'),
  ).action((triggerRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          trigger: workgraph.trigger.disableTrigger(workspacePath, triggerRef, opts.actor),
        };
      },
      (result) => [`Disabled trigger: ${result.trigger.path}`],
    ),
  );

  addWorkspaceOption(
    triggerCmd
      .command('evaluate [triggerRef]')
      .description('Evaluate trigger engine once (all or one trigger)')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--now <iso>', 'Evaluation timestamp override (ISO-8601)')
      .option('--json', 'Emit structured JSON output'),
  ).action((triggerRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const now = opts.now ? parseIsoDate(opts.now, 'now') : undefined;
        if (triggerRef) {
          return workgraph.trigger.evaluateTrigger(workspacePath, triggerRef, {
            actor: opts.actor,
            now,
          });
        }
        return workgraph.triggerEngine.runTriggerEngineCycle(workspacePath, {
          actor: opts.actor,
          now,
        });
      },
      (result) => {
        if ('cycle' in result) {
          const triggerResult = result.trigger;
          return [
            `Evaluated trigger: ${result.triggerPath}`,
            `Fired: ${String(triggerResult?.fired ?? false)}`,
            `Reason: ${String(triggerResult?.reason ?? 'n/a')}`,
            ...(triggerResult?.nextFireAt ? [`Next fire: ${triggerResult.nextFireAt}`] : []),
          ];
        }
        return [
          `Evaluated: ${result.evaluated} triggers`,
          `Fired: ${result.fired}`,
          `Errors: ${result.errors}`,
          ...result.triggers.map((entry) =>
            `  ${entry.triggerPath}: ${entry.fired ? 'FIRED' : 'skipped'} (${entry.reason})${entry.nextFireAt ? ` next=${entry.nextFireAt}` : ''}`),
        ];
      },
    ),
  );

  addWorkspaceOption(
    triggerCmd
      .command('history <triggerRef>')
      .description('Show trigger ledger history')
      .option('--limit <n>', 'Limit number of history entries')
      .option('--json', 'Emit structured JSON output'),
  ).action((triggerRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const entries = workgraph.trigger.triggerHistory(workspacePath, triggerRef);
        const limit = parseOptionalInt(opts.limit, 'limit');
        const limited = limit ? entries.slice(-limit) : entries;
        return {
          triggerRef,
          entries: limited,
          count: limited.length,
        };
      },
      (result) => {
        if (result.entries.length === 0) return [`No history for ${result.triggerRef}.`];
        return [
          ...result.entries.map((entry) => `${entry.ts} ${entry.op} ${entry.actor}`),
          `${result.count} entr${result.count === 1 ? 'y' : 'ies'}`,
        ];
      },
    ),
  );

  addWorkspaceOption(
    triggerCmd
      .command('fire <triggerPath>')
      .description('Fire an approved/active trigger and dispatch a run')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--event-key <key>', 'Deterministic event key for idempotency')
      .option('--objective <text>', 'Override run objective')
      .option('--adapter <name>', 'Adapter override for dispatched run')
      .option('--execute', 'Execute the triggered run immediately')
      .option('--retry-failed', 'Retry failed run when idempotency resolves to failed status')
      .option('--agents <actors>', 'Comma-separated agent identities for execution')
      .option('--max-steps <n>', 'Maximum scheduler steps for execution')
      .option('--step-delay-ms <ms>', 'Delay between scheduling steps for execution')
      .option('--space <spaceRef>', 'Restrict execution to one space')
      .option('--timeout-ms <ms>', 'Execution timeout in milliseconds')
      .option('--dispatch-mode <mode>', 'direct|self-assembly')
      .option('--self-assembly-agent <agent>', 'Agent identity for self-assembly dispatch mode')
      .option('--json', 'Emit structured JSON output'),
  ).action((triggerPath, opts) =>
    runCommand(
      opts,
      async () => {
        const workspacePath = resolveWorkspacePath(opts);
        if (opts.execute) {
          return workgraph.trigger.fireTriggerAndExecute(workspacePath, triggerPath, {
            actor: opts.actor,
            eventKey: opts.eventKey,
            objective: opts.objective,
            adapter: opts.adapter,
            retryFailed: Boolean(opts.retryFailed),
            executeInput: {
              agents: opts.agents ? String(opts.agents).split(',').map((entry: string) => entry.trim()).filter(Boolean) : undefined,
              maxSteps: opts.maxSteps ? Number.parseInt(String(opts.maxSteps), 10) : undefined,
              stepDelayMs: opts.stepDelayMs ? Number.parseInt(String(opts.stepDelayMs), 10) : undefined,
              space: opts.space,
              timeoutMs: opts.timeoutMs ? Number.parseInt(String(opts.timeoutMs), 10) : undefined,
              dispatchMode: opts.dispatchMode,
              selfAssemblyAgent: opts.selfAssemblyAgent,
            },
          });
        }
        return workgraph.trigger.fireTrigger(workspacePath, triggerPath, {
          actor: opts.actor,
          eventKey: opts.eventKey,
          objective: opts.objective,
          adapter: opts.adapter,
        });
      },
      (result) => [
        ...(() => {
          const executedResult = result as { executed?: boolean; retriedFromRunId?: string };
          if (!executedResult.executed) return [];
          return [`Executed: yes${executedResult.retriedFromRunId ? ` (retried from ${executedResult.retriedFromRunId})` : ''}`];
        })(),
        `Fired trigger: ${result.triggerPath}`,
        `Run: ${result.run.id} [${result.run.status}]`,
      ],
    ),
  );

  const triggerEngineCmd = triggerCmd
    .command('engine')
    .description('Run trigger engine');

  addWorkspaceOption(
    triggerEngineCmd
      .command('run')
      .description('Process one trigger-engine cycle')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--execute-runs', 'Execute dispatch-run actions as full run->evidence loop')
      .option('--retry-failed-runs', 'Retry failed runs when dispatch-run hits failed idempotent runs')
      .option('--agents <actors>', 'Comma-separated agent identities for execution')
      .option('--max-steps <n>', 'Maximum scheduler steps for execution')
      .option('--step-delay-ms <ms>', 'Delay between scheduling steps for execution')
      .option('--space <spaceRef>', 'Restrict execution to one space')
      .option('--timeout-ms <ms>', 'Execution timeout in milliseconds')
      .option('--dispatch-mode <mode>', 'direct|self-assembly')
      .option('--self-assembly-agent <agent>', 'Agent identity for self-assembly dispatch mode')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      async () => {
        const workspacePath = resolveWorkspacePath(opts);
        if (opts.executeRuns) {
          return workgraph.triggerEngine.runTriggerRunEvidenceLoop(workspacePath, {
            actor: opts.actor,
            retryFailedRuns: Boolean(opts.retryFailedRuns),
            execution: {
              agents: opts.agents ? String(opts.agents).split(',').map((entry: string) => entry.trim()).filter(Boolean) : undefined,
              maxSteps: opts.maxSteps ? Number.parseInt(String(opts.maxSteps), 10) : undefined,
              stepDelayMs: opts.stepDelayMs ? Number.parseInt(String(opts.stepDelayMs), 10) : undefined,
              space: opts.space,
              timeoutMs: opts.timeoutMs ? Number.parseInt(String(opts.timeoutMs), 10) : undefined,
              dispatchMode: opts.dispatchMode,
              selfAssemblyAgent: opts.selfAssemblyAgent,
            },
          });
        }
        return workgraph.triggerEngine.runTriggerEngineCycle(workspacePath, {
          actor: opts.actor,
        });
      },
      (result) => {
        if ('cycle' in result) {
          return [
            `Evaluated: ${result.cycle.evaluated} triggers`,
            `Fired: ${result.cycle.fired}`,
            `Errors: ${result.cycle.errors}`,
            `Executed runs: ${result.executedRuns.length} (succeeded=${result.succeeded}, failed=${result.failed}, cancelled=${result.cancelled}, skipped=${result.skipped})`,
            ...result.cycle.triggers.map((t) =>
              `  ${t.triggerPath}: ${t.fired ? 'FIRED' : 'skipped'} (${t.reason})${t.error ? ` error: ${t.error}` : ''}`,
            ),
            ...result.executedRuns.map((run) =>
              `  run ${run.runId}: ${run.status}${run.retriedFromRunId ? ` (retried from ${run.retriedFromRunId})` : ''}${run.error ? ` error: ${run.error}` : ''}`,
            ),
          ];
        }
        return [
          `Evaluated: ${result.evaluated} triggers`,
          `Fired: ${result.fired}`,
          `Errors: ${result.errors}`,
          ...result.triggers.map((t) =>
            `  ${t.triggerPath}: ${t.fired ? 'FIRED' : 'skipped'} (${t.reason})${t.error ? ` error: ${t.error}` : ''}`,
          ),
        ];
      },
    ),
  );
}

function parseTriggerType(value: unknown): workgraph.trigger.TriggerPrimitiveType {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'cron' || normalized === 'webhook' || normalized === 'event' || normalized === 'manual') {
    return normalized;
  }
  throw new Error(`Invalid trigger type "${String(value)}". Expected cron|webhook|event|manual.`);
}

function parseOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`Invalid ${label} value "${String(value)}". Expected true|false.`);
}

function parseOptionalInt(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${label} value "${String(value)}". Expected an integer.`);
  }
  return parsed;
}

function parseUnknownOption(value: unknown): unknown {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  if (text.startsWith('{') || text.startsWith('[') || text.startsWith('"')) {
    return JSON.parse(text);
  }
  return text;
}

function parseJsonObjectOption(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid ${label} value. Expected a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function parseIsoDate(value: unknown, label: string): Date {
  const text = String(value ?? '').trim();
  const timestamp = Date.parse(text);
  if (!text || Number.isNaN(timestamp)) {
    throw new Error(`Invalid ${label} value "${String(value)}". Expected ISO-8601 date/time.`);
  }
  return new Date(timestamp);
}

function resolveActionInput(
  opts: {
    action?: string;
    objective?: string;
    adapter?: string;
    context?: string;
  },
  allowUndefined: boolean = false,
): unknown {
  if (opts.action !== undefined) {
    return parseUnknownOption(opts.action);
  }
  const context = parseJsonObjectOption(opts.context, 'context');
  if (opts.objective === undefined && opts.adapter === undefined && context === undefined) {
    return allowUndefined ? undefined : undefined;
  }
  const action: Record<string, unknown> = {
    type: 'dispatch-run',
  };
  if (opts.objective !== undefined) action.objective = opts.objective;
  if (opts.adapter !== undefined) action.adapter = opts.adapter;
  if (context) action.context = context;
  return {
    ...action,
  };
}
