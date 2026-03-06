import { Command } from 'commander';
import * as workgraph from '@versatly/workgraph-kernel';
import {
  createWebhookTestRequest,
  deleteWebhookRoute,
  listWebhookLogs,
  listWebhookRoutes,
  registerWebhookRoute,
  startWorkgraphServer,
  waitForShutdown,
} from '@versatly/workgraph-control-api';
import {
  addWorkspaceOption,
  parsePortOption,
  resolveWorkspacePath,
  runCommand,
} from '../core.js';

export function registerWebhookCommands(program: Command, defaultActor: string): void {
  const webhookCmd = program
    .command('webhook')
    .description('Manage universal webhook ingestion gateway routes and runtime');

  addWorkspaceOption(
    webhookCmd
      .command('register')
      .description('Map source+event to a trigger')
      .requiredOption('--source <source>', 'Webhook source (e.g. github|linear|slack|generic)')
      .requiredOption('--event <event>', 'Normalized event type (e.g. pr.merged)')
      .requiredOption('--trigger <triggerRef>', 'Trigger path or slug')
      .option('--secret <value>', 'Signing secret for this source (GitHub/Slack)')
      .option('--webhook-api-key <value>', 'API key for this source (Linear/Generic)')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const result = registerWebhookRoute(workspacePath, {
          source: opts.source,
          event: opts.event,
          trigger: opts.trigger,
          signingSecret: opts.secret,
          apiKey: opts.webhookApiKey,
        });
        workgraph.ledger.append(
          workspacePath,
          opts.actor,
          result.created ? 'create' : 'update',
          `.workgraph/webhook-gateway/routes/${result.route.id}`,
          'webhook-route',
          {
            source: result.route.source,
            event: result.route.event,
            trigger_path: result.route.triggerPath,
          },
        );
        return result;
      },
      (result) => [
        `${result.created ? 'Registered' : 'Updated'} route: ${result.route.id}`,
        `Match: ${result.route.source} + ${result.route.event}`,
        `Trigger: ${result.route.triggerPath}`,
        `Auth: signing_secret=${result.route.hasSigningSecret} api_key=${result.route.hasApiKey}`,
      ],
    ),
  );

  addWorkspaceOption(
    webhookCmd
      .command('list')
      .description('List registered webhook routes')
      .option('--source <source>', 'Filter by webhook source')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const routes = listWebhookRoutes(workspacePath, {
          source: opts.source,
        });
        return {
          routes,
          count: routes.length,
        };
      },
      (result) => {
        if (result.routes.length === 0) return ['No webhook routes registered.'];
        return [
          ...result.routes.map((route) =>
            `${route.id} ${route.source}:${route.event} -> ${route.triggerPath} auth(secret=${route.hasSigningSecret},apiKey=${route.hasApiKey})`,
          ),
          `${result.count} route(s)`,
        ];
      },
    ),
  );

  addWorkspaceOption(
    webhookCmd
      .command('delete <routeId>')
      .description('Delete one webhook route')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--json', 'Emit structured JSON output'),
  ).action((routeId, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const deleted = deleteWebhookRoute(workspacePath, routeId);
        if (!deleted) {
          throw new Error(`Webhook route not found: ${routeId}`);
        }
        workgraph.ledger.append(
          workspacePath,
          opts.actor,
          'delete',
          `.workgraph/webhook-gateway/routes/${deleted.id}`,
          'webhook-route',
          {
            source: deleted.source,
            event: deleted.event,
            trigger_path: deleted.triggerPath,
          },
        );
        return { route: deleted };
      },
      (result) => [
        `Deleted route: ${result.route.id}`,
        `Match: ${result.route.source} + ${result.route.event}`,
      ],
    ),
  );

  addWorkspaceOption(
    webhookCmd
      .command('test <source>')
      .description('Send a signed sample webhook payload')
      .option('--url <url>', 'Webhook server base URL', 'http://127.0.0.1:3100')
      .option('--id <endpointId>', 'Webhook endpoint id', 'test')
      .option('--event <eventType>', 'Event type override (generic source only)')
      .option('--json', 'Emit structured JSON output'),
  ).action((source, opts) =>
    runCommand(
      opts,
      async () => {
        const workspacePath = resolveWorkspacePath(opts);
        const request = createWebhookTestRequest(workspacePath, {
          source,
          endpointId: opts.id,
          eventType: opts.event,
        });
        const endpoint = resolveWebhookEndpointUrl(
          opts.url,
          request.source,
          request.endpointId,
        );
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: request.headers,
          body: request.rawBody,
        });
        const text = await response.text();
        return {
          request: {
            source: request.source,
            endpointId: request.endpointId,
            eventType: request.eventType,
            url: endpoint,
          },
          response: {
            status: response.status,
            ok: response.ok,
            body: safeParseJson(text) ?? text,
          },
        };
      },
      (result) => [
        `Sent webhook test: ${result.request.source}:${result.request.eventType}`,
        `Endpoint: ${result.request.url}`,
        `Response: ${result.response.status} ok=${result.response.ok}`,
        `Body: ${typeof result.response.body === 'string' ? result.response.body : JSON.stringify(result.response.body)}`,
      ],
    ),
  );

  addWorkspaceOption(
    webhookCmd
      .command('log')
      .description('Show webhook ingestion logs from ledger')
      .option('--source <source>', 'Filter by source')
      .option('--since <isoDate>', 'Only include entries on/after ISO-8601 timestamp')
      .option('--limit <n>', 'Maximum entries (default: 20)', '20')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const logs = listWebhookLogs(workspacePath, {
          source: opts.source,
          since: opts.since,
          limit: Number.parseInt(String(opts.limit), 10),
        });
        return {
          logs,
          count: logs.length,
        };
      },
      (result) => {
        if (result.logs.length === 0) return ['No webhook logs found.'];
        return [
          ...result.logs.map((entry) =>
            `${entry.ts} ${entry.source}:${entry.eventType} status=${entry.statusCode} routes=${entry.triggeredRoutes}/${entry.matchedRoutes} delivery=${entry.deliveryId}`,
          ),
          `${result.count} log entr${result.count === 1 ? 'y' : 'ies'}`,
        ];
      },
    ),
  );

  addWorkspaceOption(
    webhookCmd
      .command('serve')
      .description('Run webhook gateway server (includes MCP + REST API)')
      .option('--port <port>', 'HTTP port', '3100')
      .option('--host <host>', 'Bind host', '0.0.0.0')
      .option('--token <token>', 'Optional bearer token for protected /api endpoints')
      .option('-a, --actor <name>', 'Default actor for thread mutations', defaultActor),
  ).action(async (opts) => {
    const workspacePath = resolveWorkspacePath(opts);
    const port = parsePortOption(opts.port);
    const handle = await startWorkgraphServer({
      workspacePath,
      host: String(opts.host),
      port,
      bearerToken: opts.token ? String(opts.token) : undefined,
      defaultActor: String(opts.actor),
    });
    console.log(`Webhook gateway: ${handle.baseUrl}/webhooks/:source/:id`);
    console.log(`Health: ${handle.healthUrl}`);
    console.log(`Status API: ${handle.baseUrl}/api/status`);
    await waitForShutdown(handle, {
      onSignal: (signal) => {
        console.error(`Received ${signal}; shutting down...`);
      },
      onClosed: () => {
        console.error('Webhook gateway stopped.');
      },
    });
  });
}

function resolveWebhookEndpointUrl(baseUrlRaw: string, source: string, endpointId: string): string {
  let baseUrl: URL;
  try {
    baseUrl = new URL(baseUrlRaw);
  } catch {
    throw new Error(`Invalid --url "${baseUrlRaw}". Expected a valid http(s) URL.`);
  }
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    throw new Error(`Invalid --url "${baseUrlRaw}". Expected http(s) URL.`);
  }
  const normalizedPath = baseUrl.pathname.endsWith('/') ? baseUrl.pathname.slice(0, -1) : baseUrl.pathname;
  baseUrl.pathname = `${normalizedPath}/webhooks/${encodeURIComponent(source)}/${encodeURIComponent(endpointId)}`;
  return baseUrl.toString();
}

function safeParseJson(value: string): Record<string, unknown> | null {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
