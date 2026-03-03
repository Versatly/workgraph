import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { auth as kernelAuth } from '@versatly/workgraph-kernel';
import { createWorkgraphMcpServer } from './mcp-server.js';

export interface WorkgraphMcpHttpServerOptions {
  workspacePath: string;
  defaultActor?: string;
  readOnly?: boolean;
  name?: string;
  version?: string;
  host?: string;
  port?: number;
  endpointPath?: string;
  allowedHosts?: string[];
  bearerToken?: string;
  onApp?: (context: WorkgraphMcpHttpServerAppContext) => void;
}

export interface WorkgraphMcpHttpServerHandle {
  host: string;
  port: number;
  endpointPath: string;
  baseUrl: string;
  healthUrl: string;
  url: string;
  close: () => Promise<void>;
}

export type WorkgraphMcpBearerAuthMiddleware = (req: any, res: any, next: () => void) => void;

export interface WorkgraphMcpHttpServerAppContext {
  app: any;
  endpointPath: string;
  workspacePath: string;
  bearerAuthMiddleware: WorkgraphMcpBearerAuthMiddleware;
}

interface SessionBinding {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  authContext: kernelAuth.WorkgraphAuthContext;
}

export async function startWorkgraphMcpHttpServer(
  options: WorkgraphMcpHttpServerOptions,
): Promise<WorkgraphMcpHttpServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const port = normalizePort(options.port, 8787);
  const endpointPath = normalizeEndpointPath(options.endpointPath ?? '/mcp');
  const app = createMcpExpressApp({
    host,
    allowedHosts: options.allowedHosts,
  });
  const sessions: Record<string, SessionBinding> = {};
  const bearerAuthMiddleware = createBearerAuthMiddleware(options.workspacePath, options.bearerToken);

  app.get('/health', (_req: unknown, res: any) => {
    res.json({
      ok: true,
      mode: 'streamable-http',
      endpointPath,
      workspacePath: options.workspacePath,
    });
  });

  app.use(endpointPath, bearerAuthMiddleware);

  options.onApp?.({
    app,
    endpointPath,
    workspacePath: options.workspacePath,
    bearerAuthMiddleware,
  });

  app.post(endpointPath, async (req: any, res: any) => {
    const sessionId = readSessionId(req.headers['mcp-session-id']);
    try {
      const requestAuthContext = buildRequestAuthContext(req, 'mcp');
      let binding: SessionBinding | undefined;
      if (sessionId && sessions[sessionId]) {
        binding = sessions[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        let transport: StreamableHTTPServerTransport;
        const sessionAuthContext = requestAuthContext;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (generatedSessionId) => {
            sessions[generatedSessionId] = {
              transport,
              server: binding!.server,
              authContext: sessionAuthContext,
            };
          },
        });
        const server = createWorkgraphMcpServer({
          workspacePath: options.workspacePath,
          defaultActor: options.defaultActor,
          readOnly: options.readOnly,
          name: options.name,
          version: options.version,
        });
        binding = { transport, server, authContext: sessionAuthContext };
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && sessions[sid]) {
            delete sessions[sid];
          }
        };
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: Missing valid MCP session.',
          },
          id: null,
        });
        return;
      }

      const effectiveContext = requestAuthContext.credentialToken
        ? requestAuthContext
        : binding.authContext;
      await kernelAuth.runWithAuthContext(effectiveContext, async () => {
        await binding!.transport.handleRequest(req, res, req.body);
      });
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
          id: null,
        });
      }
    }
  });

  app.get(endpointPath, async (req: any, res: any) => {
    const sessionId = readSessionId(req.headers['mcp-session-id']);
    if (!sessionId || !sessions[sessionId]) {
      res.status(400).send('Invalid or missing MCP session ID.');
      return;
    }
    const requestAuthContext = buildRequestAuthContext(req, 'mcp');
    const effectiveContext = requestAuthContext.credentialToken
      ? requestAuthContext
      : sessions[sessionId].authContext;
    await kernelAuth.runWithAuthContext(effectiveContext, async () => {
      await sessions[sessionId].transport.handleRequest(req, res);
    });
  });

  app.delete(endpointPath, async (req: any, res: any) => {
    const sessionId = readSessionId(req.headers['mcp-session-id']);
    if (!sessionId || !sessions[sessionId]) {
      res.status(400).send('Invalid or missing MCP session ID.');
      return;
    }
    const requestAuthContext = buildRequestAuthContext(req, 'mcp');
    const effectiveContext = requestAuthContext.credentialToken
      ? requestAuthContext
      : sessions[sessionId].authContext;
    await kernelAuth.runWithAuthContext(effectiveContext, async () => {
      await sessions[sessionId].transport.handleRequest(req, res);
    });
    const binding = sessions[sessionId];
    delete sessions[sessionId];
    await binding.server.close();
  });

  const server = await new Promise<{
    close: (callback: (error?: Error) => void) => void;
    address: () => string | { address: string; family: string; port: number } | null;
  }>((resolve, reject) => {
    const httpServer = app.listen(port, host, () => {
      resolve(httpServer);
    });
    httpServer.on('error', reject);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const resolvedAddress = typeof address === 'object' && address
    ? address.address
    : host;
  const displayHost = formatHostForUrl(resolvedAddress);
  const baseUrl = `http://${displayHost}:${actualPort}`;
  return {
    host,
    port: actualPort,
    endpointPath,
    baseUrl,
    healthUrl: `${baseUrl}/health`,
    url: `${baseUrl}${endpointPath}`,
    close: async () => {
      await Promise.all(
        Object.values(sessions).map(async (binding) => {
          await binding.server.close();
        }),
      );
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function readSessionId(value: unknown): string | undefined {
  if (Array.isArray(value)) return readString(value[0]);
  return readString(value);
}

function normalizeEndpointPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '/mcp';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, raw));
}

function normalizePort(value: number | undefined, fallback: number): number {
  const raw = typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
  if (raw < 0 || raw > 65535) {
    throw new Error(`Invalid port "${raw}". Expected 0..65535.`);
  }
  return raw;
}

function formatHostForUrl(host: string): string {
  if (host.includes(':')) {
    return `[${host}]`;
  }
  return host;
}

function createBearerAuthMiddleware(
  workspacePath: string,
  rawToken: string | undefined,
): WorkgraphMcpBearerAuthMiddleware {
  const authToken = readString(rawToken);
  return (req: any, res: any, next: () => void) => {
    const providedToken = readBearerToken(req.headers.authorization);
    if (!authToken) return next();
    if (!providedToken) {
      res.status(401).json({
        ok: false,
        error: 'Missing bearer token.',
      });
      return;
    }
    if (providedToken === authToken) {
      next();
      return;
    }
    const verified = kernelAuth.verifyAgentCredential(workspacePath, providedToken, {
      touchLastUsed: false,
    });
    if (!verified.valid) {
      res.status(403).json({
        ok: false,
        error: 'Invalid bearer token.',
      });
      return;
    }
    next();
  };
}

function readBearerToken(headerValue: unknown): string | undefined {
  const authorization = readString(headerValue);
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return undefined;
  }
  return readString(authorization.slice('Bearer '.length));
}

function buildRequestAuthContext(
  req: any,
  source: 'mcp' | 'rest',
): kernelAuth.WorkgraphAuthContext {
  const credentialToken = readBearerToken(req?.headers?.authorization);
  return {
    ...(credentialToken ? { credentialToken } : {}),
    source,
  };
}
