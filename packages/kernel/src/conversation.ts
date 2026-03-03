/**
 * Conversation + plan-step coordination primitives.
 */

import * as store from './store.js';
import type {
  ConversationStateSummary,
  ConversationStatus,
  PlanStepStatus,
  PrimitiveInstance,
} from './types.js';
import {
  CONVERSATION_STATUS_TRANSITIONS,
  PLAN_STEP_STATUS_TRANSITIONS,
} from './types.js';

export type ConversationEventKind = 'message' | 'note' | 'decision' | 'system';

export interface ConversationEventRecord {
  ts: string;
  actor: string;
  kind: ConversationEventKind;
  message: string;
  thread_ref?: string;
}

export interface CreateConversationOptions {
  threadRefs?: string[];
  status?: ConversationStatus;
  tags?: string[];
  owner?: string;
}

export interface AppendConversationMessageOptions {
  kind?: ConversationEventKind;
  threadRef?: string;
}

export interface CreatePlanStepOptions {
  conversationRef: string;
  threadRef?: string;
  assignee?: string;
  order?: number;
  tags?: string[];
  status?: PlanStepStatus;
  body?: string;
}

export interface ListPlanStepsOptions {
  conversationRef?: string;
  threadRef?: string;
  status?: PlanStepStatus;
}

export interface TransitionPlanStepOptions {
  reason?: string;
}

export interface ConversationWithState {
  conversation: PrimitiveInstance;
  summary: ConversationStateSummary;
}

export function createConversation(
  workspacePath: string,
  title: string,
  actor: string,
  options: CreateConversationOptions = {},
): ConversationWithState {
  const threadRefs = uniqueRefs((options.threadRefs ?? []).map(normalizeThreadRef));
  for (const threadRef of threadRefs) {
    assertThreadExists(workspacePath, threadRef);
  }
  const status = options.status ?? 'open';
  const created = store.create(
    workspacePath,
    'conversation',
    {
      title,
      status,
      owner: options.owner ?? actor,
      thread_refs: threadRefs,
      plan_step_refs: [],
      progress: 0,
      message_count: 0,
      events: [],
      step_total: 0,
      step_open: 0,
      step_active: 0,
      step_blocked: 0,
      step_done: 0,
      step_cancelled: 0,
      tags: options.tags ?? [],
    },
    renderConversationBody({
      title,
      status,
      threadRefs,
      planStepRefs: [],
      events: [],
      summary: null,
    }),
    actor,
  );
  const conversation = syncConversationState(workspacePath, created.path, actor);
  const summary = summarizeConversationState(workspacePath, conversation.path);
  return { conversation, summary };
}

