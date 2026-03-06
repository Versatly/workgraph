import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import * as workgraph from '@versatly/workgraph-kernel';
import {
  deleteWebhookGatewaySource,
  listWebhookGatewayLogs,
  listWebhookGatewaySources,
  registerWebhookGatewaySource,
  startWorkgraphServer,
  testWebhookGatewaySource,
  waitForShutdown,
  type WebhookGatewayProvider,
} from '@versatly/workgraph-control-api';
import {
  addWorkspaceOption,
  parsePortOption,
  resolveWorkspacePath,
  runCommand,
  wantsJson,
} from '../core.js';

export function registerWebhookCommands(program: Command, defaultActor: string): void {
  const webhookCmd = program
    .command('webhook')
    .description('Universal webhook gateway management and operations');

  addWorkspaceOption(
    webhookCmd
      .command('serve')
      .description('Serve HTTP endpoints for inbound webhook sources')
      .option('--port <port>', 'HTTP port (defaults to server config or 8787)')
      .option('--host <host>', 'Bind host (defaults to server config or 0.0.0.0)')
      .option('--token <token>', 'Optional bearer token for MCP + REST auth')
      .option('-a, --actor <name>', 'Default actor for gateway-triggered mutations')
      .option('--json', 'Emit structured JSON startup output'),
  ).action(async (opts) => {
    const workspacePath = resolveWorkspacePath(opts);
    const serverConfig = workgraph.serverConfig.loadServerConfig(workspacePath);
    const port = opts.port !== undefined
      ? parsePortOption(opts.port)
      : (serverConfig?.port ?? 8787);
    const host = opts.host
      ? String(opts.host)
      : (serverConfig?.host ?? '0.0.0.0');
    const actor = opts.actor
      ? String(opts.actor)
      : (serverConfig?.defaultActor ?? defaultActor);
    const bearerToken = opts.token
      ? String(opts.token)
      : serverConfig?.bearerToken;

    const handle = await startWorkgraphServer({
      workspacePath,
      host,
      port,
      bearerToken,
      defaultActor: actor,
      endpointPath: serverConfig?.endpointPath,
    });

    const startupPayload = {
      serverUrl: handle.baseUrl,
      healthUrl: handle.healthUrl,
      mcpUrl: handle.url,
      webhookGatewayUrlTemplate: handle.webhookGatewayUrlTemplate,
    };
    if (wantsJson(opts)) {
      console.log(JSON.stringify({
        ok: true,
        data: startupPayload,
      }, null, 2));
    } else {
      console.log(`Server URL: ${handle.baseUrl}`);
      console.log(`Webhook endpoint template: ${handle.webhookGatewayUrlTemplate}`);
      console.log(`Health: ${handle.healthUrl}`);
      console.log(`MCP endpoint: ${handle.url}`);
    }

    await waitForShutdown(handle, {
      onSignal: (signal) => {
        if (!wantsJson(opts)) {
          console.error(`Received ${signal}; shutting down webhook gateway...`);
        }
      },
      onClosed: () => {
        if (!wantsJson(opts)) {
          console.error('Webhook gateway stopped.');
        }
      },
    });
  });

  addWorkspaceOption(
    webhookCmd
      .command('register <key>')
      .description('Register a webhook source endpoint')
      .requiredOption('--provider <provider>', 'github|linear|slack|generic')
      .option('--secret <secret>', 'HMAC secret for signature verification')
      .option('-a, --actor <name>', 'Actor used for accepted webhook events', defaultActor)
      .option('--event-prefix <prefix>', 'Event namespace suffix (default: provider)')
      .option('--disabled', 'Register source as disabled')
      .option('--json', 'Emit structured JSON output'),
  ).action((key, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          source: registerWebhookGatewaySource(workspacePath, {
            key,
            provider: parseWebhookProvider(opts.provider),
            secret: opts.secret,
            actor: opts.actor,
            eventPrefix: opts.eventPrefix,
            enabled: !opts.disabled,
          }),
        };
      },
      (result) => [
        `Registered webhook source: ${result.source.key}`,
        `Provider: ${result.source.provider}`,
        `Enabled: ${result.source.enabled}`,
        `Secret configured: ${result.source.hasSecret}`,
      ],
    ),
  );

  addWorkspaceOption(
    webhookCmd
      .command('list')
      .description('List registered webhook sources')
      .option('--provider <provider>', 'Filter by provider github|linear|slack|generic')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const provider = opts.provider ? parseWebhookProvider(opts.provider) : undefined;
        const sources = listWebhookGatewaySources(workspacePath)
          .filter((source) => (provider ? source.provider === provider : true));
        return {
          count: sources.length,
          sources,
        };
      },
      (result) => {
        if (result.sources.length === 0) return ['No webhook sources found.'];
        return [
          ...result.sources.map((source) =>
            `${source.key} provider=${source.provider} enabled=${source.enabled} secret=${source.hasSecret}`),
          `${result.count} source(s)`,
        ];
      },
    ),
  );

  addWorkspaceOption(
    webhookCmd
      .command('delete <keyOrId>')
      .description('Delete a registered webhook source')
      .option('--json', 'Emit structured JSON output'),
  ).action((keyOrId, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const deleted = deleteWebhookGatewaySource(workspacePath, keyOrId);
        if (!deleted) {
          throw new Error(`Webhook source not found: ${keyOrId}`);
        }
        return {
          deleted: keyOrId,
        };
      },
      (result) => [`Deleted webhook source: ${result.deleted}`],
    ),
  );

  addWorkspaceOption(
    webhookCmd
      .command('test <sourceKey>')
      .description('Emit a synthetic webhook event for one source')
      .option('--event <eventType>', 'Event type (default: webhook.<provider>.test)')
      .option('--payload <json>', 'Payload JSON string')
      .option('--payload-file <path>', 'Payload JSON file path')
      .option('--delivery-id <id>', 'Optional explicit delivery id')
      .option('--json', 'Emit structured JSON output'),
  ).action((sourceKey, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return testWebhookGatewaySource(workspacePath, {
          sourceKey,
          eventType: opts.event,
          payload: parseTestPayload(opts.payload, opts.payloadFile),
          deliveryId: opts.deliveryId,
        });
      },
      (result) => [
        `Sent synthetic webhook: ${result.source.key}`,
        `Event: ${result.eventType}`,
        `Delivery: ${result.deliveryId}`,
      ],
    ),
  );

  addWorkspaceOption(
    webhookCmd
      .command('log')
      .description('Read recent webhook gateway delivery logs')
      .option('--source <key>', 'Filter by source key')
      .option('--limit <n>', 'Limit entries (default: 50)', '50')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const limit = Number.parseInt(String(opts.limit), 10);
        const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 50;
        const logs = listWebhookGatewayLogs(workspacePath, {
          limit: safeLimit,
          sourceKey: opts.source,
        });
        return {
          count: logs.length,
          logs,
        };
      },
      (result) => {
        if (result.logs.length === 0) return ['No webhook logs found.'];
        return [
          ...result.logs.map((entry) =>
            `${entry.ts} [${entry.status}] source=${entry.sourceKey} event=${entry.eventType} code=${entry.statusCode}`),
          `${result.count} log entr${result.count === 1 ? 'y' : 'ies'}`,
        ];
      },
    ),
  );
}

function parseWebhookProvider(value: unknown): WebhookGatewayProvider {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (
    normalized === 'github'
    || normalized === 'linear'
    || normalized === 'slack'
    || normalized === 'generic'
  ) {
    return normalized;
  }
  throw new Error(`Invalid webhook provider "${String(value)}". Expected github|linear|slack|generic.`);
}

function parseTestPayload(rawPayload: unknown, payloadFile: unknown): unknown {
  const payloadText = typeof rawPayload === 'string'
    ? rawPayload.trim()
    : '';
  if (payloadText) {
    return parseJsonPayload(payloadText, '--payload');
  }
  const payloadFilePath = typeof payloadFile === 'string'
    ? payloadFile.trim()
    : '';
  if (payloadFilePath) {
    const absolutePath = path.resolve(payloadFilePath);
    const fileText = fs.readFileSync(absolutePath, 'utf-8');
    return parseJsonPayload(fileText, '--payload-file');
  }
  return undefined;
}

function parseJsonPayload(text: string, option: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Invalid ${option} JSON payload.`);
  }
}
