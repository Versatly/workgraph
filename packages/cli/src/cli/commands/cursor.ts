import fs from 'node:fs';
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
    .description('Configure and dispatch Cursor Automations bridge');

  addWorkspaceOption(
    cursorCmd
      .command('setup')
      .description('Configure Cursor automation integration for this workspace')
      .option('--webhook-url <url>', 'Cursor automation dispatch webhook URL')
      .option('--webhook-token <token>', 'Optional bearer token for dispatch webhook')
      .option('--inbound-secret <secret>', 'Shared secret required by /api/cursor/webhook')
      .option('--result-webhook-url <url>', 'Callback URL Cursor should call after completion')
      .option('--prompt-template <text>', 'Prompt template for automation dispatches')
      .option('--prompt-template-file <path>', 'Read prompt template text from file')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const promptTemplate = opts.promptTemplateFile
          ? fs.readFileSync(String(opts.promptTemplateFile), 'utf-8')
          : opts.promptTemplate;
        const config = workgraph.cursorBridge.saveCursorAutomationConfig(workspacePath, {
          webhookUrl: opts.webhookUrl,
          webhookToken: opts.webhookToken,
          inboundWebhookSecret: opts.inboundSecret,
          resultWebhookUrl: opts.resultWebhookUrl,
          promptTemplate,
        });
        return {
          config,
          configPath: workgraph.cursorBridge.cursorAutomationConfigPath(workspacePath),
        };
      },
      (result) => [
        `Cursor integration configured: ${result.configPath}`,
        `Webhook URL: ${result.config.webhookUrl ?? 'not set'}`,
        `Result callback URL: ${result.config.resultWebhookUrl ?? 'not set'}`,
        `Inbound secret: ${result.config.inboundWebhookSecret ? 'configured' : 'not set'}`,
      ],
    ),
  );

  addWorkspaceOption(
    cursorCmd
      .command('status')
      .description('Check Cursor integration configuration and webhook reachability')
      .option('--webhook-url <url>', 'Override webhook URL for this status check')
      .option('--timeout-ms <ms>', 'Connection timeout in milliseconds', '5000')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      async () => {
        const workspacePath = resolveWorkspacePath(opts);
        const config = workgraph.cursorBridge.loadCursorAutomationConfig(workspacePath);
        const timeoutMs = Number.parseInt(String(opts.timeoutMs), 10);
        const connection = await workgraph.cursorBridge.checkCursorAutomationConnection(workspacePath, {
          webhookUrl: opts.webhookUrl,
          timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
        });
        return { config, connection };
      },
      (result) => [
        `Configured: ${result.connection.configured ? 'yes' : 'no'}`,
        `Webhook URL: ${result.connection.webhookUrl ?? 'not set'}`,
        `Reachable: ${result.connection.reachable ? 'yes' : 'no'}`,
        `HTTP status: ${result.connection.statusCode ?? 'n/a'}`,
        `Latency: ${result.connection.latencyMs ?? 'n/a'} ms`,
        ...(result.connection.error ? [`Error: ${result.connection.error}`] : []),
      ],
    ),
  );

  addWorkspaceOption(
    cursorCmd
      .command('dispatch <threadRef>')
      .description('Dispatch one thread to Cursor automation')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--objective <text>', 'Override run objective')
      .option('--webhook-url <url>', 'Override cursor automation webhook URL for this run')
      .option('--result-webhook-url <url>', 'Override callback URL Cursor should post completion to')
      .option('--requirements <items>', 'Comma-separated requirement list')
      .option('--related-files <items>', 'Comma-separated related file paths')
      .option('--no-execute', 'Create run only and do not dispatch immediately')
      .option('--json', 'Emit structured JSON output'),
  ).action((threadRef, opts) =>
    runCommand(
      opts,
      async () => {
        const workspacePath = resolveWorkspacePath(opts);
        const threadPath = resolveThreadPath(threadRef);
        const threadInstance = workgraph.store.read(workspacePath, threadPath);
        if (!threadInstance || threadInstance.type !== 'thread') {
          throw new Error(`Thread not found: ${threadPath}`);
        }
        const objective = opts.objective
          ? String(opts.objective)
          : `Cursor automation for ${threadPath}: ${String(threadInstance.fields.goal ?? threadInstance.fields.title ?? threadPath)}`;
        const run = workgraph.dispatch.createRun(workspacePath, {
          actor: opts.actor,
          adapter: 'cursor-bridge',
          objective,
          context: {
            thread_path: threadPath,
            thread_description: String(threadInstance.fields.goal ?? objective),
            requirements: csv(opts.requirements),
            related_files: [
              ...new Set([
                ...(csv(opts.relatedFiles) ?? []),
                ...(Array.isArray(threadInstance.fields.context_refs)
                  ? threadInstance.fields.context_refs.map((entry) => String(entry))
                  : []),
                threadPath,
              ]),
            ],
            ...(opts.webhookUrl ? { cursor_webhook_url: String(opts.webhookUrl) } : {}),
            ...(opts.resultWebhookUrl ? { workgraph_webhook_url: String(opts.resultWebhookUrl) } : {}),
          },
        });
        if (opts.execute === false) {
          return { run, threadPath, executed: false };
        }
        const executedRun = await workgraph.dispatch.executeRun(workspacePath, run.id, {
          actor: opts.actor,
        });
        return { run: executedRun, threadPath, executed: true };
      },
      (result) => [
        `Thread: ${result.threadPath}`,
        `Run: ${result.run.id} [${result.run.status}]`,
        `Dispatched now: ${result.executed ? 'yes' : 'no'}`,
        ...(result.run.output ? [`Output: ${result.run.output}`] : []),
      ],
    ),
  );
}

function resolveThreadPath(threadRef: string): string {
  const raw = String(threadRef ?? '').trim();
  const cleaned = raw.startsWith('[[') && raw.endsWith(']]')
    ? raw.slice(2, -2)
    : raw;
  if (!cleaned) {
    throw new Error('Thread reference is required.');
  }
  if (cleaned.includes('/')) {
    return cleaned.endsWith('.md') ? cleaned : `${cleaned}.md`;
  }
  return `threads/${cleaned.endsWith('.md') ? cleaned : `${cleaned}.md`}`;
}