export function listConversations(
  workspacePath: string,
  options: { status?: ConversationStatus; threadRef?: string } = {},
): ConversationWithState[] {
  const normalizedThread = options.threadRef ? normalizeThreadRef(options.threadRef) : undefined;
  const conversations = store.list(workspacePath, 'conversation')
    .filter((conversation) => {
      if (options.status && normalizeConversationStatus(conversation.fields.status) !== options.status) return false;
      if (!normalizedThread) return true;
      const refs = coerceStringArray(conversation.fields.thread_refs).map(normalizeThreadRef);
      return refs.includes(normalizedThread);
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  return conversations.map((conversation) => ({
    conversation,
    summary: summarizeConversationState(workspacePath, conversation.path),
  }));
}

export function getConversation(workspacePath: string, conversationRef: string): ConversationWithState {
  const conversation = readConversationOrThrow(workspacePath, conversationRef);
  return {
    conversation,
    summary: summarizeConversationState(workspacePath, conversation.path),
  };
}

export function appendConversationMessage(
  workspacePath: string,
  conversationRef: string,
  actor: string,
  message: string,
  options: AppendConversationMessageOptions = {},
): ConversationWithState {
  const conversation = readConversationOrThrow(workspacePath, conversationRef);
  const trimmedMessage = String(message ?? '').trim();
  if (!trimmedMessage) {
    throw new Error('Conversation message text cannot be empty.');
  }
  const event: ConversationEventRecord = {
    ts: new Date().toISOString(),
    actor,
    kind: options.kind ?? 'message',
    message: trimmedMessage,
    ...(options.threadRef ? { thread_ref: normalizeThreadRef(options.threadRef) } : {}),
  };
  if (event.thread_ref) {
    assertThreadExists(workspacePath, event.thread_ref);
  }
  const events = [...coerceEventRecords(conversation.fields.events), event];
  const updated = store.update(
    workspacePath,
    conversation.path,
    {
      events,
      message_count: events.length,
      last_message_at: event.ts,
    },
    renderConversationBody({
      title: String(conversation.fields.title ?? conversation.path),
      status: normalizeConversationStatus(conversation.fields.status),
      threadRefs: coerceStringArray(conversation.fields.thread_refs).map(normalizeThreadRef),
      planStepRefs: coerceStringArray(conversation.fields.plan_step_refs).map(normalizePlanStepRef),
      events,
      summary: null,
    }),
    actor,
  );
  const synced = syncConversationState(workspacePath, updated.path, actor);
  return {
    conversation: synced,
    summary: summarizeConversationState(workspacePath, synced.path),
  };
}

export function attachConversationThread(
  workspacePath: string,
  conversationRef: string,
  threadRef: string,
  actor: string,
): ConversationWithState {
  const conversation = readConversationOrThrow(workspacePath, conversationRef);
  const normalizedThread = normalizeThreadRef(threadRef);
  assertThreadExists(workspacePath, normalizedThread);
  const nextRefs = uniqueRefs([
    ...coerceStringArray(conversation.fields.thread_refs).map(normalizeThreadRef),
    normalizedThread,
  ]);
  const updated = store.update(
    workspacePath,
    conversation.path,
    { thread_refs: nextRefs },
    renderConversationBody({
      title: String(conversation.fields.title ?? conversation.path),
      status: normalizeConversationStatus(conversation.fields.status),
      threadRefs: nextRefs,
      planStepRefs: coerceStringArray(conversation.fields.plan_step_refs).map(normalizePlanStepRef),
      events: coerceEventRecords(conversation.fields.events),
      summary: null,
    }),
    actor,
  );
  const synced = syncConversationState(workspacePath, updated.path, actor);
  return {
    conversation: synced,
    summary: summarizeConversationState(workspacePath, synced.path),
  };
}

export function detachConversationThread(
  workspacePath: string,
  conversationRef: string,
  threadRef: string,
  actor: string,
): ConversationWithState {
  const conversation = readConversationOrThrow(workspacePath, conversationRef);
  const normalizedThread = normalizeThreadRef(threadRef);
  const existingRefs = coerceStringArray(conversation.fields.thread_refs).map(normalizeThreadRef);
  if (!existingRefs.includes(normalizedThread)) {
    throw new Error(`Conversation "${conversation.path}" is not attached to thread "${normalizedThread}".`);
  }
  const nextRefs = existingRefs.filter((ref) => ref !== normalizedThread);
  const updated = store.update(
    workspacePath,
    conversation.path,
    { thread_refs: nextRefs },
    renderConversationBody({
      title: String(conversation.fields.title ?? conversation.path),
      status: normalizeConversationStatus(conversation.fields.status),
      threadRefs: nextRefs,
      planStepRefs: coerceStringArray(conversation.fields.plan_step_refs).map(normalizePlanStepRef),
      events: coerceEventRecords(conversation.fields.events),
      summary: null,
    }),
    actor,
  );
  const synced = syncConversationState(workspacePath, updated.path, actor);
  return {
    conversation: synced,
    summary: summarizeConversationState(workspacePath, synced.path),
  };
}

export function createPlanStep(
  workspacePath: string,
  title: string,
  actor: string,
  options: CreatePlanStepOptions,
): PrimitiveInstance {
  const conversation = readConversationOrThrow(workspacePath, options.conversationRef);
  const status = options.status ?? 'open';
  const threadRef = options.threadRef ? normalizeThreadRef(options.threadRef) : undefined;
  if (threadRef) {
    assertThreadExists(workspacePath, threadRef);
  }
  const steps = listPlanSteps(workspacePath, { conversationRef: conversation.path });
  const nextOrder = options.order ?? (
    steps.length === 0
      ? 1
      : Math.max(...steps.map((step) => toFiniteNumber(step.fields.order, 0))) + 1
  );
  const created = store.create(
    workspacePath,
    'plan-step',
    {
      title,
      status,
      progress: status === 'done' ? 100 : 0,
      conversation_ref: conversation.path,
      thread_ref: threadRef,
      order: nextOrder,
      assignee: options.assignee,
      tags: options.tags ?? [],
      started_at: status === 'active' ? new Date().toISOString() : undefined,
      completed_at: status === 'done' ? new Date().toISOString() : undefined,
      depends_on: [],
    },
    options.body ?? renderPlanStepBody({
      title,
      status,
      progress: status === 'done' ? 100 : 0,
      conversationRef: conversation.path,
      threadRef,
      assignee: options.assignee,
      order: nextOrder,
      blockedReason: undefined,
      cancellationReason: undefined,
      startedAt: status === 'active' ? new Date().toISOString() : undefined,
      completedAt: status === 'done' ? new Date().toISOString() : undefined,
    }),
    actor,
  );

  const nextStepRefs = uniqueRefs([
    ...coerceStringArray(conversation.fields.plan_step_refs).map(normalizePlanStepRef),
    created.path,
  ]);
  const nextThreadRefs = threadRef
    ? uniqueRefs([
        ...coerceStringArray(conversation.fields.thread_refs).map(normalizeThreadRef),
        threadRef,
      ])
    : coerceStringArray(conversation.fields.thread_refs).map(normalizeThreadRef);
  store.update(
    workspacePath,
    conversation.path,
    {
      plan_step_refs: nextStepRefs,
      thread_refs: nextThreadRefs,
    },
    renderConversationBody({
      title: String(conversation.fields.title ?? conversation.path),
      status: normalizeConversationStatus(conversation.fields.status),
      threadRefs: nextThreadRefs,
      planStepRefs: nextStepRefs,
      events: coerceEventRecords(conversation.fields.events),
      summary: null,
    }),
    actor,
  );
  syncConversationState(workspacePath, conversation.path, actor);
  return created;
}

export function listPlanSteps(
  workspacePath: string,
  options: ListPlanStepsOptions = {},
): PrimitiveInstance[] {
  const normalizedConversation = options.conversationRef
    ? normalizeConversationRef(options.conversationRef)
    : undefined;
  const normalizedThread = options.threadRef ? normalizeThreadRef(options.threadRef) : undefined;
  return store.list(workspacePath, 'plan-step')
    .filter((step) => {
      if (options.status && normalizePlanStepStatus(step.fields.status) !== options.status) return false;
      if (normalizedConversation) {
        const stepConversationRef = normalizeConversationRef(step.fields.conversation_ref);
        if (stepConversationRef !== normalizedConversation) return false;
      }
      if (normalizedThread) {
        const stepThreadRef = normalizeThreadRef(step.fields.thread_ref);
        if (stepThreadRef !== normalizedThread) return false;
      }
      return true;
    })
    .sort(comparePlanSteps);
}

export function updatePlanStepStatus(
  workspacePath: string,
  planStepRef: string,
  nextStatus: PlanStepStatus,
  actor: string,
  options: TransitionPlanStepOptions = {},
): PrimitiveInstance {
  const step = readPlanStepOrThrow(workspacePath, planStepRef);
  const currentStatus = normalizePlanStepStatus(step.fields.status);
  assertPlanStepTransition(currentStatus, nextStatus, step.path);
  const reason = String(options.reason ?? '').trim();
  if (nextStatus === 'blocked' && !reason) {
    throw new Error('Blocking a plan-step requires a reason.');
  }
  const now = new Date().toISOString();
  const updates: Record<string, unknown> = {
    status: nextStatus,
  };
  if (nextStatus === 'active') {
    updates.started_at = step.fields.started_at ?? now;
    updates.blocked_reason = undefined;
    updates.cancellation_reason = undefined;
  }
  if (nextStatus === 'blocked') {
    updates.blocked_reason = reason;
  } else if (currentStatus === 'blocked') {
    updates.blocked_reason = undefined;
  }
  if (nextStatus === 'done') {
    updates.progress = 100;
    updates.completed_at = now;
    updates.blocked_reason = undefined;
    updates.cancellation_reason = undefined;
  } else if (currentStatus === 'done') {
    updates.completed_at = undefined;
    updates.progress = Math.min(toFiniteNumber(step.fields.progress, 0), 99);
  }
  if (nextStatus === 'cancelled') {
    updates.cancellation_reason = reason || 'cancelled';
  } else if (currentStatus === 'cancelled') {
    updates.cancellation_reason = undefined;
  }
  if (nextStatus === 'open') {
    updates.started_at = undefined;
  }
  const merged = { ...step.fields, ...updates };
  const updated = store.update(
    workspacePath,
    step.path,
    updates,
    renderPlanStepBody({
      title: String(merged.title ?? step.path),
      status: normalizePlanStepStatus(merged.status),
      progress: clampProgress(toFiniteNumber(merged.progress, 0)),
      conversationRef: normalizeConversationRef(merged.conversation_ref),
      threadRef: merged.thread_ref ? normalizeThreadRef(merged.thread_ref) : undefined,
      assignee: asOptionalString(merged.assignee),
      order: toFiniteNumber(merged.order, 0),
      blockedReason: asOptionalString(merged.blocked_reason),
      cancellationReason: asOptionalString(merged.cancellation_reason),
      startedAt: asOptionalString(merged.started_at),
      completedAt: asOptionalString(merged.completed_at),
    }),
    actor,
  );
  const conversationRef = normalizeConversationRef(updated.fields.conversation_ref);
  syncConversationState(workspacePath, conversationRef, actor);
  return updated;
}

export function updatePlanStepProgress(
  workspacePath: string,
  planStepRef: string,
  progress: number,
  actor: string,
): PrimitiveInstance {
  if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
    throw new Error(`Invalid plan-step progress "${String(progress)}". Expected 0..100.`);
  }
  const step = readPlanStepOrThrow(workspacePath, planStepRef);
  const status = normalizePlanStepStatus(step.fields.status);
  if (status === 'done' || status === 'cancelled') {
    throw new Error(`Cannot update progress for step in terminal status "${status}".`);
  }
  const roundedProgress = clampProgress(progress);
  const updates: Record<string, unknown> = {
    progress: roundedProgress,
  };
  if (status === 'open' && roundedProgress > 0) {
    updates.status = 'active';
    updates.started_at = step.fields.started_at ?? new Date().toISOString();
  }
  const merged = { ...step.fields, ...updates };
  const updated = store.update(
    workspacePath,
    step.path,
    updates,
    renderPlanStepBody({
      title: String(merged.title ?? step.path),
      status: normalizePlanStepStatus(merged.status),
      progress: clampProgress(toFiniteNumber(merged.progress, 0)),
      conversationRef: normalizeConversationRef(merged.conversation_ref),
      threadRef: merged.thread_ref ? normalizeThreadRef(merged.thread_ref) : undefined,
      assignee: asOptionalString(merged.assignee),
      order: toFiniteNumber(merged.order, 0),
      blockedReason: asOptionalString(merged.blocked_reason),
      cancellationReason: asOptionalString(merged.cancellation_reason),
      startedAt: asOptionalString(merged.started_at),
      completedAt: asOptionalString(merged.completed_at),
    }),
    actor,
  );
  const conversationRef = normalizeConversationRef(updated.fields.conversation_ref);
  syncConversationState(workspacePath, conversationRef, actor);
  return updated;
}

export function summarizeConversationState(
  workspacePath: string,
  conversationRef: string,
): ConversationStateSummary {
  const conversation = readConversationOrThrow(workspacePath, conversationRef);
  return summarizeConversationStateFromInstance(workspacePath, conversation);
}

function syncConversationState(
  workspacePath: string,
  conversationRef: string,
  actor: string,
): PrimitiveInstance {
  const conversation = readConversationOrThrow(workspacePath, conversationRef);
  const summary = summarizeConversationStateFromInstance(workspacePath, conversation);
  const updates: Record<string, unknown> = {
    status: summary.status,
    progress: summary.progress,
    message_count: summary.messageCount,
    thread_refs: summary.threadRefs,
    plan_step_refs: summary.stepRefs,
    step_total: summary.steps.total,
    step_open: summary.steps.open,
    step_active: summary.steps.active,
    step_blocked: summary.steps.blocked,
    step_done: summary.steps.done,
    step_cancelled: summary.steps.cancelled,
  };
  const changed = Object.entries(updates).some(([key, value]) => !isEqual(conversation.fields[key], value));
  if (!changed) return conversation;
  return store.update(
    workspacePath,
    conversation.path,
    updates,
    renderConversationBody({
      title: String(conversation.fields.title ?? conversation.path),
      status: summary.status,
      threadRefs: summary.threadRefs,
      planStepRefs: summary.stepRefs,
      events: coerceEventRecords(conversation.fields.events),
      summary,
    }),
    actor,
  );
}

function summarizeConversationStateFromInstance(
  workspacePath: string,
  conversation: PrimitiveInstance,
): ConversationStateSummary {
  const stepRefsFromConversation = coerceStringArray(conversation.fields.plan_step_refs).map(normalizePlanStepRef);
  const steps = listPlanSteps(workspacePath, { conversationRef: conversation.path });
  const stepRefs = uniqueRefs([
    ...stepRefsFromConversation,
    ...steps.map((step) => step.path),
  ]);
  const stepCounts = {
    total: steps.length,
    open: 0,
    active: 0,
    blocked: 0,
    done: 0,
    cancelled: 0,
  };
  let progressAccumulator = 0;
  for (const step of steps) {
    const status = normalizePlanStepStatus(step.fields.status);
    stepCounts[status] += 1;
    progressAccumulator += clampProgress(toFiniteNumber(step.fields.progress, status === 'done' ? 100 : 0));
  }
  const progress = stepCounts.total > 0
    ? Math.round(progressAccumulator / stepCounts.total)
    : clampProgress(toFiniteNumber(conversation.fields.progress, 0));
  const events = coerceEventRecords(conversation.fields.events);
  const messageCount = Math.max(toFiniteNumber(conversation.fields.message_count, 0), events.length);
  const threadRefs = uniqueRefs(coerceStringArray(conversation.fields.thread_refs).map(normalizeThreadRef));
  const threadCounts = {
    total: threadRefs.length,
    open: 0,
    active: 0,
    blocked: 0,
    done: 0,
    cancelled: 0,
    missing: 0,
  };
  for (const threadRef of threadRefs) {
    const thread = store.read(workspacePath, threadRef);
    if (!thread || thread.type !== 'thread') {
      threadCounts.missing += 1;
      continue;
    }
    const status = normalizeConversationStatus(thread.fields.status);
    threadCounts[status] += 1;
  }
  const persistedStatus = normalizeConversationStatus(conversation.fields.status);
  const status = deriveConversationStatus(persistedStatus, stepCounts, messageCount);
  return {
    conversationPath: conversation.path,
    status,
    progress,
    messageCount,
    threadRefs,
    stepRefs,
    steps: stepCounts,
    threads: threadCounts,
    updatedAt: new Date().toISOString(),
  };
}

function deriveConversationStatus(
  persistedStatus: ConversationStatus,
  steps: ConversationStateSummary['steps'],
  messageCount: number,
): ConversationStatus {
  if (persistedStatus === 'cancelled') return 'cancelled';
  if (steps.total > 0 && steps.open === 0 && steps.active === 0 && steps.blocked === 0) {
    if (steps.done > 0) return 'done';
    return 'cancelled';
  }
  if (steps.blocked > 0) return 'blocked';
  if (steps.active > 0) return 'active';
  if (messageCount > 0) return 'active';
  if (steps.open > 0) return 'open';
  return persistedStatus === 'done' ? 'done' : 'open';
}

function readConversationOrThrow(workspacePath: string, conversationRef: string): PrimitiveInstance {
  const normalized = normalizeConversationRef(conversationRef);
  const conversation = store.read(workspacePath, normalized);
  if (!conversation) {
    throw new Error(`Conversation not found: ${normalized}`);
  }
  if (conversation.type !== 'conversation') {
    throw new Error(`Target is not a conversation primitive: ${normalized}`);
  }
  return conversation;
}

function readPlanStepOrThrow(workspacePath: string, planStepRef: string): PrimitiveInstance {
  const normalized = normalizePlanStepRef(planStepRef);
  const step = store.read(workspacePath, normalized);
  if (!step) {
    throw new Error(`Plan-step not found: ${normalized}`);
  }
  if (step.type !== 'plan-step') {
    throw new Error(`Target is not a plan-step primitive: ${normalized}`);
  }
  return step;
}

function normalizeConversationRef(value: unknown): string {
  return normalizePrimitiveRef(value, 'conversations');
}

function normalizePlanStepRef(value: unknown): string {
  return normalizePrimitiveRef(value, 'plan-steps');
}

function normalizeThreadRef(value: unknown): string {
  return normalizePrimitiveRef(value, 'threads');
}

function normalizePrimitiveRef(value: unknown, directory: string): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const unwrapped = raw.startsWith('[[') && raw.endsWith(']]')
    ? raw.slice(2, -2)
    : raw;
  const primary = unwrapped.split('|')[0].trim().split('#')[0].trim();
  if (!primary) return '';
  const withDirectory = primary.includes('/')
    ? primary
    : `${directory}/${primary}`;
  return withDirectory.endsWith('.md') ? withDirectory : `${withDirectory}.md`;
}

