import { Command } from 'commander';
import * as workgraph from '@versatly/workgraph-kernel';
import {
  addWorkspaceOption,
  csv,
  resolveWorkspacePath,
  runCommand,
} from '../core.js';

export function registerCursorCommands(program: Command, defaultActor: string): void {
  const cursorCmd = program
    .command('cursor')
    .description('Configure and run Cursor Automations bridge flows');

  addWorkspaceOption(
    cursorCmd
      .command('setup')
      .description('Configure Cursor webhook + dispatch bridge defaults')
      .option('-a, --actor <name>', 'Dispatch actor for bridged runs', defaultActor)
      .option('--enabled <bool>', 'Enable bridge (true|false)')
      .option('--secret <value>', 'Webhook HMAC shared secret')
      .option('--event-types <patterns>', 'Comma-separated event patterns (supports *)')
      .option('--adapter <name>', 'Dispatch adapter default')
      .option('--execute <bool>', 'Execute dispatch run immediately (true|false)')
      .option('--agents <actors>', 'Comma-separated agent identities')
      .option('--max-steps <n>', 'Maximum scheduler steps')
      .option('--step-delay-ms <ms>', 'Delay between scheduler steps')
      .option('--space <spaceRef>', 'Restrict dispatch to one space')
      .option('--checkpoint <bool>', 'Create dispatch checkpoint (true|false)')
      .option('--timeout-ms <ms>', 'Execution timeout in milliseconds')
      .option('--dispatch-mode <mode>', 'direct|self-assembly')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const config = workgraph.cursorBridge.setupCursorBridge(workspacePath, {
          actor: opts.actor,
          enabled: parseOptionalBoolean(opts.enabled, 'enabled'),
          secret: opts.secret,
          allowedEventTypes: csv(opts.eventTypes),
          dispatch: {
            adapter: opts.adapter,
            execute: parseOptionalBoolean(opts.execute, 'execute'),
            agents: csv(opts.agents),
            maxSteps: parseOptionalInt(opts.maxSteps, 'max-steps'),
            stepDelayMs: parseOptionalInt(opts.stepDelayMs, 'step-delay-ms'),
            space: opts.space,
            createCheckpoint: parseOptionalBoolean(opts.checkpoint, 'checkpoint'),
            timeoutMs: parseOptionalInt(opts.timeoutMs, 'timeout-ms'),
            dispatchMode: parseDispatchMode(opts.dispatchMode),
          },
        });
        const status = workgraph.cursorBridge.getCursorBridgeStatus(workspacePath, {
          recentEventsLimit: 3,
        });
        return {
          config,
          status,
        };
      },
      (result) => [
        `Cursor bridge configured: ${result.status.configPath}`,
        `Enabled: ${result.config.enabled}`,
        `Webhook secret: ${result.status.webhook.hasSecret ? 'configured' : 'not set'}`,
        `Allowed events: ${result.config.webhook.allowedEventTypes.join(', ')}`,
        `Dispatch default: actor=${result.config.dispatch.actor} adapter=${result.config.dispatch.adapter} execute=${result.config.dispatch.execute}`,
      ],
    ),
  );

  addWorkspaceOption(
    cursorCmd
      .command('status')
      .description('Show Cursor bridge configuration and recent bridge events')
      .option('--events <n>', 'Number of recent bridge events to show', '5')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.cursorBridge.getCursorBridgeStatus(workspacePath, {
          recentEventsLimit: parseOptionalInt(opts.events, 'events') ?? 5,
        });
      },
      (result) => [
        `Configured: ${result.configured}`,
        `Enabled: ${result.enabled}`,
        `Provider: ${result.provider}`,
        `Config path: ${result.configPath}`,
        `Events path: ${result.eventsPath}`,
        `Webhook secret: ${result.webhook.hasSecret ? 'configured' : 'not set'}`,
        `Allowed events: ${result.webhook.allowedEventTypes.join(', ')}`,
        `Dispatch default: actor=${result.dispatch.actor} adapter=${result.dispatch.adapter} execute=${result.dispatch.execute}`,
        ...(result.recentEvents.length === 0
          ? ['Recent events: none']
          : [
              'Recent events:',
              ...result.recentEvents.map((event) =>
                `- ${event.ts} ${event.eventType} run=${event.runId ?? 'none'} status=${event.runStatus ?? 'none'}${event.error ? ` error=${event.error}` : ''}`),
            ]),
      ],
    ),
  );

  addWorkspaceOption(
    cursorCmd
      .command('dispatch <objective>')
      .description('Dispatch one Cursor automation event through the bridge')
      .option('--event-type <type>', 'Cursor event type', 'cursor.automation.manual')
      .option('--event-id <id>', 'Cursor event id')
      .option('--actor <name>', 'Override dispatch actor')
      .option('--adapter <name>', 'Override dispatch adapter')
      .option('--execute <bool>', 'Execute dispatch run immediately (true|false)')
      .option('--context <json>', 'JSON object merged into dispatch context')
      .option('--idempotency-key <key>', 'Override idempotency key')
      .option('--agents <actors>', 'Comma-separated agent identities')
      .option('--max-steps <n>', 'Maximum scheduler steps')
      .option('--step-delay-ms <ms>', 'Delay between scheduler steps')
      .option('--space <spaceRef>', 'Restrict dispatch to one space')
      .option('--checkpoint <bool>', 'Create dispatch checkpoint (true|false)')
      .option('--timeout-ms <ms>', 'Execution timeout in milliseconds')
      .option('--dispatch-mode <mode>', 'direct|self-assembly')
      .option('--json', 'Emit structured JSON output'),
  ).action((objective, opts) =>
    runCommand(
      opts,
      async () => {
        const workspacePath = resolveWorkspacePath(opts);
        const result = await workgraph.cursorBridge.dispatchCursorAutomationEvent(workspacePath, {
          source: 'cli-dispatch',
          eventType: opts.eventType,
          eventId: opts.eventId,
          objective,
          actor: opts.actor,
          adapter: opts.adapter,
          execute: parseOptionalBoolean(opts.execute, 'execute'),
          context: parseOptionalJsonObject(opts.context, 'context'),
          idempotencyKey: opts.idempotencyKey,
          agents: csv(opts.agents),
          maxSteps: parseOptionalInt(opts.maxSteps, 'max-steps'),
          stepDelayMs: parseOptionalInt(opts.stepDelayMs, 'step-delay-ms'),
          space: opts.space,
          createCheckpoint: parseOptionalBoolean(opts.checkpoint, 'checkpoint'),
          timeoutMs: parseOptionalInt(opts.timeoutMs, 'timeout-ms'),
          dispatchMode: parseDispatchMode(opts.dispatchMode),
        });
        return result;
      },
      (result) => [
        `Dispatched Cursor event: ${result.event.eventType}`,
        `Run: ${result.run.id} [${result.run.status}]`,
        `Adapter: ${result.run.adapter}`,
        ...(result.run.output ? [`Output: ${result.run.output}`] : []),
        ...(result.run.error ? [`Error: ${result.run.error}`] : []),
      ],
    ),
  );
}

function parseOptionalBoolean(value: unknown, optionName: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  throw new Error(`Invalid --${optionName}. Expected true|false.`);
}

function parseOptionalInt(value: unknown, optionName: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid --${optionName}. Expected an integer.`);
  }
  return parsed;
}

function parseDispatchMode(value: unknown): 'direct' | 'self-assembly' | undefined {
  if (value === undefined) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'direct' || normalized === 'self-assembly') {
    return normalized;
  }
  throw new Error(`Invalid --dispatch-mode "${String(value)}". Expected direct|self-assembly.`);
}

function parseOptionalJsonObject(value: unknown, optionName: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Invalid --${optionName}. Expected valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid --${optionName}. Expected a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}
