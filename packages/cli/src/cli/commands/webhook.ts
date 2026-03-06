import crypto from 'node:crypto';
import { Command } from 'commander';
import * as workgraph from '@versatly/workgraph-kernel';
import {
  startWorkgraphServer,
  waitForShutdown,
  webhookTriggerPath,
  type WebhookSource,
} from '@versatly/workgraph-control-api';
import {
  addWorkspaceOption,
  parsePortOption,
  resolveWorkspacePath,
  runCommand,
} from '../core.js';

interface WebhookCommandOptions {
  actor?: string;
  source?: string;
  id?: string;
  objective?: string;
  adapter?: string;
  event?: string;
  secret?: string;
  signingSecret?: string;
  gatewayApiKey?: string;
  host?: string;
  port?: string;
  token?: string;
  baseUrl?: string;
  server?: string;
  json?: boolean;
  workspace?: string;
  vault?: string;
  sharedVault?: string;
  apiKey?: string;
  limit?: string;
  status?: string;
  dryRun?: boolean;
}

export function registerWebhookCommands(program: Command, defaultActor: string): void {
  const webhookCmd = program
    .command('webhook')
    .description('Universal webhook ingestion gateway management');

  addWorkspaceOption(
    webhookCmd
      .command('serve')
      .description('Start Workgraph server with webhook gateway endpoint')
      .option('--port <port>', 'HTTP port (defaults to server config or 8787)')
      .option('--host <host>', 'Bind host (defaults to server config or 0.0.0.0)')
      .option('--token <token>', 'Optional bearer token for API auth')
      .option('-a, --actor <name>', 'Default actor for webhook-triggered dispatch'),
  ).action(async (opts: WebhookCommandOptions) => {
    const workspacePath = resolveWorkspacePath(opts);
    const serverConfig = workgraph.serverConfig.loadServerConfig(workspacePath);
    const port = opts.port !== undefined
      ? parsePortOption(opts.port)
      : (serverConfig?.port ?? 8787);
    const host = readNonEmptyString(opts.host)
      ?? serverConfig?.host
      ?? '0.0.0.0';
    const defaultWebhookActor = readNonEmptyString(opts.actor)
      ?? serverConfig?.defaultActor
      ?? defaultActor;
    const endpointPath = serverConfig?.endpointPath;
    const bearerToken = readNonEmptyString(opts.token) ?? serverConfig?.bearerToken;
    const handle = await startWorkgraphServer({
      workspacePath,
      host,
      port,
      endpointPath,
      bearerToken,
      defaultActor: defaultWebhookActor,
    });
    console.log(`Server URL: ${handle.baseUrl}`);
    console.log(`Webhook gateway: ${handle.baseUrl}/webhooks/:source/:id`);
    console.log(`Health: ${handle.healthUrl}`);
    await waitForShutdown(handle, {
      onSignal: (signal) => {
        console.error(`Received ${signal}; shutting down...`);
      },
      onClosed: () => {
        console.error('Server stopped.');
      },
    });
  });

  addWorkspaceOption(
    webhookCmd
      .command('register <source> <id>')
      .description('Register/update a webhook trigger endpoint')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--objective <text>', 'Dispatch objective template')
      .option('--adapter <name>', 'Dispatch adapter override')
      .option('--event <pattern>', 'Trigger event pattern override')
      .option('--secret <secret>', 'Webhook secret for github/linear')
      .option('--signing-secret <secret>', 'Slack signing secret')
      .option('--gateway-api-key <key>', 'Generic source API key')
      .option('--base-url <url>', 'Server base URL for endpoint output')
      .option('--json', 'Emit structured JSON output'),
  ).action((sourceInput: string, idInput: string, opts: WebhookCommandOptions) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const source = normalizeSource(sourceInput);
        const endpointId = normalizeEndpointId(idInput);
        const pathRef = webhookTriggerPath(source, endpointId);
        const triggerName = `Webhook ${source}/${endpointId}`;
        const condition = buildWebhookCondition(source, endpointId, opts);
        const action = buildWebhookAction(source, opts);
        const actor = readNonEmptyString(opts.actor) ?? defaultActor;

        const existing = tryReadTrigger(workspacePath, pathRef);
        const webhookTrigger = existing
          ? workgraph.trigger.updateTrigger(workspacePath, pathRef, {
            actor,
            name: triggerName,
            type: 'webhook',
            condition,
            action,
            enabled: true,
          })
          : workgraph.trigger.createTrigger(workspacePath, {
            actor,
            name: triggerName,
            type: 'webhook',
            condition,
            action,
            tags: ['webhook', source],
            path: pathRef,
          });
        const baseUrl = resolveBaseUrl(workspacePath, opts.baseUrl);
        return {
          created: !existing,
          source,
          endpointId,
          triggerPath: webhookTrigger.path,
          endpointUrl: `${baseUrl}/webhooks/${source}/${encodeURIComponent(endpointId)}`,
        };
      },
      (result) => [
        `${result.created ? 'Registered' : 'Updated'} webhook trigger: ${result.triggerPath}`,
        `Endpoint: ${result.endpointUrl}`,
      ],
    ),
  );

  addWorkspaceOption(
    webhookCmd
      .command('list')
      .description('List registered webhook trigger endpoints')
      .option('--source <source>', 'Filter by source')
      .option('--base-url <url>', 'Server base URL for endpoint output')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts: WebhookCommandOptions) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const sourceFilter = opts.source ? normalizeSource(opts.source) : undefined;
        const baseUrl = resolveBaseUrl(workspacePath, opts.baseUrl);
        const triggers = workgraph.trigger.listTriggers(workspacePath, { type: 'webhook' });
        const entries = triggers
          .map((entry) => toWebhookListEntry(entry, baseUrl))
          .filter((entry) => (sourceFilter ? entry.source === sourceFilter : true));
        return {
          count: entries.length,
          webhooks: entries,
        };
      },
      (result) => {
        if (result.webhooks.length === 0) return ['No webhook endpoints registered.'];
        return [
          ...result.webhooks.map((entry) =>
            `${entry.source}/${entry.endpointId} -> ${entry.triggerPath} (${entry.endpointUrl})`),
          `${result.count} webhook endpoint(s)`,
        ];
      },
    ),
  );

  addWorkspaceOption(
    webhookCmd
      .command('delete <source> <id>')
      .description('Delete a webhook trigger endpoint')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--json', 'Emit structured JSON output'),
  ).action((sourceInput: string, idInput: string, opts: WebhookCommandOptions) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const source = normalizeSource(sourceInput);
        const endpointId = normalizeEndpointId(idInput);
        const pathRef = webhookTriggerPath(source, endpointId);
        const actor = readNonEmptyString(opts.actor) ?? defaultActor;
        workgraph.trigger.deleteTrigger(workspacePath, pathRef, actor);
        return {
          source,
          endpointId,
          triggerPath: pathRef,
        };
      },
      (result) => [`Deleted webhook trigger: ${result.triggerPath}`],
    ),
  );

  addWorkspaceOption(
    webhookCmd
      .command('test <source> <id>')
      .description('Send a signed sample webhook request to the gateway')
      .option('--server <url>', 'Webhook server base URL (defaults to server config)')
      .option('--secret <secret>', 'Webhook secret for github/linear')
      .option('--signing-secret <secret>', 'Slack signing secret')
      .option('--gateway-api-key <key>', 'Generic source API key')
      .option('--json', 'Emit structured JSON output'),
  ).action((sourceInput: string, idInput: string, opts: WebhookCommandOptions) =>
    runCommand(
      opts,
      async () => {
        const workspacePath = resolveWorkspacePath(opts);
        const source = normalizeSource(sourceInput);
        const endpointId = normalizeEndpointId(idInput);
        const baseUrl = resolveBaseUrl(workspacePath, opts.server);
        const request = buildSampleRequest(source, endpointId, opts);
        const response = await fetch(`${baseUrl}/webhooks/${source}/${encodeURIComponent(endpointId)}`, {
          method: 'POST',
          headers: request.headers,
          body: request.rawBody,
        });
        const responseText = await response.text();
        const responseJson = tryParseJson(responseText);
        return {
          source,
          endpointId,
          status: response.status,
          request: {
            headers: request.headers,
            payload: request.payload,
          },
          response: responseJson ?? responseText,
        };
      },
      (result) => [
        `Webhook test status: ${result.status}`,
        `Source: ${result.source} Endpoint: ${result.endpointId}`,
        `Response: ${typeof result.response === 'string' ? result.response : JSON.stringify(result.response)}`,
      ],
    ),
  );

  addWorkspaceOption(
    webhookCmd
      .command('log')
      .description('List dispatch runs created by webhook gateway')
      .option('--source <source>', 'Filter by source')
      .option('--id <id>', 'Filter by endpoint id')
      .option('--limit <n>', 'Max log rows', '20')
      .option('--status <status>', 'Filter by run status')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts: WebhookCommandOptions) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const sourceFilter = opts.source ? normalizeSource(opts.source) : undefined;
        const endpointFilter = readNonEmptyString(opts.id);
        const limit = parseLimit(opts.limit, 20);
        const status = readNonEmptyString(opts.status) as
          | 'queued'
          | 'running'
          | 'succeeded'
          | 'failed'
          | 'cancelled'
          | undefined;
        const runs = workgraph.dispatch.listRuns(workspacePath, { status });
        const filtered = runs
          .filter((run) => {
            const webhookContext = toRecord(run.context?.webhook);
            if (String(run.context?.trigger_type ?? '').toLowerCase() !== 'webhook') return false;
            if (sourceFilter && readNonEmptyString(webhookContext.source) !== sourceFilter) return false;
            if (endpointFilter && readNonEmptyString(webhookContext.endpoint_id) !== endpointFilter) return false;
            return true;
          })
          .slice(0, limit)
          .map((run) => {
            const webhookContext = toRecord(run.context?.webhook);
            return {
              runId: run.id,
              status: run.status,
              createdAt: run.createdAt,
              triggerPath: readNonEmptyString(run.context?.trigger_path) ?? '',
              source: readNonEmptyString(webhookContext.source) ?? 'unknown',
              endpointId: readNonEmptyString(webhookContext.endpoint_id) ?? 'unknown',
              eventType: readNonEmptyString(webhookContext.event_type) ?? 'unknown',
              eventId: readNonEmptyString(webhookContext.event_id) ?? 'unknown',
            };
          });
        return {
          count: filtered.length,
          logs: filtered,
        };
      },
      (result) => {
        if (result.logs.length === 0) return ['No webhook dispatch runs found.'];
        return [
          ...result.logs.map((entry) =>
            `${entry.createdAt} ${entry.status} ${entry.source}/${entry.endpointId} event=${entry.eventType} run=${entry.runId}`),
          `${result.count} webhook run(s)`,
        ];
      },
    ),
  );
}

