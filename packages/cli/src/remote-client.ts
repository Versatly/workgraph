import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface WorkgraphRemoteClientOptions {
  apiUrl: string;
  apiKey?: string;
  name?: string;
  version?: string;
}

interface McpTextContent {
  type: string;
  text?: string;
}

interface McpToolResultEnvelope {
  isError?: boolean;
  structuredContent?: unknown;
  content?: McpTextContent[];
}

export class WorkgraphRemoteClient {
  private readonly client: Client;

  private closed = false;

  private constructor(
    client: Client,
  ) {
    this.client = client;
  }

  static async connect(options: WorkgraphRemoteClientOptions): Promise<WorkgraphRemoteClient> {
    const headers: Record<string, string> = {};
    const apiKey = readNonEmptyString(options.apiKey);
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }

    const client = new Client({
      name: options.name ?? 'workgraph-cli-remote',
      version: options.version ?? '1.0.0',
    });
    const transport = new StreamableHTTPClientTransport(new URL(options.apiUrl), {
      requestInit: {
        headers,
      },
    });
    await client.connect(transport);
    return new WorkgraphRemoteClient(client);
  }

  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    const result = await this.client.listTools();
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    }));
  }

  async callTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const raw = await this.client.callTool({
      name,
      arguments: args,
    }) as unknown;
    return parseToolResult<T>(raw, name);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.close();
  }
}

function parseToolResult<T>(raw: unknown, toolName: string): T {
  const envelope = raw as McpToolResultEnvelope | undefined;
  if (!envelope || typeof envelope !== 'object') {
    throw new Error(`MCP tool "${toolName}" returned an invalid response.`);
  }
  if (envelope.isError) {
    const text = extractText(envelope.content);
    throw new Error(text || `MCP tool "${toolName}" returned an error.`);
  }
  if (envelope.structuredContent !== undefined) {
    return envelope.structuredContent as T;
  }
  const text = extractText(envelope.content);
  if (text) {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(text);
    }
  }
  throw new Error(`MCP tool "${toolName}" returned no structured content.`);
}

function extractText(content: McpTextContent[] | undefined): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const textChunk = content.find((entry) => entry.type === 'text' && typeof entry.text === 'string');
  return readNonEmptyString(textChunk?.text);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
