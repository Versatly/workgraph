import { createHash, randomUUID } from 'node:crypto';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  agent as agentModule,
  conversation as conversationModule,
  store as storeModule,
  thread as threadModule,
} from '@versatly/workgraph-kernel';
import { checkWriteGate, resolveActor } from '../auth.js';
import {
  collaborationErrorResult,
  collaborationOkResult,
  McpToolError,
  type CollaborationToolName,
} from '../result.js';
import { type WorkgraphMcpServerOptions } from '../types.js';

const agent = agentModule;
const conversation = conversationModule;
const store = storeModule;
const thread = threadModule;

const MESSAGE_TYPES = ['message', 'note', 'decision', 'system', 'ask', 'reply'] as const;
const PRESENCE_STATUSES = ['online', 'busy', 'offline'] as const;

const evidenceAttachmentSchema = z.object({
  kind: z.enum(['link', 'file']).describe('Evidence attachment kind.'),
  url: z.string().optional().describe('Evidence URL for link-based artifacts.'),
  path: z.string().optional().describe('Workspace-relative file path for file evidence.'),
  title: z.string().optional().describe('Short human-readable evidence title.'),
  mime_type: z.string().optional().describe('MIME type for this attachment when known.'),
  size_bytes: z.number().int().min(0).optional().describe('Attachment size in bytes.'),
  sha256: z.string().optional().describe('Optional sha256 digest for file integrity checks.'),
}).refine(
  (value) => {
    const hasUrl = typeof value.url === 'string' && value.url.trim().length > 0;
    const hasPath = typeof value.path === 'string' && value.path.trim().length > 0;
    if (value.kind === 'link') return hasUrl;
    if (value.kind === 'file') return hasPath;
    return false;
  },
  {
    message: 'Evidence item must provide url for link kind or path for file kind.',
  },
);

const metadataSchema = z
  .record(z.string(), z.unknown())
  .describe('Arbitrary machine-readable metadata preserved with the event.');