function buildWebhookCondition(
  source: WebhookSource,
  endpointId: string,
  opts: WebhookCommandOptions,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: 'event',
    pattern: readNonEmptyString(opts.event) ?? `webhook.${source}.*`,
    source,
    endpointId,
  };
  if (source === 'github' || source === 'linear') {
    const secret = readNonEmptyString(opts.secret);
    if (secret) base.secret = secret;
  }
  if (source === 'slack') {
    const signingSecret = readNonEmptyString(opts.signingSecret) ?? readNonEmptyString(opts.secret);
    if (signingSecret) base.signingSecret = signingSecret;
  }
  if (source === 'generic') {
    const apiKey = readNonEmptyString(opts.gatewayApiKey);
    if (apiKey) base.apiKey = apiKey;
  }
  return base;
}

function buildWebhookAction(source: WebhookSource, opts: WebhookCommandOptions): Record<string, unknown> {
  const objective = readNonEmptyString(opts.objective)
    ?? `Handle ${source} webhook {{webhook.event_type}}`;
  return {
    type: 'dispatch-run',
    objective,
    ...(readNonEmptyString(opts.adapter) ? { adapter: readNonEmptyString(opts.adapter)! } : {}),
  };
}

function toWebhookListEntry(
  entry: { path: string; fields: Record<string, unknown> },
  baseUrl: string,
): {
  source: WebhookSource;
  endpointId: string;
  triggerPath: string;
  endpointUrl: string;
} {
  const condition = toRecord(entry.fields.condition);
  const source = normalizeSource(
    readNonEmptyString(condition.source)
    ?? inferSourceFromTriggerPath(entry.path)
    ?? 'generic',
  );
  const endpointId = readNonEmptyString(condition.endpointId)
    ?? inferIdFromTriggerPath(entry.path)
    ?? pathToEndpointId(entry.path);
  return {
    source,
    endpointId,
    triggerPath: entry.path,
    endpointUrl: `${baseUrl}/webhooks/${source}/${encodeURIComponent(endpointId)}`,
  };
}

