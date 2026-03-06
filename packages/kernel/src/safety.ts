import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import * as ledger from './ledger.js';
import type { LedgerEntry } from './types.js';

export const SAFETY_CONFIG_FILE = '.workgraph/safety.yaml';
const SAFETY_LEDGER_TARGET = SAFETY_CONFIG_FILE;
const SAFETY_LEDGER_TYPE = 'safety';
const SAFETY_VERSION = 1;
const DEFAULT_ACTOR = 'system:safety';

export type WorkgraphSafetyCircuitState = 'closed' | 'open' | 'half-open';

export interface WorkgraphSafetyRateLimitConfig {
  enabled: boolean;
  windowSeconds: number;
  maxOperations: number;
}

export interface WorkgraphSafetyCircuitBreakerConfig {
  enabled: boolean;
  failureThreshold: number;
  cooldownSeconds: number;
  halfOpenMaxOperations: number;
}

export interface WorkgraphSafetyKillSwitchConfig {
  engaged: boolean;
  reason?: string;
  engagedAt?: string;
  engagedBy?: string;
}

export interface WorkgraphSafetyRuntimeState {
  rateLimitWindowStartedAt: string;
  rateLimitOperations: number;
  circuitState: WorkgraphSafetyCircuitState;
  consecutiveFailures: number;
  openedAt?: string;
  halfOpenOperations: number;
  lastFailureAt?: string;
  lastFailureReason?: string;
}

export interface WorkgraphSafetyConfig {
  version: number;
  updatedAt: string;
  rateLimit: WorkgraphSafetyRateLimitConfig;
  circuitBreaker: WorkgraphSafetyCircuitBreakerConfig;
  killSwitch: WorkgraphSafetyKillSwitchConfig;
  runtime: WorkgraphSafetyRuntimeState;
}

export interface WorkgraphSafetyConfigPatch {
  rateLimit?: Partial<WorkgraphSafetyRateLimitConfig>;
  circuitBreaker?: Partial<WorkgraphSafetyCircuitBreakerConfig>;
}

export interface WorkgraphSafetyEvaluateOptions {
  actor: string;
  operation: string;
  now?: Date;
  consume?: boolean;
  logAllowed?: boolean;
}

export interface WorkgraphSafetyDecision {
  allowed: boolean;
  reasons: string[];
  config: WorkgraphSafetyConfig;
  cooldownRemainingSeconds: number;
  windowRemainingSeconds: number;
}

export interface WorkgraphSafetyOutcomeOptions {
  actor: string;
  operation: string;
  success: boolean;
  error?: string;
  now?: Date;
}

export interface WorkgraphSafetyResetOptions {
  actor: string;
  clearKillSwitch?: boolean;
}

export interface WorkgraphSafetyStatus {
  blocked: boolean;
  reasons: string[];
  config: WorkgraphSafetyConfig;
  cooldownRemainingSeconds: number;
  windowRemainingSeconds: number;
}

export interface WorkgraphSafetyEventQueryOptions {
  count?: number;
}

interface WorkgraphSafetyEvaluationSnapshot {
  reasons: string[];
  cooldownRemainingSeconds: number;
  windowRemainingSeconds: number;
}

export function safetyConfigPath(workspacePath: string): string {
  return path.join(workspacePath, SAFETY_CONFIG_FILE);
}

export function ensureSafetyConfig(workspacePath: string): WorkgraphSafetyConfig {
  const targetPath = safetyConfigPath(workspacePath);
  if (fs.existsSync(targetPath)) {
    return loadSafetyConfig(workspacePath);
  }
  const nowIso = new Date().toISOString();
  const created = buildDefaultSafetyConfig(nowIso);
  writeSafetyConfig(workspacePath, created);
  return created;
}