export function registerCollaborationTools(server: McpServer, options: WorkgraphMcpServerOptions): void {
  server.registerTool(
    'wg_post_message',
    {
      title: 'WorkGraph Post Message',
      description: 'Append a structured collaboration message event to a thread conversation.',
      inputSchema: {
        threadPath: z.string().min(1).describe('Target thread path (threads/<slug>.md).'),
        actor: z.string().optional().describe('Actor identity for write attribution.'),
        conversationPath: z.string().optional().describe('Optional existing conversation path.'),
        body: z.string().min(1).describe('Message body text to append.'),
        messageType: z.enum(MESSAGE_TYPES).optional().describe('Conversation event type/kind.'),
        correlationId: z.string().optional().describe('Correlation ID for ask/reply coordination.'),
        replyToCorrelationId: z.string().optional().describe('Correlation ID this reply responds to.'),
        idempotencyKey: z.string().optional().describe('Stable idempotency key for retry-safe writes.'),
        evidence: z.array(evidenceAttachmentSchema).optional().describe('Optional evidence attachment descriptors.'),
        metadata: metadataSchema.optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        assertWriteAllowed(options, actor, ['thread:update', 'mcp:write'], {
          action: 'mcp.collaboration.post-message',
          target: normalizeThreadPath(args.threadPath),
        });
        const threadPath = assertThreadExists(options.workspacePath, args.threadPath);
        const conversationPath = resolveConversationPath(options.workspacePath, actor, threadPath, args.conversationPath);
        const idempotencyKey = normalizeOptionalString(args.idempotencyKey);
        const messageType = args.messageType ?? 'message';
        const correlationId = normalizeOptionalString(args.correlationId);
        const replyToCorrelationId = normalizeOptionalString(args.replyToCorrelationId);
        if (messageType === 'reply' && !replyToCorrelationId) {
          throw new McpToolError('BAD_INPUT', 'Reply message requires replyToCorrelationId.');
        }
        if (messageType === 'ask' && !correlationId) {
          throw new McpToolError('BAD_INPUT', 'Ask message requires correlationId.');
        }
        const existing = idempotencyKey
          ? findEventByIdempotencyKey(options.workspacePath, conversationPath, idempotencyKey)
          : null;
        if (existing) {
          assertPostReplayCompatible(existing, {
            threadPath,
            body: args.body,
            messageType,
            correlationId,
            replyToCorrelationId,
            evidence: args.evidence,
            metadata: args.metadata,
          });
          return collaborationOkResult('wg_post_message', actor, {
            operation: 'replayed',
            thread_path: threadPath,
            conversation_path: conversationPath,
            idempotency: {
              key: idempotencyKey,
              replayed: true,
            },
            event: serializeEvent(existing),
          });
        }
        const eventId = mintEventId('msg', {
          threadPath,
          actor,
          messageType,
          correlationId,
          idempotencyKey,
          message: args.body,
        });
        const appended = conversation.appendConversationMessage(
          options.workspacePath,
          conversationPath,
          actor,
          args.body,
          {
            kind: messageType,
            eventType: messageType,
            eventId,
            threadRef: threadPath,
            correlationId,
            replyTo: replyToCorrelationId,
            idempotencyKey,
            evidence: args.evidence,
            metadata: args.metadata,
          },
        );
        const appendedEvent = findEventById(options.workspacePath, appended.conversation.path, eventId)
          ?? lastConversationEvent(options.workspacePath, appended.conversation.path);
        if (!appendedEvent) {
          throw new McpToolError('INTERNAL_ERROR', 'Post-message completed without a persisted conversation event.');
        }
        return collaborationOkResult('wg_post_message', actor, {
          operation: 'created',
          thread_path: threadPath,
          conversation_path: appended.conversation.path,
          idempotency: {
            key: idempotencyKey,
            replayed: false,
          },
          event: serializeEvent(appendedEvent),
        });
      } catch (error) {
        return collaborationErrorResult('wg_post_message', error);
      }
    },
  );

  server.registerTool(
    'wg_ask',
    {
      title: 'WorkGraph Ask',
      description: 'Post a correlated question and optionally await/poll for a reply.',
      inputSchema: {
        threadPath: z.string().min(1).describe('Target thread path (threads/<slug>.md).'),
        actor: z.string().optional().describe('Actor identity for write attribution.'),
        conversationPath: z.string().optional().describe('Optional existing conversation path.'),
        question: z.string().min(1).describe('Question text to post.'),
        correlationId: z.string().optional().describe('Optional correlation ID (generated when omitted).'),
        idempotencyKey: z.string().optional().describe('Stable idempotency key for retry-safe asks.'),
        evidence: z.array(evidenceAttachmentSchema).optional().describe('Optional evidence attachments for ask context.'),
        metadata: metadataSchema.optional(),
        awaitReply: z.boolean().optional().describe('Whether the tool should wait for a matching reply event.'),
        timeoutMs: z.number().int().min(0).max(120_000).optional().describe('Reply wait timeout when awaitReply=true.'),
        pollIntervalMs: z.number().int().min(25).max(5_000).optional().describe('Polling interval used while awaiting reply.'),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        assertWriteAllowed(options, actor, ['thread:update', 'mcp:write'], {
          action: 'mcp.collaboration.ask',
          target: normalizeThreadPath(args.threadPath),
        });
        const threadPath = assertThreadExists(options.workspacePath, args.threadPath);
        const conversationPath = resolveConversationPath(options.workspacePath, actor, threadPath, args.conversationPath);
        const idempotencyKey = normalizeOptionalString(args.idempotencyKey);
        const initialCorrelation = normalizeOptionalString(args.correlationId)
          ?? (idempotencyKey ? correlationIdFromIdempotency(idempotencyKey) : undefined)
          ?? correlationIdFromQuestion(threadPath, args.question);
        const postResult = ensureAskEvent(options.workspacePath, {
          actor,
          threadPath,
          conversationPath,
          question: args.question,
          idempotencyKey,
          correlationId: initialCorrelation,
          evidence: args.evidence,
          metadata: args.metadata,
        });
        const correlationId = postResult.correlationId;
        const shouldAwaitReply = args.awaitReply === true;
        const timeoutMs = args.timeoutMs ?? 30_000;
        const pollIntervalMs = args.pollIntervalMs ?? 250;
        const startedAt = Date.now();
        let replyEvent = findLatestReplyEvent(options.workspacePath, conversationPath, correlationId);
        while (!replyEvent && shouldAwaitReply && Date.now() - startedAt < timeoutMs) {
          await sleep(pollIntervalMs);
          replyEvent = findLatestReplyEvent(options.workspacePath, conversationPath, correlationId);
        }
        const waitedMs = Date.now() - startedAt;
        return collaborationOkResult('wg_ask', actor, {
          operation: postResult.replayed ? 'replayed' : 'created',
          status: replyEvent ? 'answered' : 'pending',
          timed_out: shouldAwaitReply && !replyEvent && waitedMs >= timeoutMs,
          waited_ms: waitedMs,
          thread_path: threadPath,
          conversation_path: conversationPath,
          correlation_id: correlationId,
          idempotency: {
            key: idempotencyKey,
            replayed: postResult.replayed,
          },
          ask: serializeEvent(postResult.askEvent),
          reply: replyEvent ? serializeEvent(replyEvent) : null,
        });
      } catch (error) {
        return collaborationErrorResult('wg_ask', error);
      }
    },
  );

  server.registerTool(
    'wg_spawn_thread',
    {
      title: 'WorkGraph Spawn Thread',
      description: 'Create a child thread with inherited context and optional idempotency key.',
      inputSchema: {
        parentThreadPath: z.string().min(1).describe('Parent thread path for child spawn operation.'),
        actor: z.string().optional().describe('Actor identity for write attribution.'),
        title: z.string().min(1).describe('New child thread title.'),
        goal: z.string().min(1).describe('New child thread goal/body seed.'),
        priority: z.string().optional().describe('Optional child priority override.'),
        deps: z.array(z.string()).optional().describe('Optional dependency thread refs.'),
        tags: z.array(z.string()).optional().describe('Optional child tags.'),
        contextRefs: z.array(z.string()).optional().describe('Additional context refs inherited by child thread.'),
        space: z.string().optional().describe('Optional space override for the spawned child thread.'),
        conversationPath: z.string().optional().describe('Optional conversation to attach spawned child thread.'),
        idempotencyKey: z.string().optional().describe('Stable idempotency key for retry-safe spawn.'),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        assertWriteAllowed(options, actor, ['thread:create', 'mcp:write'], {
          action: 'mcp.collaboration.spawn-thread',
          target: normalizeThreadPath(args.parentThreadPath),
        });
        const parentThreadPath = assertThreadExists(options.workspacePath, args.parentThreadPath);
        const parentThread = store.read(options.workspacePath, parentThreadPath)!;
        const idempotencyKey = normalizeOptionalString(args.idempotencyKey);
        if (idempotencyKey) {
          const existing = findSpawnedThreadByKey(options.workspacePath, parentThreadPath, idempotencyKey);
          if (existing) {
            assertSpawnReplayCompatible(existing, args.title, args.goal);
            return collaborationOkResult('wg_spawn_thread', actor, {
              operation: 'replayed',
              parent_thread_path: parentThreadPath,
              idempotency: {
                key: idempotencyKey,
                replayed: true,
              },
              thread: serializeThread(existing),
            });
          }
        }
        const inheritedContextRefs = dedupeStrings([
          ...asStringArray(parentThread.fields.context_refs),
          parentThreadPath,
          ...(args.contextRefs ?? []),
        ]);
        const created = thread.createThread(options.workspacePath, args.title, args.goal, actor, {
          parent: parentThreadPath,
          priority: args.priority,
          deps: args.deps,
          space: normalizeOptionalString(args.space) ?? normalizeOptionalString(parentThread.fields.space),
          context_refs: inheritedContextRefs,
          tags: args.tags,
        });
        const withMetadata = store.update(
          options.workspacePath,
          created.path,
          {
            mcp_spawn_parent: parentThreadPath,
            mcp_spawned_by: actor,
            mcp_spawned_at: new Date().toISOString(),
            ...(idempotencyKey ? { mcp_spawn_idempotency_key: idempotencyKey } : {}),
          },
          undefined,
          actor,
          {
            skipAuthorization: true,
            action: 'mcp.collaboration.spawn.store',
            requiredCapabilities: ['thread:create', 'thread:manage'],
          },
        );
        if (args.conversationPath) {
          conversation.attachConversationThread(
            options.workspacePath,
            args.conversationPath,
            withMetadata.path,
            actor,
          );
        }
        return collaborationOkResult('wg_spawn_thread', actor, {
          operation: 'created',
          parent_thread_path: parentThreadPath,
          idempotency: {
            key: idempotencyKey,
            replayed: false,
          },
          thread: serializeThread(withMetadata),
        });
      } catch (error) {
        return collaborationErrorResult('wg_spawn_thread', error);
      }
    },
  );

  server.registerTool(
    'wg_heartbeat',
    {
      title: 'WorkGraph Heartbeat',
      description: 'Write agent liveness plus active-work claim heartbeat updates.',
      inputSchema: {
        actor: z.string().optional().describe('Actor identity to heartbeat.'),
        threadPath: z.string().optional().describe('Optional specific thread to heartbeat claim lease for.'),
        threadLeaseMinutes: z.number().int().min(1).max(240).optional().describe('Thread lease extension window in minutes.'),
        status: z.enum(PRESENCE_STATUSES).optional().describe('Presence status update for actor liveness.'),
        currentWork: z.string().optional().describe('Current work/thread marker for presence state.'),
        capabilities: z.array(z.string()).optional().describe('Optional runtime capabilities snapshot for presence.'),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        assertWriteAllowed(options, actor, ['agent:heartbeat', 'thread:update', 'mcp:write'], {
          action: 'mcp.collaboration.heartbeat',
          target: normalizeOptionalString(args.threadPath) ?? 'threads',
        });
        const threadPath = args.threadPath
          ? assertThreadExists(options.workspacePath, args.threadPath)
          : undefined;
        const presence = agent.heartbeat(options.workspacePath, actor, {
          status: args.status,
          currentTask: normalizeOptionalString(args.currentWork) ?? threadPath,
          capabilities: args.capabilities,
          actor,
        });
        const threadHeartbeat = thread.heartbeatClaim(options.workspacePath, actor, threadPath, {
          ttlMinutes: args.threadLeaseMinutes,
        });
        return collaborationOkResult('wg_heartbeat', actor, {
          operation: 'updated',
          actor,
          thread_path: threadPath ?? null,
          presence: {
            path: presence.path,
            status: String(presence.fields.status ?? 'unknown'),
            current_task: normalizeOptionalString(presence.fields.current_task) ?? null,
            last_seen: normalizeOptionalString(presence.fields.last_seen) ?? null,
          },
          threads: threadHeartbeat,
        });
      } catch (error) {
        return collaborationErrorResult('wg_heartbeat', error);
      }
    },
  );
}