function assertThreadExists(workspacePath: string, threadRef: string): void {
  const thread = store.read(workspacePath, threadRef);
  if (!thread || thread.type !== 'thread') {
    throw new Error(`Thread reference not found: ${threadRef}`);
  }
}

function assertPlanStepTransition(from: PlanStepStatus, to: PlanStepStatus, planStepPath: string): void {
  if (from === to) return;
  const allowed = PLAN_STEP_STATUS_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid plan-step transition for ${planStepPath}: ${from} -> ${to}. Allowed: ${allowed.join(', ') || 'none'}.`);
  }
}

function normalizeConversationStatus(value: unknown): ConversationStatus {
  const normalized = String(value ?? 'open').toLowerCase();
  if (normalized === 'open' || normalized === 'active' || normalized === 'blocked' || normalized === 'done' || normalized === 'cancelled') {
    return normalized;
  }
  return 'open';
}

function normalizePlanStepStatus(value: unknown): PlanStepStatus {
  const normalized = String(value ?? 'open').toLowerCase();
  if (normalized === 'open' || normalized === 'active' || normalized === 'blocked' || normalized === 'done' || normalized === 'cancelled') {
    return normalized;
  }
  return 'open';
}

function comparePlanSteps(left: PrimitiveInstance, right: PrimitiveInstance): number {
  const byOrder = toFiniteNumber(left.fields.order, Number.MAX_SAFE_INTEGER) - toFiniteNumber(right.fields.order, Number.MAX_SAFE_INTEGER);
  if (byOrder !== 0) return byOrder;
  const createdLeft = String(left.fields.created ?? '');
  const createdRight = String(right.fields.created ?? '');
  if (createdLeft !== createdRight) return createdLeft.localeCompare(createdRight);
  return left.path.localeCompare(right.path);
}

function toFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function clampProgress(value: number): number {
  const rounded = Math.round(value);
  if (rounded < 0) return 0;
  if (rounded > 100) return 100;
  return rounded;
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? '').trim())
    .filter((item) => item.length > 0);
}

function coerceEventRecords(value: unknown): ConversationEventRecord[] {
  if (!Array.isArray(value)) return [];
  const records: ConversationEventRecord[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const ts = asOptionalString(record.ts);
    const actor = asOptionalString(record.actor);
    const kind = asOptionalString(record.kind) as ConversationEventKind | undefined;
    const message = asOptionalString(record.message);
    if (!ts || !actor || !message) continue;
    if (kind !== 'message' && kind !== 'note' && kind !== 'decision' && kind !== 'system') continue;
    records.push({
      ts,
      actor,
      kind,
      message,
      ...(asOptionalString(record.thread_ref) ? { thread_ref: normalizeThreadRef(record.thread_ref) } : {}),
    });
  }
  return records;
}

function uniqueRefs(values: string[]): string[] {
  const deduped = new Set<string>();
  for (const value of values) {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) continue;
    deduped.add(trimmed);
  }
  return [...deduped].sort((left, right) => left.localeCompare(right));
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
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

function renderConversationBody(input: {
  title: string;
  status: ConversationStatus;
  threadRefs: string[];
  planStepRefs: string[];
  events: ConversationEventRecord[];
  summary: ConversationStateSummary | null;
}): string {
  const lines = [
    '# Conversation',
    '',
    `Title: ${input.title}`,
    `Status: ${input.status}`,
    ...(input.summary ? [`Progress: ${input.summary.progress}%`] : []),
    '',
    '## Threads',
    '',
    ...(input.threadRefs.length > 0
      ? input.threadRefs.map((ref) => `- [[${ref}]]`)
      : ['- none']),
    '',
    '## Plan Steps',
    '',
    ...(input.planStepRefs.length > 0
      ? input.planStepRefs.map((ref) => `- [[${ref}]]`)
      : ['- none']),
    '',
  ];
  if (input.summary) {
    lines.push('## State');
    lines.push('');
    lines.push(`- steps: total=${input.summary.steps.total} open=${input.summary.steps.open} active=${input.summary.steps.active} blocked=${input.summary.steps.blocked} done=${input.summary.steps.done} cancelled=${input.summary.steps.cancelled}`);
    lines.push(`- threads: total=${input.summary.threads.total} open=${input.summary.threads.open} active=${input.summary.threads.active} blocked=${input.summary.threads.blocked} done=${input.summary.threads.done} cancelled=${input.summary.threads.cancelled} missing=${input.summary.threads.missing}`);
    lines.push('');
  }
  lines.push('## Events');
  lines.push('');
  const recentEvents = input.events.slice(-25);
  if (recentEvents.length === 0) {
    lines.push('- none');
  } else {
    for (const event of recentEvents) {
      lines.push(`- ${event.ts} [${event.kind}] ${event.actor}${event.thread_ref ? ` thread=${event.thread_ref}` : ''}: ${event.message}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function renderPlanStepBody(input: {
  title: string;
  status: PlanStepStatus;
  progress: number;
  conversationRef: string;
  threadRef?: string;
  assignee?: string;
  order: number;
  blockedReason?: string;
  cancellationReason?: string;
  startedAt?: string;
  completedAt?: string;
}): string {
  return [
    '# Plan Step',
    '',
    `Title: ${input.title}`,
    `Status: ${input.status}`,
    `Progress: ${input.progress}%`,
    `Order: ${input.order}`,
    `Conversation: [[${input.conversationRef}]]`,
    `Thread: ${input.threadRef ? `[[${input.threadRef}]]` : 'none'}`,
    `Assignee: ${input.assignee ?? 'unassigned'}`,
    `Started: ${input.startedAt ?? 'n/a'}`,
    `Completed: ${input.completedAt ?? 'n/a'}`,
    `Blocked reason: ${input.blockedReason ?? 'n/a'}`,
    `Cancellation reason: ${input.cancellationReason ?? 'n/a'}`,
    '',
  ].join('\n');
}

export function assertConversationStatusTransition(
  from: ConversationStatus,
  to: ConversationStatus,
  conversationPath: string,
): void {
  if (from === to) return;
  const allowed = CONVERSATION_STATUS_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid conversation transition for ${conversationPath}: ${from} -> ${to}. Allowed: ${allowed.join(', ') || 'none'}.`);
  }
}
