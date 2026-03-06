/**
 * Trigger-to-run dispatch helpers.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import * as dispatch from './dispatch.js';
import * as ledger from './ledger.js';
import * as store from './store.js';
import * as triggerEngine from './trigger-engine.js';
import type { DispatchRun, LedgerEntry, PrimitiveInstance } from './types.js';

export type TriggerPrimitiveType = 'cron' | 'webhook' | 'event' | 'manual';

export interface TriggerCreateInput {
  actor: string;
  name: string;
  type: TriggerPrimitiveType;
  condition?: unknown;
  action?: unknown;
  enabled?: boolean;
  cooldown?: number;
  body?: string;
  tags?: string[];
  path?: string;
}

export interface TriggerListOptions {
  enabled?: boolean;
  type?: TriggerPrimitiveType;
}

export interface TriggerUpdateInput {
  actor: string;
  name?: string;
  type?: TriggerPrimitiveType;
  condition?: unknown;
  action?: unknown;
  enabled?: boolean;
  cooldown?: number;
  body?: string;
  tags?: string[];
  lastFired?: string | null;
  nextFireAt?: string | null;
}

export interface TriggerEvaluateOptions {
  actor?: string;
  now?: Date;
}

export interface TriggerEvaluateResult {
  triggerPath: string;
  cycle: triggerEngine.TriggerEngineCycleResult;
  trigger: triggerEngine.TriggerEngineCycleTriggerResult | undefined;
}

export interface FireTriggerOptions {
  actor: string;
  eventKey?: string;
  objective?: string;
  adapter?: string;
  context?: Record<string, unknown>;
}

export interface FireTriggerResult {
  triggerPath: string;
  run: DispatchRun;
  idempotencyKey: string;
}

export interface FireTriggerAndExecuteOptions extends FireTriggerOptions {
  execute?: boolean;
  retryFailed?: boolean;
  executeInput?: Omit<dispatch.DispatchExecuteInput, 'actor'>;
  retryInput?: Omit<dispatch.DispatchRetryInput, 'actor'>;
}

export interface FireTriggerAndExecuteResult extends FireTriggerResult {
  executed: boolean;
  retriedFromRunId?: string;
}

export function createTrigger(
  workspacePath: string,
  input: TriggerCreateInput,
): PrimitiveInstance {
  const name = normalizeNonEmpty(input.name, 'Trigger name');
  const triggerType = normalizeTriggerType(input.type);
  const enabled = input.enabled ?? true;
  const fields: Record<string, unknown> = {
    title: name,
    name,
    type: triggerType,
    condition: normalizeTriggerCondition(triggerType, input.condition),
    action: normalizeTriggerAction(input.action, name),
    enabled,
    status: enabled ? 'active' : 'paused',
    cooldown: normalizeCooldown(input.cooldown),
    tags: normalizeTags(input.tags),
  };
  return store.create(
    workspacePath,
    'trigger',
    fields,
    input.body ?? defaultTriggerBody(name, triggerType),
    input.actor,
    {
      pathOverride: normalizeTriggerPathOverride(input.path),
    },
  );
}

export function listTriggers(
  workspacePath: string,
  options: TriggerListOptions = {},
): PrimitiveInstance[] {
  let triggers = store.list(workspacePath, 'trigger')
    .sort((left, right) => left.path.localeCompare(right.path));
  if (options.enabled !== undefined) {
    triggers = triggers.filter((trigger) => readTriggerEnabled(trigger.fields) === options.enabled);
  }
  if (options.type) {
    const expectedType = normalizeTriggerType(options.type);
    triggers = triggers.filter((trigger) =>
      readTriggerType(trigger.fields) === expectedType);
  }
  return triggers;
}

export function showTrigger(workspacePath: string, triggerRef: string): PrimitiveInstance {
  return readTriggerByReference(workspacePath, triggerRef);
}

export function updateTrigger(
  workspacePath: string,
  triggerRef: string,
  input: TriggerUpdateInput,
): PrimitiveInstance {
  const trigger = readTriggerByReference(workspacePath, triggerRef);
  const nextType = input.type
    ? normalizeTriggerType(input.type)
    : readTriggerType(trigger.fields);
  const updates: Record<string, unknown> = {};

  if (input.name !== undefined) {
    const name = normalizeNonEmpty(input.name, 'Trigger name');
    updates.name = name;
    updates.title = name;
  }
  if (input.type !== undefined) {
    updates.type = nextType;
  }
  if (input.condition !== undefined) {
    updates.condition = normalizeTriggerCondition(nextType, input.condition);
  }
  if (input.action !== undefined) {
    const fallbackName = String(trigger.fields.name ?? trigger.fields.title ?? trigger.path);
    updates.action = normalizeTriggerAction(input.action, fallbackName);
  }
  if (input.enabled !== undefined) {
    updates.enabled = input.enabled;
    updates.status = input.enabled ? 'active' : 'paused';
  }
  if (input.cooldown !== undefined) {
    updates.cooldown = normalizeCooldown(input.cooldown);
  }
  if (input.tags !== undefined) {
    updates.tags = normalizeTags(input.tags);
  }
  if (input.lastFired !== undefined) {
    updates.last_fired = normalizeNullableDate(input.lastFired, 'lastFired');
  }
  if (input.nextFireAt !== undefined) {
    updates.next_fire_at = normalizeNullableDate(input.nextFireAt, 'nextFireAt');
  }

  return store.update(
    workspacePath,
    trigger.path,
    updates,
    input.body,
    input.actor,
  );
}

export function deleteTrigger(workspacePath: string, triggerRef: string, actor: string): void {
  const trigger = readTriggerByReference(workspacePath, triggerRef);
  store.remove(workspacePath, trigger.path, actor);
}

export function enableTrigger(workspacePath: string, triggerRef: string, actor: string): PrimitiveInstance {
  return updateTrigger(workspacePath, triggerRef, { actor, enabled: true });
}

export function disableTrigger(workspacePath: string, triggerRef: string, actor: string): PrimitiveInstance {
  return updateTrigger(workspacePath, triggerRef, { actor, enabled: false });
}

export function triggerHistory(workspacePath: string, triggerRef: string): LedgerEntry[] {
  const trigger = readTriggerByReference(workspacePath, triggerRef);
  return ledger.historyOf(workspacePath, trigger.path);
}

export function evaluateTrigger(
  workspacePath: string,
  triggerRef: string,
  options: TriggerEvaluateOptions = {},
): TriggerEvaluateResult {
  const trigger = readTriggerByReference(workspacePath, triggerRef);
  const cycle = triggerEngine.runTriggerEngineCycle(workspacePath, {
    actor: options.actor,
    now: options.now,
    triggerPaths: [trigger.path],
  });
  return {
    triggerPath: trigger.path,
    cycle,
    trigger: cycle.triggers.find((entry) => entry.triggerPath === trigger.path),
  };
}

export function fireTrigger(
  workspacePath: string,
  triggerRef: string,
  options: FireTriggerOptions,
): FireTriggerResult {
  const trigger = readTriggerByReference(workspacePath, triggerRef);

  const explicitEnabled = asBoolean(trigger.fields.enabled);
  if (explicitEnabled === false) {
    throw new Error(`Trigger must be enabled to fire: ${trigger.path}`);
  }
  const triggerStatus = String(trigger.fields.status ?? 'draft').toLowerCase();
  if (triggerStatus === 'retired') throw new Error(`Trigger is retired and cannot be fired: ${trigger.path}`);
  if (!['approved', 'active'].includes(triggerStatus)) {
    throw new Error(`Trigger must be approved/active to fire. Current status: ${triggerStatus}`);
  }

  const eventSeed = options.eventKey ?? new Date().toISOString();
  const dispatchTemplate = parseDispatchTemplate(trigger.fields.action);
  const templateContext = {
    trigger_path: trigger.path,
    trigger_name: String(trigger.fields.name ?? trigger.fields.title ?? trigger.path),
    trigger_type: readTriggerType(trigger.fields),
    event_key: eventSeed,
    ...(options.context ?? {}),
  };
  const objectiveTemplate = options.objective
    ?? dispatchTemplate?.objective
    ?? `Trigger ${String(trigger.fields.title ?? trigger.path)} fired`;
  const objective = String(materializeTemplateValue(objectiveTemplate, templateContext));
  const actionContext = isRecord(dispatchTemplate?.context)
    ? materializeTemplateValue(dispatchTemplate.context, templateContext) as Record<string, unknown>
    : {};
  const idempotencyKey = buildIdempotencyKey(trigger.path, eventSeed, objective);

  const run = dispatch.createRun(workspacePath, {
    actor: options.actor,
    adapter: options.adapter ?? dispatchTemplate?.adapter,
    objective,
    context: {
      trigger_path: trigger.path,
      trigger_event: describeTriggerEvent(trigger),
      trigger_type: readTriggerType(trigger.fields),
      event_key: eventSeed,
      ...actionContext,
      ...options.context,
    },
    idempotencyKey,
  });

  store.update(
    workspacePath,
    trigger.path,
    {
      last_fired: new Date().toISOString(),
    },
    undefined,
    options.actor,
  );

  ledger.append(workspacePath, options.actor, 'create', trigger.path, 'trigger', {
    fired: true,
    event_key: eventSeed,
    run_id: run.id,
    idempotency_key: idempotencyKey,
  });

  return {
    triggerPath: trigger.path,
    run,
    idempotencyKey,
  };
}

export async function fireTriggerAndExecute(
  workspacePath: string,
  triggerPath: string,
  options: FireTriggerAndExecuteOptions,
): Promise<FireTriggerAndExecuteResult> {
  const fired = fireTrigger(workspacePath, triggerPath, options);
  if (options.execute === false) {
    return {
      ...fired,
      executed: false,
    };
  }

  if (fired.run.status === 'failed' && options.retryFailed) {
    const retried = await dispatch.retryRun(workspacePath, fired.run.id, {
      actor: options.actor,
      ...(options.retryInput ?? {}),
    });
    return {
      triggerPath: fired.triggerPath,
      idempotencyKey: fired.idempotencyKey,
      run: retried,
      executed: true,
      retriedFromRunId: fired.run.id,
    };
  }

  if (fired.run.status === 'queued' || fired.run.status === 'running') {
    const executed = await dispatch.executeRun(workspacePath, fired.run.id, {
      actor: options.actor,
      ...(options.executeInput ?? {}),
    });
    return {
      triggerPath: fired.triggerPath,
      idempotencyKey: fired.idempotencyKey,
      run: executed,
      executed: true,
    };
  }

  return {
    ...fired,
    executed: false,
  };
}

function buildIdempotencyKey(triggerPath: string, eventSeed: string, objective: string): string {
  return createHash('sha256')
    .update(`${triggerPath}:${eventSeed}:${objective}`)
    .digest('hex')
    .slice(0, 32);
}

function normalizeTriggerType(value: unknown): TriggerPrimitiveType {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'cron' || normalized === 'webhook' || normalized === 'event' || normalized === 'manual') {
    return normalized;
  }
  throw new Error(`Invalid trigger type "${String(value)}". Expected cron|webhook|event|manual.`);
}

function readTriggerType(fields: Record<string, unknown>): TriggerPrimitiveType {
  const raw = fields.type;
  if (raw === undefined) return 'event';
  return normalizeTriggerType(raw);
}

function readTriggerEnabled(fields: Record<string, unknown>): boolean {
  const explicitEnabled = asBoolean(fields.enabled);
  if (explicitEnabled !== undefined) return explicitEnabled;
  const status = String(fields.status ?? '').toLowerCase();
  return status === 'active' || status === 'approved';
}

function normalizeTriggerCondition(triggerType: TriggerPrimitiveType, condition: unknown): unknown {
  if (condition !== undefined) return condition;
  switch (triggerType) {
    case 'manual':
      return { type: 'manual' };
    case 'webhook':
      return { type: 'event', pattern: 'webhook.*' };
    case 'event':
      return { type: 'event', pattern: '*' };
    case 'cron':
      throw new Error('Cron triggers require a condition expression.');
    default:
      return condition;
  }
}

function normalizeTriggerAction(action: unknown, triggerName: string): unknown {
  if (action === undefined) {
    return stripUndefinedDeep({
      type: 'dispatch-run',
      objective: `Trigger ${triggerName} fired`,
    });
  }
  if (typeof action === 'string') {
    return stripUndefinedDeep({
      type: 'dispatch-run',
      objective: action,
    });
  }
  if (isRecord(action) && action.type === undefined) {
    if (action.objective !== undefined || action.adapter !== undefined || action.context !== undefined) {
      return stripUndefinedDeep({
        type: 'dispatch-run',
        ...action,
      });
    }
  }
  return stripUndefinedDeep(action);
}

function normalizeTriggerPathOverride(pathOverride?: string): string | undefined {
  if (!pathOverride) return undefined;
  const normalized = String(pathOverride).trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized) return undefined;
  const withExtension = normalized.endsWith('.md') ? normalized : `${normalized}.md`;
  if (withExtension.startsWith('triggers/')) return withExtension;
  return `triggers/${withExtension.replace(/^\/+/, '')}`;
}

function normalizeCooldown(cooldown: unknown): number {
  const parsed = Number(cooldown ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid trigger cooldown "${String(cooldown)}". Expected a non-negative number.`);
  }
  return Math.trunc(parsed);
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  return tags.map((tag) => String(tag).trim()).filter(Boolean);
}

function defaultTriggerBody(name: string, triggerType: TriggerPrimitiveType): string {
  return [
    '## Trigger Primitive',
    '',
    `- Name: ${name}`,
    `- Type: ${triggerType}`,
    '',
    'Dispatches runs when this trigger evaluates true.',
    '',
  ].join('\n');
}

function normalizeNullableDate(value: string | null, label: string): string | null {
  if (value === null) return null;
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`Invalid ${label} value. Expected ISO timestamp or null.`);
  }
  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ${label} value "${normalized}". Expected ISO timestamp.`);
  }
  return new Date(parsed).toISOString();
}

function parseDispatchTemplate(action: unknown): {
  objective?: string;
  adapter?: string;
  context?: Record<string, unknown>;
} | null {
  if (typeof action === 'string') return null;
  if (!isRecord(action)) return null;
  if (action.type && String(action.type).toLowerCase() !== 'dispatch-run') {
    return null;
  }
  const objective = typeof action.objective === 'string'
    ? action.objective
    : undefined;
  const adapter = typeof action.adapter === 'string'
    ? action.adapter
    : undefined;
  const context = isRecord(action.context)
    ? action.context
    : undefined;
  return { objective, adapter, context };
}

function readTriggerByReference(workspacePath: string, triggerRef: string): PrimitiveInstance {
  const normalizedRef = String(triggerRef ?? '').trim();
  if (!normalizedRef) throw new Error('Trigger reference is required.');

  if (looksLikePathReference(normalizedRef)) {
    const pathRef = normalizePathReference(normalizedRef);
    const trigger = store.read(workspacePath, pathRef);
    if (!trigger) throw new Error(`Trigger not found: ${pathRef}`);
    if (trigger.type !== 'trigger') throw new Error(`Target is not a trigger primitive: ${pathRef}`);
    return trigger;
  }

  const slug = slugify(normalizedRef);
  const candidates = listTriggers(workspacePath).filter((trigger) =>
    path.basename(trigger.path, '.md') === slug
    || slugify(String(trigger.fields.name ?? trigger.fields.title ?? '')) === slug
  );
  if (candidates.length === 0) {
    throw new Error(`Trigger not found: ${normalizedRef}`);
  }
  if (candidates.length > 1) {
    throw new Error(`Ambiguous trigger reference "${normalizedRef}". Use an explicit trigger path.`);
  }
  return candidates[0]!;
}

function looksLikePathReference(value: string): boolean {
  return value.includes('/') || value.endsWith('.md');
}

function normalizePathReference(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.endsWith('.md')) return normalized;
  if (normalized.startsWith('triggers/')) return `${normalized}.md`;
  return `triggers/${normalized}.md`;
}

function describeTriggerEvent(trigger: PrimitiveInstance): string {
  if (typeof trigger.fields.event === 'string' && trigger.fields.event.trim().length > 0) {
    return trigger.fields.event.trim();
  }
  const condition = trigger.fields.condition;
  if (typeof condition === 'string') return condition;
  if (isRecord(condition)) {
    for (const key of ['pattern', 'event', 'event_type', 'expression', 'cron']) {
      if (typeof condition[key] === 'string' && condition[key].trim().length > 0) {
        return condition[key].trim();
      }
    }
  }
  return readTriggerType(trigger.fields);
}

function materializeTemplateValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
      const candidate = context[key];
      if (candidate === undefined || candidate === null) return '';
      if (typeof candidate === 'string') return candidate;
      return JSON.stringify(candidate);
    });
  }
  if (Array.isArray(value)) {
    return value.map((entry) => materializeTemplateValue(entry, context));
  }
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      output[key] = materializeTemplateValue(inner, context);
    }
    return output;
  }
  return value;
}

function normalizeNonEmpty(value: unknown, label: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function slugify(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripUndefinedDeep(entry));
  }
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (inner === undefined) continue;
    output[key] = stripUndefinedDeep(inner);
  }
  return output;
}