function buildSampleRequest(
  source: WebhookSource,
  endpointId: string,
  opts: WebhookCommandOptions,
): {
  headers: Record<string, string>;
  payload: Record<string, unknown>;
  rawBody: string;
} {
  const nowSeconds = String(Math.floor(Date.now() / 1000));
  if (source === 'github') {
    const secret = requireOption(
      readNonEmptyString(opts.secret) ?? readNonEmptyString(process.env.WORKGRAPH_WEBHOOK_GITHUB_SECRET),
      '--secret (or WORKGRAPH_WEBHOOK_GITHUB_SECRET) is required for github test',
    );
    const payload = {
      action: 'opened',
      repository: {
        full_name: 'versatly/workgraph',
      },
      sender: {
        login: 'octocat',
      },
    };
    const rawBody = JSON.stringify(payload);
    const signature = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    return {
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': `test-${endpointId}-${nowSeconds}`,
        'x-hub-signature-256': signature,
      },
      payload,
      rawBody,
    };
  }

  if (source === 'linear') {
    const secret = requireOption(
      readNonEmptyString(opts.secret) ?? readNonEmptyString(process.env.WORKGRAPH_WEBHOOK_LINEAR_SECRET),
      '--secret (or WORKGRAPH_WEBHOOK_LINEAR_SECRET) is required for linear test',
    );
    const payload = {
      type: 'Issue',
      action: 'create',
      actor: {
        id: 'user_1',
        name: 'Webhook Tester',
      },
      data: {
        id: `lin_${nowSeconds}`,
        identifier: 'ENG-1',
      },
    };
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return {
      headers: {
        'content-type': 'application/json',
        'linear-signature': signature,
      },
      payload,
      rawBody,
    };
  }

  if (source === 'slack') {
    const secret = requireOption(
      readNonEmptyString(opts.signingSecret)
      ?? readNonEmptyString(opts.secret)
      ?? readNonEmptyString(process.env.WORKGRAPH_WEBHOOK_SLACK_SIGNING_SECRET),
      '--signing-secret (or WORKGRAPH_WEBHOOK_SLACK_SIGNING_SECRET) is required for slack test',
    );
    const payload = {
      type: 'event_callback',
      event_id: `Ev${nowSeconds}`,
      team_id: 'T_TEST',
      event: {
        type: 'app_mention',
        user: 'U_TEST',
        channel: 'C_TEST',
      },
    };
    const rawBody = JSON.stringify(payload);
    const signatureBase = `v0:${nowSeconds}:${rawBody}`;
    const signature = `v0=${crypto.createHmac('sha256', secret).update(signatureBase).digest('hex')}`;
    return {
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': nowSeconds,
        'x-slack-signature': signature,
      },
      payload,
      rawBody,
    };
  }

  const apiKey = requireOption(
    readNonEmptyString(opts.gatewayApiKey)
    ?? readNonEmptyString(process.env.WORKGRAPH_WEBHOOK_GENERIC_API_KEY),
    '--gateway-api-key (or WORKGRAPH_WEBHOOK_GENERIC_API_KEY) is required for generic test',
  );
  const payload = {
    id: `evt_${nowSeconds}`,
    type: 'generic.test',
    actor: 'webhook-tester',
    resource: 'resource/test',
  };
  const rawBody = JSON.stringify(payload);
  return {
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'x-event-type': 'generic.test',
    },
    payload,
    rawBody,
  };
}