function ensureAskEvent(
  workspacePath: string,
  input: {
    actor: string;
    threadPath: string;
    conversationPath: string;
    question: string;
    idempotencyKey?: string;
    correlationId: string;
    evidence?: Array<z.infer<typeof evidenceAttachmentSchema>>;
    metadata?: Record<string, unknown>;
  },
): {
  replayed: boolean;
  correlationId: string;
  askEvent: conversationModule.ConversationEventRecord;
} {
  const events = conversation.listConversationEvents(workspacePath, input.conversationPath);
  const fromKey = input.idempotencyKey
    ? events.find((event) => event.idempotency_key === input.idempotencyKey && event.event_type === 'ask')
    : undefined;
  if (fromKey) {
    assertAskReplayCompatible(fromKey, input.threadPath, input.question, input.correlationId);
    return {
      replayed: true,
      correlationId: fromKey.correlation_id ?? input.correlationId,
      askEvent: fromKey,
    };
  }
  const fromCorrelation = events.find((event) => event.event_type === 'ask' && event.correlation_id === input.correlationId);
  if (fromCorrelation) {
    assertAskReplayCompatible(fromCorrelation, input.threadPath, input.question, input.correlationId);
    return {
      replayed: true,
      correlationId: input.correlationId,
      askEvent: fromCorrelation,
    };
  }
  const eventId = mintEventId('ask', {
    threadPath: input.threadPath,
    actor: input.actor,
    messageType: 'ask',
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    message: input.question,
  });
  const appended = conversation.appendConversationMessage(
    workspacePath,
    input.conversationPath,
    input.actor,
    input.question,
    {
      kind: 'ask',
      eventType: 'ask',
      eventId,
      threadRef: input.threadPath,
      correlationId: input.correlationId,
      idempotencyKey: input.idempotencyKey,
      evidence: input.evidence,
      metadata: input.metadata,
    },
  );
  const askEvent = findEventById(workspacePath, appended.conversation.path, eventId)
    ?? lastConversationEvent(workspacePath, appended.conversation.path);
  if (!askEvent) {
    throw new McpToolError('INTERNAL_ERROR', 'Ask event was not found after write completion.');
  }
  return {
    replayed: false,
    correlationId: input.correlationId,
    askEvent,
  };
}

