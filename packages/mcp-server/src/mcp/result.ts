import { orientation as orientationModule } from '@versatly/workgraph-kernel';

export function okResult(data: unknown, summary: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `${summary}\n\n${toPrettyJson(data)}`,
      },
    ],
    structuredContent: data as Record<string, unknown>,
  };
}

export function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: message,
      },
    ],
  };
}

export type CollaborationToolName =
  | 'wg_post_message'
  | 'wg_ask'
  | 'wg_spawn_thread'
  | 'wg_create_thread'
  | 'wg_thread_context_add'
  | 'wg_thread_context_search'
  | 'wg_thread_context_list'
  | 'wg_thread_context_prune'
  | 'wg_heartbeat';

export interface CollaborationToolError {
  code:
    | 'BAD_INPUT'
    | 'NOT_FOUND'
    | 'POLICY_DENIED'
    | 'READ_ONLY'
    | 'IDEMPOTENCY_CONFLICT'
    | 'TIMEOUT'
    | 'INTERNAL_ERROR';
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface CollaborationToolSuccessEnvelope<TData> {
  ok: true;
  version: '2.0';
  tool: CollaborationToolName;
  actor: string;
  data: TData;
}

export interface CollaborationToolErrorEnvelope {
  ok: false;
  version: '2.0';
  tool: CollaborationToolName;
  error: CollaborationToolError;
}

export class McpToolError extends Error {
  code: CollaborationToolError['code'];
  retryable: boolean;
  details?: Record<string, unknown>;

  constructor(
    code: CollaborationToolError['code'],
    message: string,
    options: {
      retryable?: boolean;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = 'McpToolError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function collaborationOkResult<TData>(
  tool: CollaborationToolName,
  actor: string,
  data: TData,
) {
  const envelope: CollaborationToolSuccessEnvelope<TData> = {
    ok: true,
    version: '2.0',
    tool,
    actor,
    data,
  };
  return {
    content: [
      {
        type: 'text' as const,
        text: toPrettyJson(envelope),
      },
    ],
    structuredContent: envelope as unknown as Record<string, unknown>,
  };
}

export function collaborationErrorResult(tool: CollaborationToolName, error: unknown) {
  const normalized = toCollaborationToolError(error);
  const envelope: CollaborationToolErrorEnvelope = {
    ok: false,
    version: '2.0',
    tool,
    error: normalized,
  };
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: `[${normalized.code}] ${normalized.message}`,
      },
    ],
    structuredContent: envelope as unknown as Record<string, unknown>,
  };
}

export function toPrettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function renderStatusSummary(snapshot: ReturnType<typeof orientationModule.statusSnapshot>): string {
  return [
    `threads(total=${snapshot.threads.total}, open=${snapshot.threads.open}, active=${snapshot.threads.active}, blocked=${snapshot.threads.blocked}, done=${snapshot.threads.done})`,
    `claims(active=${snapshot.claims.active})`,
    `primitives(total=${snapshot.primitives.total})`,
  ].join(' ');
}

function toCollaborationToolError(error: unknown): CollaborationToolError {
  if (error instanceof McpToolError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('configured read-only')) {
    return { code: 'READ_ONLY', message, retryable: false };
  }
  if (message.toLowerCase().includes('idempotency')) {
    return { code: 'IDEMPOTENCY_CONFLICT', message, retryable: false };
  }
  if (message.toLowerCase().includes('timed out')) {
    return { code: 'TIMEOUT', message, retryable: true };
  }
  if (message.includes('Policy gate blocked') || message.includes('Identity verification failed')) {
    return { code: 'POLICY_DENIED', message, retryable: false };
  }
  if (message.includes('not found')) {
    return { code: 'NOT_FOUND', message, retryable: false };
  }
  if (
    message.includes('Invalid') ||
    message.includes('Cannot') ||
    message.includes('Missing') ||
    message.includes('Expected')
  ) {
    return { code: 'BAD_INPUT', message, retryable: false };
  }
  return {
    code: 'INTERNAL_ERROR',
    message,
    retryable: false,
  };
}