export function loadSafetyConfig(workspacePath: string): WorkgraphSafetyConfig {
  const targetPath = safetyConfigPath(workspacePath);
  if (!fs.existsSync(targetPath)) {
    return ensureSafetyConfig(workspacePath);
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(fs.readFileSync(targetPath, 'utf-8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${SAFETY_CONFIG_FILE}: ${message}`);
  }
  return normalizeSafetyConfig(parsed, new Date().toISOString());
}

export function updateSafetyConfig(
  workspacePath: string,
  actor: string,
  patch: WorkgraphSafetyConfigPatch,
): WorkgraphSafetyConfig {
  const nowIso = new Date().toISOString();
  const current = loadSafetyConfig(workspacePath);
  const merged = normalizeSafetyConfig({
    ...current,
    rateLimit: {
      ...current.rateLimit,
      ...patch.rateLimit,
    },
    circuitBreaker: {
      ...current.circuitBreaker,
      ...patch.circuitBreaker,
    },
    updatedAt: nowIso,
  }, nowIso);
  writeSafetyConfig(workspacePath, merged);
  appendSafetyEvent(workspacePath, actor, 'safety.config.updated', {
    rateLimit: merged.rateLimit,
    circuitBreaker: merged.circuitBreaker,
  });
  return merged;
}

export function pauseSafetyOperations(
  workspacePath: string,
  actor: string,
  reason?: string,
): WorkgraphSafetyConfig {
  const nowIso = new Date().toISOString();
  const config = loadSafetyConfig(workspacePath);
  config.killSwitch.engaged = true;
  config.killSwitch.engagedAt = nowIso;
  config.killSwitch.engagedBy = normalizeActor(actor);
  config.killSwitch.reason = normalizeOptionalString(reason) ?? 'Paused manually';
  config.updatedAt = nowIso;
  writeSafetyConfig(workspacePath, config);
  appendSafetyEvent(workspacePath, actor, 'safety.kill_switch.engaged', {
    reason: config.killSwitch.reason,
  });
  return config;
}

export function resumeSafetyOperations(workspacePath: string, actor: string): WorkgraphSafetyConfig {
  const nowIso = new Date().toISOString();
  const config = loadSafetyConfig(workspacePath);
  config.killSwitch.engaged = false;
  config.killSwitch.reason = undefined;
  config.killSwitch.engagedAt = undefined;
  config.killSwitch.engagedBy = undefined;
  config.updatedAt = nowIso;
  writeSafetyConfig(workspacePath, config);
  appendSafetyEvent(workspacePath, actor, 'safety.kill_switch.released');
  return config;
}

export function resetSafetyRails(
  workspacePath: string,
  options: WorkgraphSafetyResetOptions,
): WorkgraphSafetyConfig {
  const nowIso = new Date().toISOString();
  const config = loadSafetyConfig(workspacePath);
  config.runtime = buildDefaultRuntimeState(nowIso);
  if (options.clearKillSwitch) {
    config.killSwitch = { engaged: false };
  }
  config.updatedAt = nowIso;
  writeSafetyConfig(workspacePath, config);
  appendSafetyEvent(workspacePath, options.actor, 'safety.reset', {
    clearKillSwitch: options.clearKillSwitch === true,
  });
  return config;
}

export function evaluateSafety(
  workspacePath: string,
  options: WorkgraphSafetyEvaluateOptions,
): WorkgraphSafetyDecision {
  const actor = normalizeActor(options.actor);
  const operation = normalizeOperation(options.operation);
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();

  const config = loadSafetyConfig(workspacePath);
  const transitionEvents: string[] = [];
  let changed = applyTimeBasedTransitions(config, nowMs, nowIso, transitionEvents);
  const snapshot = evaluateConfigSnapshot(config, nowMs);
  if (snapshot.reasons.length === 0 && options.consume !== false) {
    if (config.rateLimit.enabled) {
      config.runtime.rateLimitOperations += 1;
    }
    if (config.circuitBreaker.enabled && config.runtime.circuitState === 'half-open') {
      config.runtime.halfOpenOperations += 1;
    }
    config.updatedAt = nowIso;
    changed = true;
  }

  if (changed) {
    writeSafetyConfig(workspacePath, config);
  }

  for (const eventName of transitionEvents) {
    appendSafetyEvent(workspacePath, actor, eventName, {
      operation,
    });
  }

  if (snapshot.reasons.length > 0) {
    appendSafetyEvent(workspacePath, actor, 'safety.blocked', {
      operation,
      reasons: snapshot.reasons,
      circuitState: config.runtime.circuitState,
      rateLimitOperations: config.runtime.rateLimitOperations,
    });
  } else if (options.logAllowed === true) {
    appendSafetyEvent(workspacePath, actor, 'safety.allowed', {
      operation,
    });
  }

  return {
    allowed: snapshot.reasons.length === 0,
    reasons: snapshot.reasons,
    cooldownRemainingSeconds: snapshot.cooldownRemainingSeconds,
    windowRemainingSeconds: snapshot.windowRemainingSeconds,
    config,
  };
}

export function recordOperationOutcome(
  workspacePath: string,
  options: WorkgraphSafetyOutcomeOptions,
): WorkgraphSafetyConfig {
  const actor = normalizeActor(options.actor);
  const operation = normalizeOperation(options.operation);
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();

  const config = loadSafetyConfig(workspacePath);
  const transitionEvents: string[] = [];
  let changed = applyTimeBasedTransitions(config, nowMs, nowIso, transitionEvents);

  if (options.success) {
    const hadFailures = config.runtime.consecutiveFailures > 0
      || !!config.runtime.lastFailureAt
      || !!config.runtime.lastFailureReason;
    if (hadFailures) {
      config.runtime.consecutiveFailures = 0;
      config.runtime.lastFailureAt = undefined;
      config.runtime.lastFailureReason = undefined;
      changed = true;
    }
    if (config.runtime.circuitState !== 'closed') {
      config.runtime.circuitState = 'closed';
      config.runtime.openedAt = undefined;
      config.runtime.halfOpenOperations = 0;
      transitionEvents.push('safety.circuit.closed');
      changed = true;
    }
  } else {
    config.runtime.lastFailureAt = nowIso;
    config.runtime.lastFailureReason = normalizeOptionalString(options.error);
    changed = true;
    if (config.circuitBreaker.enabled) {
      if (config.runtime.circuitState === 'half-open') {
        config.runtime.circuitState = 'open';
        config.runtime.openedAt = nowIso;
        config.runtime.halfOpenOperations = 0;
        config.runtime.consecutiveFailures = config.circuitBreaker.failureThreshold;
        transitionEvents.push('safety.circuit.opened');
      } else {
        config.runtime.consecutiveFailures += 1;
        if (config.runtime.consecutiveFailures >= config.circuitBreaker.failureThreshold) {
          if (config.runtime.circuitState !== 'open') {
            transitionEvents.push('safety.circuit.opened');
          }
          config.runtime.circuitState = 'open';
          config.runtime.openedAt = nowIso;
          config.runtime.halfOpenOperations = 0;
        }
      }
    } else {
      config.runtime.circuitState = 'closed';
      config.runtime.openedAt = undefined;
      config.runtime.halfOpenOperations = 0;
    }
  }

  if (changed) {
    config.updatedAt = nowIso;
    writeSafetyConfig(workspacePath, config);
  }

  for (const eventName of transitionEvents) {
    appendSafetyEvent(workspacePath, actor, eventName, {
      operation,
      consecutiveFailures: config.runtime.consecutiveFailures,
    });
  }

  appendSafetyEvent(
    workspacePath,
    actor,
    options.success ? 'safety.operation.succeeded' : 'safety.operation.failed',
    {
      operation,
      ...(options.error ? { error: options.error } : {}),
    },
  );

  return config;
}

export async function runWithSafetyRails<T>(
  workspacePath: string,
  options: Omit<WorkgraphSafetyEvaluateOptions, 'consume'>,
  operation: () => Promise<T> | T,
): Promise<T> {
  const decision = evaluateSafety(workspacePath, {
    ...options,
    consume: true,
  });
  if (!decision.allowed) {
    throw new Error(`Safety rails blocked "${options.operation}": ${decision.reasons.join('; ')}`);
  }
  try {
    const result = await operation();
    recordOperationOutcome(workspacePath, {
      actor: options.actor,
      operation: options.operation,
      success: true,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordOperationOutcome(workspacePath, {
      actor: options.actor,
      operation: options.operation,
      success: false,
      error: message,
    });
    throw error;
  }
}

export function getSafetyStatus(workspacePath: string, now: Date = new Date()): WorkgraphSafetyStatus {
  const snapshotConfig = cloneSafetyConfig(loadSafetyConfig(workspacePath));
  applyTimeBasedTransitions(snapshotConfig, now.getTime(), now.toISOString(), []);
  const snapshot = evaluateConfigSnapshot(snapshotConfig, now.getTime());
  return {
    blocked: snapshot.reasons.length > 0,
    reasons: snapshot.reasons,
    cooldownRemainingSeconds: snapshot.cooldownRemainingSeconds,
    windowRemainingSeconds: snapshot.windowRemainingSeconds,
    config: snapshotConfig,
  };
}

export function listSafetyEvents(
  workspacePath: string,
  options: WorkgraphSafetyEventQueryOptions = {},
): LedgerEntry[] {
  const allSafetyEntries = ledger.readAll(workspacePath).filter((entry) => isSafetyEntry(entry));
  const count = normalizeNonNegativeInt(options.count, 20);
  if (count === 0) return [];
  return allSafetyEntries.slice(-count);
}

function writeSafetyConfig(workspacePath: string, config: WorkgraphSafetyConfig): void {
  const targetPath = safetyConfigPath(workspacePath);
  const directory = path.dirname(targetPath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(targetPath, YAML.stringify(config), 'utf-8');
}

function appendSafetyEvent(
  workspacePath: string,
  actor: string,
  event: string,
  data: Record<string, unknown> = {},
): LedgerEntry {
  return ledger.append(
    workspacePath,
    normalizeActor(actor),
    'update',
    SAFETY_LEDGER_TARGET,
    SAFETY_LEDGER_TYPE,
    {
      event,
      ...data,
    },
  );
}

function applyTimeBasedTransitions(
  config: WorkgraphSafetyConfig,
  nowMs: number,
  nowIso: string,
  eventNames: string[],
): boolean {
  let changed = false;

  if (config.rateLimit.enabled) {
    const windowStartMs = parseTimestamp(config.runtime.rateLimitWindowStartedAt);
    const elapsedMs = windowStartMs === null ? Number.POSITIVE_INFINITY : nowMs - windowStartMs;
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= (config.rateLimit.windowSeconds * 1000)) {
      config.runtime.rateLimitWindowStartedAt = nowIso;
      config.runtime.rateLimitOperations = 0;
      eventNames.push('safety.rate_limit.window_reset');
      changed = true;
    }
  } else if (config.runtime.rateLimitOperations !== 0) {
    config.runtime.rateLimitOperations = 0;
    changed = true;
  }

  if (!config.circuitBreaker.enabled) {
    if (
      config.runtime.circuitState !== 'closed'
      || config.runtime.openedAt !== undefined
      || config.runtime.halfOpenOperations !== 0
      || config.runtime.consecutiveFailures !== 0
    ) {
      config.runtime.circuitState = 'closed';
      config.runtime.openedAt = undefined;
      config.runtime.halfOpenOperations = 0;
      config.runtime.consecutiveFailures = 0;
      changed = true;
    }
  } else if (config.runtime.circuitState === 'open') {
    const openedAtMs = parseTimestamp(config.runtime.openedAt);
    const elapsedMs = openedAtMs === null ? Number.POSITIVE_INFINITY : nowMs - openedAtMs;
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= (config.circuitBreaker.cooldownSeconds * 1000)) {
      config.runtime.circuitState = 'half-open';
      config.runtime.halfOpenOperations = 0;
      config.runtime.openedAt = undefined;
      eventNames.push('safety.circuit.half_open');
      changed = true;
    }
  }

  if (changed) {
    config.updatedAt = nowIso;
  }
  return changed;
}

function evaluateConfigSnapshot(
  config: WorkgraphSafetyConfig,
  nowMs: number,
): WorkgraphSafetyEvaluationSnapshot {
  const reasons: string[] = [];
  let cooldownRemainingSeconds = 0;
  let windowRemainingSeconds = 0;

  if (config.killSwitch.engaged) {
    const reason = config.killSwitch.reason ?? 'Kill switch engaged';
    reasons.push(`Kill switch engaged: ${reason}`);
  }

  if (config.circuitBreaker.enabled) {
    if (config.runtime.circuitState === 'open') {
      const openedAtMs = parseTimestamp(config.runtime.openedAt);
      if (openedAtMs !== null) {
        const elapsedSeconds = Math.floor((nowMs - openedAtMs) / 1000);
        cooldownRemainingSeconds = Math.max(0, config.circuitBreaker.cooldownSeconds - elapsedSeconds);
      }
      reasons.push(
        cooldownRemainingSeconds > 0
          ? `Circuit breaker open (${cooldownRemainingSeconds}s cooldown remaining)`
          : 'Circuit breaker open',
      );
    } else if (
      config.runtime.circuitState === 'half-open'
      && config.runtime.halfOpenOperations >= config.circuitBreaker.halfOpenMaxOperations
    ) {
      reasons.push('Circuit breaker half-open probe limit reached');
    }
  }

  if (config.rateLimit.enabled) {
    const windowStartMs = parseTimestamp(config.runtime.rateLimitWindowStartedAt);
    if (windowStartMs !== null) {
      const elapsedSeconds = Math.floor((nowMs - windowStartMs) / 1000);
      windowRemainingSeconds = Math.max(0, config.rateLimit.windowSeconds - elapsedSeconds);
    }
    if (config.runtime.rateLimitOperations >= config.rateLimit.maxOperations) {
      reasons.push(
        `Rate limit exceeded (${config.runtime.rateLimitOperations}/${config.rateLimit.maxOperations})`,
      );
    }
  }

  return {
    reasons,
    cooldownRemainingSeconds,
    windowRemainingSeconds,
  };
}

function buildDefaultSafetyConfig(nowIso: string): WorkgraphSafetyConfig {
  return {
    version: SAFETY_VERSION,
    updatedAt: nowIso,
    rateLimit: {
      enabled: true,
      windowSeconds: 60,
      maxOperations: 120,
    },
    circuitBreaker: {
      enabled: true,
      failureThreshold: 3,
      cooldownSeconds: 120,
      halfOpenMaxOperations: 1,
    },
    killSwitch: {
      engaged: false,
    },
    runtime: buildDefaultRuntimeState(nowIso),
  };
}

function buildDefaultRuntimeState(nowIso: string): WorkgraphSafetyRuntimeState {
  return {
    rateLimitWindowStartedAt: nowIso,
    rateLimitOperations: 0,
    circuitState: 'closed',
    consecutiveFailures: 0,
    halfOpenOperations: 0,
  };
}

function normalizeSafetyConfig(input: unknown, nowIso: string): WorkgraphSafetyConfig {
  const defaults = buildDefaultSafetyConfig(nowIso);
  const source = asRecord(input);
  const rateLimitInput = asRecord(source.rateLimit);
  const circuitInput = asRecord(source.circuitBreaker);
  const killSwitchInput = asRecord(source.killSwitch);
  const runtimeInput = asRecord(source.runtime);

  const rateLimit: WorkgraphSafetyRateLimitConfig = {
    enabled: readBoolean(rateLimitInput.enabled) ?? defaults.rateLimit.enabled,
    windowSeconds: normalizePositiveInt(rateLimitInput.windowSeconds, defaults.rateLimit.windowSeconds),
    maxOperations: normalizePositiveInt(rateLimitInput.maxOperations, defaults.rateLimit.maxOperations),
  };

  const circuitBreaker: WorkgraphSafetyCircuitBreakerConfig = {
    enabled: readBoolean(circuitInput.enabled) ?? defaults.circuitBreaker.enabled,
    failureThreshold: normalizePositiveInt(circuitInput.failureThreshold, defaults.circuitBreaker.failureThreshold),
    cooldownSeconds: normalizePositiveInt(circuitInput.cooldownSeconds, defaults.circuitBreaker.cooldownSeconds),
    halfOpenMaxOperations: normalizePositiveInt(
      circuitInput.halfOpenMaxOperations,
      defaults.circuitBreaker.halfOpenMaxOperations,
    ),
  };

  const killSwitch: WorkgraphSafetyKillSwitchConfig = {
    engaged: readBoolean(killSwitchInput.engaged) ?? defaults.killSwitch.engaged,
    reason: normalizeOptionalString(killSwitchInput.reason),
    engagedAt: normalizeOptionalString(killSwitchInput.engagedAt),
    engagedBy: normalizeOptionalString(killSwitchInput.engagedBy),
  };
  if (!killSwitch.engaged) {
    killSwitch.reason = undefined;
    killSwitch.engagedAt = undefined;
    killSwitch.engagedBy = undefined;
  }

  const circuitState = normalizeCircuitState(runtimeInput.circuitState) ?? defaults.runtime.circuitState;
  const runtime: WorkgraphSafetyRuntimeState = {
    rateLimitWindowStartedAt: normalizeOptionalString(runtimeInput.rateLimitWindowStartedAt) ?? nowIso,
    rateLimitOperations: normalizeNonNegativeInt(runtimeInput.rateLimitOperations, 0),
    circuitState,
    consecutiveFailures: normalizeNonNegativeInt(runtimeInput.consecutiveFailures, 0),
    openedAt: normalizeOptionalString(runtimeInput.openedAt),
    halfOpenOperations: normalizeNonNegativeInt(runtimeInput.halfOpenOperations, 0),
    lastFailureAt: normalizeOptionalString(runtimeInput.lastFailureAt),
    lastFailureReason: normalizeOptionalString(runtimeInput.lastFailureReason),
  };
  if (runtime.circuitState !== 'open') runtime.openedAt = undefined;
  if (runtime.circuitState === 'closed') runtime.halfOpenOperations = 0;

  return {
    version: normalizePositiveInt(source.version, defaults.version),
    updatedAt: normalizeOptionalString(source.updatedAt) ?? nowIso,
    rateLimit,
    circuitBreaker,
    killSwitch,
    runtime,
  };
}

function isSafetyEntry(entry: LedgerEntry): boolean {
  if (entry.type === SAFETY_LEDGER_TYPE) return true;
  if (entry.target === SAFETY_LEDGER_TARGET) return true;
  const data = asRecord(entry.data);
  const event = normalizeOptionalString(data.event);
  return event?.startsWith('safety.') ?? false;
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeCircuitState(value: unknown): WorkgraphSafetyCircuitState | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (normalized === 'closed' || normalized === 'open' || normalized === 'half-open') {
    return normalized;
  }
  return undefined;
}

function cloneSafetyConfig(config: WorkgraphSafetyConfig): WorkgraphSafetyConfig {
  return JSON.parse(JSON.stringify(config)) as WorkgraphSafetyConfig;
}

function normalizeOperation(operation: string): string {
  const normalized = normalizeOptionalString(operation);
  return normalized ?? 'autonomy.operation';
}

function normalizeActor(actor: string): string {
  const normalized = normalizeOptionalString(actor);
  return normalized ?? DEFAULT_ACTOR;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return undefined;
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return fallback;
}