function findLatestReplyEvent(
  workspacePath: string,
  conversationPath: string,
  correlationId: string,
): conversationModule.ConversationEventRecord | null {
  const matches = conversation
    .listConversationEvents(workspacePath, conversationPath)
    .filter((event) => event.event_type === 'reply' && (
      event.reply_to === correlationId || event.correlation_id === correlationId
    ));
  if (matches.length === 0) return null;
  return matches.sort((left, right) => left.ts.localeCompare(right.ts)).at(-1) ?? null;
}

function assertWriteAllowed(
  options: WorkgraphMcpServerOptions,
  actor: string,
  capabilities: string[],
  context: { action: string; target: string },
): void {
  const gate = checkWriteGate(options, actor, capabilities, {
    action: context.action,
    target: context.target,
  });
  if (gate.allowed) return;
  const reason = gate.reason ?? 'Policy gate blocked MCP write.';
  if (reason.includes('read-only')) {
    throw new McpToolError('READ_ONLY', reason);
  }
  throw new McpToolError('POLICY_DENIED', reason);
}

function assertThreadExists(workspacePath: string, rawThreadPath: string): string {
  const threadPath = normalizeThreadPath(rawThreadPath);
  const resolved = store.read(workspacePath, threadPath);
  if (!resolved || resolved.type !== 'thread') {
    throw new McpToolError('NOT_FOUND', `Thread not found: ${threadPath}`);
  }
  return threadPath;
}