function resolveBaseUrl(workspacePath: string, explicitBaseUrl?: string): string {
  const fromOption = readNonEmptyString(explicitBaseUrl);
  if (fromOption) {
    const parsed = new URL(fromOption);
    return parsed.toString().replace(/\/$/, '');
  }
  const config = workgraph.serverConfig.loadServerConfig(workspacePath);
  const host = config?.host ?? '127.0.0.1';
  const port = config?.port ?? 8787;
  return `http://${host}:${port}`;
}

function normalizeSource(value: string): WebhookSource {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'github' || normalized === 'linear' || normalized === 'slack' || normalized === 'generic') {
    return normalized;
  }
  throw new Error(`Invalid webhook source "${value}". Expected github|linear|slack|generic.`);
}

function normalizeEndpointId(value: string): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) throw new Error('Webhook endpoint id is required.');
  return trimmed;
}

function parseLimit(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function requireOption(value: string | undefined, errorMessage: string): string {
  if (!value) throw new Error(errorMessage);
  return value;
}

function tryReadTrigger(workspacePath: string, triggerRef: string): unknown {
  try {
    return workgraph.trigger.showTrigger(workspacePath, triggerRef);
  } catch {
    return null;
  }
}

function inferSourceFromTriggerPath(triggerPath: string): string | undefined {
  const base = triggerPath.replace(/^triggers\//, '').replace(/\.md$/, '');
  const parts = base.split('-');
  if (parts.length < 3 || parts[0] !== 'webhook') return undefined;
  return parts[1];
}

function inferIdFromTriggerPath(triggerPath: string): string | undefined {
  const base = triggerPath.replace(/^triggers\//, '').replace(/\.md$/, '');
  const parts = base.split('-');
  if (parts.length < 3 || parts[0] !== 'webhook') return undefined;
  return parts.slice(2).join('-');
}

function pathToEndpointId(triggerPath: string): string {
  return triggerPath.replace(/^triggers\//, '').replace(/\.md$/, '');
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function tryParseJson(value: string): unknown {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}