function resolveConversationPath(
  workspacePath: string,
  actor: string,
  threadPath: string,
  explicitPath?: string,
): string {
  if (explicitPath) {
    const selected = conversation.getConversation(workspacePath, explicitPath);
    if (!selected.summary.threadRefs.includes(threadPath)) {
      return conversation.attachConversationThread(workspacePath, explicitPath, threadPath, actor).conversation.path;
    }
    return selected.conversation.path;
  }
  const candidates = conversation.listConversations(workspacePath, { threadRef: threadPath });
  if (candidates.length > 0) {
    const latest = [...candidates].sort((left, right) => {
      const leftUpdated = normalizeOptionalString(left.conversation.fields.updated) ?? '';
      const rightUpdated = normalizeOptionalString(right.conversation.fields.updated) ?? '';
      return rightUpdated.localeCompare(leftUpdated);
    })[0];
    return latest.conversation.path;
  }
  const threadInstance = store.read(workspacePath, threadPath);
  const title = normalizeOptionalString(threadInstance?.fields.title) ?? threadPath;
  const created = conversation.createConversation(
    workspacePath,
    `Coordination: ${title}`,
    actor,
    {
      status: 'active',
      threadRefs: [threadPath],
      owner: actor,
    },
  );
  return created.conversation.path;
}

function findEventById(
  workspacePath: string,
  conversationPath: string,
  eventId: string,
): conversationModule.ConversationEventRecord | null {
  return conversation
    .listConversationEvents(workspacePath, conversationPath)
    .find((event) => event.id === eventId) ?? null;
}

function lastConversationEvent(
  workspacePath: string,
  conversationPath: string,
): conversationModule.ConversationEventRecord | null {
  const events = conversation.listConversationEvents(workspacePath, conversationPath);
  return events.length > 0 ? events[events.length - 1] : null;
}

function findEventByIdempotencyKey(
  workspacePath: string,
  conversationPath: string,
  idempotencyKey: string,
): conversationModule.ConversationEventRecord | null {
  return conversation
    .listConversationEvents(workspacePath, conversationPath)
    .find((event) => event.idempotency_key === idempotencyKey) ?? null;
}

function findSpawnedThreadByKey(
  workspacePath: string,
  parentThreadPath: string,
  idempotencyKey: string,
) {
  return store.list(workspacePath, 'thread').find((entry) =>
    normalizeOptionalString(entry.fields.parent) === parentThreadPath &&
    normalizeOptionalString(entry.fields.mcp_spawn_idempotency_key) === idempotencyKey
  ) ?? null;
}

function assertPostReplayCompatible(
  existing: conversationModule.ConversationEventRecord,
  input: {
    threadPath: string;
    body: string;
    messageType: string;
    correlationId?: string;
    replyToCorrelationId?: string;
    evidence?: Array<z.infer<typeof evidenceAttachmentSchema>>;
    metadata?: Record<string, unknown>;
  },
): void {
  const expectedEvidence = stableStringify(input.evidence ?? []);
  const actualEvidence = stableStringify(existing.evidence ?? []);
  const expectedMetadata = stableStringify(input.metadata ?? {});
  const actualMetadata = stableStringify(existing.metadata ?? {});
  if (
    existing.message !== input.body ||
    (existing.event_type ?? existing.kind) !== input.messageType ||
    normalizeOptionalString(existing.thread_ref) !== input.threadPath ||
    normalizeOptionalString(existing.correlation_id) !== input.correlationId ||
    normalizeOptionalString(existing.reply_to) !== input.replyToCorrelationId ||
    expectedEvidence !== actualEvidence ||
    expectedMetadata !== actualMetadata
  ) {
    throw new McpToolError(
      'IDEMPOTENCY_CONFLICT',
      `Idempotency key "${existing.idempotency_key}" was previously used with a different message payload.`,
      {
        details: {
          previous_event_id: existing.id ?? null,
        },
      },
    );
  }
}

function assertAskReplayCompatible(
  existing: conversationModule.ConversationEventRecord,
  threadPath: string,
  question: string,
  correlationId: string,
): void {
  if (
    existing.message !== question ||
    normalizeOptionalString(existing.thread_ref) !== threadPath ||
    normalizeOptionalString(existing.correlation_id) !== correlationId
  ) {
    throw new McpToolError(
      'IDEMPOTENCY_CONFLICT',
      `Idempotent ask replay conflict for correlation "${correlationId}".`,
      {
        details: {
          previous_event_id: existing.id ?? null,
        },
      },
    );
  }
}

function assertSpawnReplayCompatible(existing: { fields: Record<string, unknown> }, title: string, goal: string): void {
  const existingTitle = normalizeOptionalString(existing.fields.title);
  const existingGoal = normalizeOptionalString(existing.fields.goal);
  if (existingTitle !== title || existingGoal !== goal) {
    throw new McpToolError(
      'IDEMPOTENCY_CONFLICT',
      'Spawn idempotency key was reused with different child-thread payload.',
      {
        details: {
          previous_title: existingTitle ?? null,
          previous_goal: existingGoal ?? null,
        },
      },
    );
  }
}

function serializeEvent(event: conversationModule.ConversationEventRecord) {
  return {
    id: event.id ?? null,
    ts: event.ts,
    actor: event.actor,
    kind: event.kind,
    event_type: event.event_type ?? event.kind,
    message: event.message,
    thread_ref: event.thread_ref ?? null,
    correlation_id: event.correlation_id ?? null,
    reply_to: event.reply_to ?? null,
    idempotency_key: event.idempotency_key ?? null,
    evidence: event.evidence ?? [],
    metadata: event.metadata ?? {},
  };
}

function serializeThread(entry: { path: string; fields: Record<string, unknown> }) {
  return {
    path: entry.path,
    title: normalizeOptionalString(entry.fields.title) ?? entry.path,
    goal: normalizeOptionalString(entry.fields.goal) ?? '',
    status: normalizeOptionalString(entry.fields.status) ?? 'unknown',
    owner: normalizeOptionalString(entry.fields.owner) ?? null,
    parent: normalizeOptionalString(entry.fields.parent) ?? null,
    space: normalizeOptionalString(entry.fields.space) ?? null,
    context_refs: asStringArray(entry.fields.context_refs),
    deps: asStringArray(entry.fields.deps),
    tags: asStringArray(entry.fields.tags),
    updated: normalizeOptionalString(entry.fields.updated) ?? null,
  };
}

function normalizeThreadPath(value: string): string {
  const trimmed = String(value ?? '').trim().replace(/^\.\//, '').replace(/\\/g, '/');
  if (!trimmed) {
    throw new McpToolError('BAD_INPUT', 'Thread path is required.');
  }
  const withPrefix = trimmed.includes('/') ? trimmed : `threads/${trimmed}`;
  const withExtension = withPrefix.endsWith('.md') ? withPrefix : `${withPrefix}.md`;
  return withExtension;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeOptionalString(item))
    .filter((item): item is string => !!item);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function mintEventId(
  prefix: 'msg' | 'ask',
  seed: {
    threadPath: string;
    actor: string;
    messageType: string;
    correlationId?: string;
    idempotencyKey?: string;
    message: string;
  },
): string {
  const raw = stableStringify({
    prefix,
    ...seed,
    nonce: randomUUID(),
  });
  return `${prefix}_${createHash('sha1').update(raw).digest('hex').slice(0, 16)}`;
}

function correlationIdFromIdempotency(idempotencyKey: string): string {
  return `corr_${createHash('sha1').update(idempotencyKey).digest('hex').slice(0, 12)}`;
}

function correlationIdFromQuestion(threadPath: string, question: string): string {
  const raw = `${threadPath}|${question}|${new Date().toISOString()}|${randomUUID()}`;
  return `corr_${createHash('sha1').update(raw).digest('hex').slice(0, 12)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
