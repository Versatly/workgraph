import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import * as ledger from './ledger.js';
import * as store from './store.js';

const WORKGRAPH_RUNTIME_CONFIG_FILE = '.workgraph/config.yaml';
const SAFETY_STATE_FILE = '.workgraph/safety-state.json';
const DISPATCH_RUNS_FILE = '.workgraph/dispatch-runs.json';
const SAFETY_STATE_VERSION = 1;
const WORKGRAPH_RUNTIME_CONFIG_VERSION = 1;

const DEFAULT_RATE_LIMITS: SafetyRateLimitConfig = {
  maxDispatchesPerMinutePerAgent: 30,
  maxDispatchesPerHourPerAgent: 300,
  maxConcurrentRunsPerAgent: 5,
};

const DEFAULT_CIRCUIT_BREAKER: SafetyCircuitBreakerConfig = {
  maxConsecutiveFailures: 3,
  autoDisableTrigger: true,
};

export interface SafetyRateLimitConfig {
  maxDispatchesPerMinutePerAgent: number;
  maxDispatchesPerHourPerAgent: number;
  maxConcurrentRunsPerAgent: number;
}

export interface SafetyCircuitBreakerConfig {
  maxConsecutiveFailures: number;
  autoDisableTrigger: boolean;
}

export interface WorkgraphRuntimeConfig {
  version: number;
  safety: {
    emergencyStop: boolean;
    rateLimiting: SafetyRateLimitConfig;
    circuitBreaker: SafetyCircuitBreakerConfig;
  };
}

interface SafetyRateLimitAgentState {
  dispatchTimestamps: string[];
}

export interface SafetyCircuitCounter {
  consecutiveFailures: number;
  totalFailures: number;
  lastFailureAt?: string;
  lastError?: string;
  openedAt?: string;
  autoDisabled?: boolean;
}

export interface WorkgraphSafetyState {
  version: number;
  updatedAt: string;
  rateLimiting: {
    agents: Record<string, SafetyRateLimitAgentState>;
  };
  circuitBreaker: {
    agents: Record<string, SafetyCircuitCounter>;
    triggers: Record<string, SafetyCircuitCounter>;
  };
}

export interface SafetyDispatchGuardInput {
  agent: string;
  source: string;
  triggerPath?: string;
  actor?: string;
  now?: Date;
}

export interface SafetyOutcomeInput {
  source: string;
  success: boolean;
  agent?: string;
  triggerPath?: string;
  error?: string;
  actor?: string;
  now?: Date;
}

export interface SafetyStatusSnapshot {
  generatedAt: string;
  configPath: string;
  statePath: string;
  emergencyStop: boolean;
  rateLimiting: SafetyRateLimitConfig & {
    usageByAgent: Array<{
      agent: string;
      dispatchesLastMinute: number;
      dispatchesLastHour: number;
      activeRuns: number;
      rateLimited: boolean;
      concurrencyLimited: boolean;
    }>;
  };
  circuitBreaker: {
    threshold: number;
    agents: Array<{ agent: string } & SafetyCircuitCounter & { open: boolean }>;
    triggers: Array<{ triggerPath: string } & SafetyCircuitCounter & { open: boolean }>;
  };
}

export interface SafetyResetResult {
  targetType: 'agent' | 'trigger';
  target: string;
  reset: boolean;
  reEnabledTrigger: boolean;
}

export interface SafetyLogEntry {
  ts: string;
  actor: string;
  op: string;
  target: string;
  event: string;
  source?: string;
  agent?: string;
  triggerPath?: string;
  details: Record<string, unknown>;
}

export interface SafetyLogQuery {
  agent?: string;
  since?: string;
  limit?: number;
}

export function runtimeConfigPath(workspacePath: string): string {
  return path.join(workspacePath, WORKGRAPH_RUNTIME_CONFIG_FILE);
}

export function safetyStatePath(workspacePath: string): string {
  return path.join(workspacePath, SAFETY_STATE_FILE);
}

export function ensureRuntimeConfig(workspacePath: string): { path: string; config: WorkgraphRuntimeConfig; created: boolean } {
  const targetPath = runtimeConfigPath(workspacePath);
  if (fs.existsSync(targetPath)) {
    return {
      path: targetPath,
      config: loadRuntimeConfig(workspacePath),
      created: false,
    };
  }
  const config = defaultRuntimeConfig();
  saveRuntimeConfig(workspacePath, config);
  return {
    path: targetPath,
    config,
    created: true,
  };
}

export function loadRuntimeConfig(workspacePath: string): WorkgraphRuntimeConfig {
  const targetPath = runtimeConfigPath(workspacePath);
  if (!fs.existsSync(targetPath)) {
    const created = defaultRuntimeConfig();
    saveRuntimeConfig(workspacePath, created);
    return created;
  }

  try {
    const raw = fs.readFileSync(targetPath, 'utf-8');
    const parsed = YAML.parse(raw) as unknown;
    const normalized = normalizeRuntimeConfig(parsed);
    saveRuntimeConfig(workspacePath, normalized);
    return normalized;
  } catch {
    const fallback = defaultRuntimeConfig();
    saveRuntimeConfig(workspacePath, fallback);
    return fallback;
  }
}

export function saveRuntimeConfig(workspacePath: string, config: WorkgraphRuntimeConfig): void {
  const targetPath = runtimeConfigPath(workspacePath);
  const directory = path.dirname(targetPath);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });

  const payload = {
    version: config.version,
    safety: {
      emergency_stop: config.safety.emergencyStop,
      rate_limiting: {
        max_dispatches_per_minute_per_agent: config.safety.rateLimiting.maxDispatchesPerMinutePerAgent,
        max_dispatches_per_hour_per_agent: config.safety.rateLimiting.maxDispatchesPerHourPerAgent,
        max_concurrent_runs_per_agent: config.safety.rateLimiting.maxConcurrentRunsPerAgent,
      },
      circuit_breaker: {
        max_consecutive_failures: config.safety.circuitBreaker.maxConsecutiveFailures,
        auto_disable_trigger: config.safety.circuitBreaker.autoDisableTrigger,
      },
    },
  };
  fs.writeFileSync(targetPath, YAML.stringify(payload), 'utf-8');
}

export function setEmergencyStop(workspacePath: string, enabled: boolean, actor: string = 'system'): WorkgraphRuntimeConfig {
  const config = loadRuntimeConfig(workspacePath);
  if (config.safety.emergencyStop === enabled) return config;
  config.safety.emergencyStop = enabled;
  saveRuntimeConfig(workspacePath, config);
  appendSafetyEvent(workspacePath, actor, enabled ? 'kill-switch-paused' : 'kill-switch-resumed', {
    emergency_stop: enabled,
  });
  return config;
}

export function assertAutomatedDispatchAllowed(workspacePath: string, input: SafetyDispatchGuardInput): void {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const actor = input.actor ?? 'system';
  const config = loadRuntimeConfig(workspacePath);
  const state = loadSafetyState(workspacePath);

  if (config.safety.emergencyStop) {
    appendSafetyEvent(workspacePath, actor, 'dispatch-blocked-kill-switch', {
      source: input.source,
      agent: input.agent,
      trigger_path: input.triggerPath,
      ts: nowIso,
    });
    throw new Error('Safety kill switch is enabled; automated dispatch is paused.');
  }

  const agentState = getOrCreateRateLimitState(state, input.agent);
  pruneRateLimitTimestamps(agentState, now);
  const minuteCount = countSince(agentState.dispatchTimestamps, now.getTime() - 60_000);
  const hourCount = countSince(agentState.dispatchTimestamps, now.getTime() - 60 * 60_000);
  const activeRuns = countActiveRunsByActor(workspacePath, input.agent);
  const limits = config.safety.rateLimiting;

  if (minuteCount >= limits.maxDispatchesPerMinutePerAgent) {
    appendSafetyEvent(workspacePath, actor, 'dispatch-blocked-rate-limit-minute', {
      source: input.source,
      agent: input.agent,
      trigger_path: input.triggerPath,
      max_dispatches_per_minute_per_agent: limits.maxDispatchesPerMinutePerAgent,
      dispatches_last_minute: minuteCount,
      ts: nowIso,
    });
    throw new Error(
      `Rate limit exceeded for agent "${input.agent}": max ${limits.maxDispatchesPerMinutePerAgent} dispatches/minute.`,
    );
  }
  if (hourCount >= limits.maxDispatchesPerHourPerAgent) {
    appendSafetyEvent(workspacePath, actor, 'dispatch-blocked-rate-limit-hour', {
      source: input.source,
      agent: input.agent,
      trigger_path: input.triggerPath,
      max_dispatches_per_hour_per_agent: limits.maxDispatchesPerHourPerAgent,
      dispatches_last_hour: hourCount,
      ts: nowIso,
    });
    throw new Error(
      `Rate limit exceeded for agent "${input.agent}": max ${limits.maxDispatchesPerHourPerAgent} dispatches/hour.`,
    );
  }
  if (activeRuns >= limits.maxConcurrentRunsPerAgent) {
    appendSafetyEvent(workspacePath, actor, 'dispatch-blocked-concurrency-limit', {
      source: input.source,
      agent: input.agent,
      trigger_path: input.triggerPath,
      max_concurrent_runs_per_agent: limits.maxConcurrentRunsPerAgent,
      active_runs: activeRuns,
      ts: nowIso,
    });
    throw new Error(
      `Concurrent run limit exceeded for agent "${input.agent}": max ${limits.maxConcurrentRunsPerAgent} active runs.`,
    );
  }

  agentState.dispatchTimestamps.push(nowIso);
  state.updatedAt = nowIso;
  saveSafetyState(workspacePath, state);
}

export function recordSafetyOutcome(workspacePath: string, input: SafetyOutcomeInput): void {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const state = loadSafetyState(workspacePath);
  const threshold = loadRuntimeConfig(workspacePath).safety.circuitBreaker.maxConsecutiveFailures;
  const actor = input.actor ?? 'system';

  if (input.success) {
    let changed = false;
    if (input.agent) {
      const agentCounter = getOrCreateCounter(state.circuitBreaker.agents, input.agent);
      if (agentCounter.consecutiveFailures > 0 || agentCounter.openedAt) {
        agentCounter.consecutiveFailures = 0;
        agentCounter.lastError = undefined;
        agentCounter.openedAt = undefined;
        changed = true;
      }
    }
    if (input.triggerPath) {
      const triggerCounter = getOrCreateCounter(state.circuitBreaker.triggers, input.triggerPath);
      if (triggerCounter.consecutiveFailures > 0 || triggerCounter.openedAt) {
        triggerCounter.consecutiveFailures = 0;
        triggerCounter.lastError = undefined;
        triggerCounter.openedAt = undefined;
        triggerCounter.autoDisabled = false;
        changed = true;
      }
    }
    if (changed) {
      state.updatedAt = nowIso;
      saveSafetyState(workspacePath, state);
    }
    return;
  }

  if (input.agent) {
    const agentCounter = getOrCreateCounter(state.circuitBreaker.agents, input.agent);
    incrementCounter(agentCounter, nowIso, input.error, threshold);
    appendSafetyEvent(workspacePath, actor, 'circuit-breaker-agent-failure', {
      source: input.source,
      agent: input.agent,
      consecutive_failures: agentCounter.consecutiveFailures,
      total_failures: agentCounter.totalFailures,
      threshold,
      open: isCounterOpen(agentCounter, threshold),
      error: input.error,
    });
  }

  if (input.triggerPath) {
    const triggerCounter = getOrCreateCounter(state.circuitBreaker.triggers, input.triggerPath);
    incrementCounter(triggerCounter, nowIso, input.error, threshold);
    appendSafetyEvent(workspacePath, actor, 'circuit-breaker-trigger-failure', {
      source: input.source,
      trigger_path: input.triggerPath,
      agent: input.agent,
      consecutive_failures: triggerCounter.consecutiveFailures,
      total_failures: triggerCounter.totalFailures,
      threshold,
      open: isCounterOpen(triggerCounter, threshold),
      error: input.error,
    });

    if (isCounterOpen(triggerCounter, threshold)) {
      const autoDisabled = disableTriggerForCircuitBreaker(workspacePath, input.triggerPath, actor, triggerCounter.consecutiveFailures);
      if (autoDisabled) {
        triggerCounter.autoDisabled = true;
      }
    }
  }

  state.updatedAt = nowIso;
  saveSafetyState(workspacePath, state);
}

export function safetyStatus(workspacePath: string): SafetyStatusSnapshot {
  const generatedAt = new Date().toISOString();
  const config = loadRuntimeConfig(workspacePath);
  const state = loadSafetyState(workspacePath);
  const threshold = config.safety.circuitBreaker.maxConsecutiveFailures;
  const activeRuns = loadActiveRunCountByActor(workspacePath);
  const agents = new Set<string>([
    ...Object.keys(state.rateLimiting.agents),
    ...Object.keys(state.circuitBreaker.agents),
    ...Object.keys(activeRuns),
  ]);

  const usageByAgent = [...agents]
    .sort((a, b) => a.localeCompare(b))
    .map((agent) => {
      const rateState = state.rateLimiting.agents[agent] ?? { dispatchTimestamps: [] };
      const nowMs = Date.now();
      const dispatchesLastMinute = countSince(rateState.dispatchTimestamps, nowMs - 60_000);
      const dispatchesLastHour = countSince(rateState.dispatchTimestamps, nowMs - 60 * 60_000);
      const currentActiveRuns = activeRuns[agent] ?? 0;
      return {
        agent,
        dispatchesLastMinute,
        dispatchesLastHour,
        activeRuns: currentActiveRuns,
        rateLimited:
          dispatchesLastMinute >= config.safety.rateLimiting.maxDispatchesPerMinutePerAgent
          || dispatchesLastHour >= config.safety.rateLimiting.maxDispatchesPerHourPerAgent,
        concurrencyLimited: currentActiveRuns >= config.safety.rateLimiting.maxConcurrentRunsPerAgent,
      };
    });

  const triggerCounters = Object.entries(state.circuitBreaker.triggers)
    .map(([triggerPath, counter]) => ({
      triggerPath,
      ...counter,
      open: isCounterOpen(counter, threshold),
    }))
    .sort((a, b) => a.triggerPath.localeCompare(b.triggerPath));

  const agentCounters = Object.entries(state.circuitBreaker.agents)
    .map(([agent, counter]) => ({
      agent,
      ...counter,
      open: isCounterOpen(counter, threshold),
    }))
    .sort((a, b) => a.agent.localeCompare(b.agent));

  return {
    generatedAt,
    configPath: WORKGRAPH_RUNTIME_CONFIG_FILE,
    statePath: SAFETY_STATE_FILE,
    emergencyStop: config.safety.emergencyStop,
    rateLimiting: {
      ...config.safety.rateLimiting,
      usageByAgent,
    },
    circuitBreaker: {
      threshold,
      agents: agentCounters,
      triggers: triggerCounters,
    },
  };
}

export function resetSafetyCircuit(workspacePath: string, target: string, actor: string = 'system'): SafetyResetResult {
  const state = loadSafetyState(workspacePath);
  const normalized = String(target ?? '').trim();
  if (!normalized) {
    throw new Error('Reset target is required. Expected agent name or trigger path.');
  }

  const targetType = inferResetTargetType(normalized);
  let reset = false;
  let reEnabledTrigger = false;

  if (targetType === 'agent') {
    const counter = state.circuitBreaker.agents[normalized];
    if (counter) {
      counter.consecutiveFailures = 0;
      counter.lastError = undefined;
      counter.openedAt = undefined;
      reset = true;
    }
    appendSafetyEvent(workspacePath, actor, 'circuit-breaker-reset-agent', {
      agent: normalized,
      reset,
    });
  } else {
    const counter = state.circuitBreaker.triggers[normalized];
    if (counter) {
      counter.consecutiveFailures = 0;
      counter.lastError = undefined;
      counter.openedAt = undefined;
      counter.autoDisabled = false;
      reset = true;
    }
    reEnabledTrigger = reEnableTriggerIfDisabled(workspacePath, normalized, actor);
    appendSafetyEvent(workspacePath, actor, 'circuit-breaker-reset-trigger', {
      trigger_path: normalized,
      reset,
      re_enabled: reEnabledTrigger,
    });
  }

  state.updatedAt = new Date().toISOString();
  saveSafetyState(workspacePath, state);

  return {
    targetType,
    target: normalized,
    reset,
    reEnabledTrigger,
  };
}

export function readSafetyLog(workspacePath: string, query: SafetyLogQuery = {}): SafetyLogEntry[] {
  const entries = ledger.query(workspacePath, {
    type: 'safety',
    since: query.since,
  });
  let mapped = entries
    .map((entry) => {
      const details = isRecord(entry.data) ? entry.data : {};
      return {
        ts: entry.ts,
        actor: entry.actor,
        op: entry.op,
        target: entry.target,
        event: asString(details.event) ?? 'unknown',
        source: asString(details.source),
        agent: asString(details.agent),
        triggerPath: asString(details.trigger_path),
        details,
      } satisfies SafetyLogEntry;
    });

  if (query.agent) {
    mapped = mapped.filter((entry) => entry.agent === query.agent || entry.actor === query.agent);
  }
  if (typeof query.limit === 'number' && query.limit > 0) {
    mapped = mapped.slice(-Math.trunc(query.limit));
  }
  return mapped;
}

export function loadSafetyState(workspacePath: string): WorkgraphSafetyState {
  const targetPath = safetyStatePath(workspacePath);
  if (!fs.existsSync(targetPath)) {
    const seeded = seedSafetyState();
    saveSafetyState(workspacePath, seeded);
    return seeded;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(targetPath, 'utf-8')) as Partial<WorkgraphSafetyState>;
    const normalized = normalizeSafetyState(parsed);
    saveSafetyState(workspacePath, normalized);
    return normalized;
  } catch {
    const seeded = seedSafetyState();
    saveSafetyState(workspacePath, seeded);
    return seeded;
  }
}

export function saveSafetyState(workspacePath: string, state: WorkgraphSafetyState): void {
  const targetPath = safetyStatePath(workspacePath);
  const directory = path.dirname(targetPath);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

function normalizeRuntimeConfig(raw: unknown): WorkgraphRuntimeConfig {
  const root = isRecord(raw) ? raw : {};
  const safety = isRecord(root.safety) ? root.safety : {};
  const rate = isRecord(safety.rate_limiting) ? safety.rate_limiting : {};
  const circuit = isRecord(safety.circuit_breaker) ? safety.circuit_breaker : {};
  return {
    version: normalizeInt(root.version, WORKGRAPH_RUNTIME_CONFIG_VERSION, 1),
    safety: {
      emergencyStop: normalizeBool(safety.emergency_stop, false),
      rateLimiting: {
        maxDispatchesPerMinutePerAgent: normalizeInt(
          rate.max_dispatches_per_minute_per_agent,
          DEFAULT_RATE_LIMITS.maxDispatchesPerMinutePerAgent,
          1,
        ),
        maxDispatchesPerHourPerAgent: normalizeInt(
          rate.max_dispatches_per_hour_per_agent,
          DEFAULT_RATE_LIMITS.maxDispatchesPerHourPerAgent,
          1,
        ),
        maxConcurrentRunsPerAgent: normalizeInt(
          rate.max_concurrent_runs_per_agent,
          DEFAULT_RATE_LIMITS.maxConcurrentRunsPerAgent,
          1,
        ),
      },
      circuitBreaker: {
        maxConsecutiveFailures: normalizeInt(
          circuit.max_consecutive_failures,
          DEFAULT_CIRCUIT_BREAKER.maxConsecutiveFailures,
          1,
        ),
        autoDisableTrigger: normalizeBool(
          circuit.auto_disable_trigger,
          DEFAULT_CIRCUIT_BREAKER.autoDisableTrigger,
        ),
      },
    },
  };
}

function defaultRuntimeConfig(): WorkgraphRuntimeConfig {
  return {
    version: WORKGRAPH_RUNTIME_CONFIG_VERSION,
    safety: {
      emergencyStop: false,
      rateLimiting: { ...DEFAULT_RATE_LIMITS },
      circuitBreaker: { ...DEFAULT_CIRCUIT_BREAKER },
    },
  };
}

function seedSafetyState(): WorkgraphSafetyState {
  return {
    version: SAFETY_STATE_VERSION,
    updatedAt: new Date(0).toISOString(),
    rateLimiting: {
      agents: {},
    },
    circuitBreaker: {
      agents: {},
      triggers: {},
    },
  };
}

function normalizeSafetyState(raw: Partial<WorkgraphSafetyState>): WorkgraphSafetyState {
  const fallback = seedSafetyState();
  const normalized: WorkgraphSafetyState = {
    version: normalizeInt(raw.version, SAFETY_STATE_VERSION, 1),
    updatedAt: asString(raw.updatedAt) ?? fallback.updatedAt,
    rateLimiting: {
      agents: {},
    },
    circuitBreaker: {
      agents: {},
      triggers: {},
    },
  };

  const rawRateAgents = isRecord(raw.rateLimiting?.agents) ? raw.rateLimiting?.agents : {};
  for (const [agent, value] of Object.entries(rawRateAgents)) {
    const record: Record<string, unknown> = isRecord(value) ? value : {};
    const timestamps = Array.isArray(record.dispatchTimestamps)
      ? record.dispatchTimestamps.map((entry: unknown) => String(entry)).filter(Boolean)
      : [];
    normalized.rateLimiting.agents[agent] = {
      dispatchTimestamps: pruneDispatchHistory(timestamps),
    };
  }

  const rawAgentCounters = isRecord(raw.circuitBreaker?.agents) ? raw.circuitBreaker?.agents : {};
  for (const [agent, value] of Object.entries(rawAgentCounters)) {
    normalized.circuitBreaker.agents[agent] = normalizeCounter(value);
  }
  const rawTriggerCounters = isRecord(raw.circuitBreaker?.triggers) ? raw.circuitBreaker?.triggers : {};
  for (const [triggerPath, value] of Object.entries(rawTriggerCounters)) {
    normalized.circuitBreaker.triggers[triggerPath] = normalizeCounter(value);
  }
  return normalized;
}

function normalizeCounter(raw: unknown): SafetyCircuitCounter {
  const value = isRecord(raw) ? raw : {};
  return {
    consecutiveFailures: normalizeInt(value.consecutiveFailures, 0, 0),
    totalFailures: normalizeInt(value.totalFailures, 0, 0),
    lastFailureAt: asString(value.lastFailureAt),
    lastError: asString(value.lastError),
    openedAt: asString(value.openedAt),
    autoDisabled: normalizeBool(value.autoDisabled, false),
  };
}

function getOrCreateRateLimitState(state: WorkgraphSafetyState, agent: string): SafetyRateLimitAgentState {
  if (!state.rateLimiting.agents[agent]) {
    state.rateLimiting.agents[agent] = { dispatchTimestamps: [] };
  }
  return state.rateLimiting.agents[agent]!;
}

function pruneRateLimitTimestamps(rateState: SafetyRateLimitAgentState, now: Date): void {
  const cutoffMs = now.getTime() - 60 * 60_000;
  rateState.dispatchTimestamps = rateState.dispatchTimestamps
    .filter((ts) => {
      const parsed = Date.parse(ts);
      return Number.isFinite(parsed) && parsed >= cutoffMs;
    })
    .sort((a, b) => a.localeCompare(b));
}

function pruneDispatchHistory(values: string[]): string[] {
  const cutoffMs = Date.now() - 24 * 60 * 60_000;
  return values
    .filter((value) => {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) && parsed >= cutoffMs;
    })
    .sort((a, b) => a.localeCompare(b));
}

function countSince(timestamps: string[], cutoffMs: number): number {
  let count = 0;
  for (const ts of timestamps) {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed) && parsed >= cutoffMs) count += 1;
  }
  return count;
}

function getOrCreateCounter(
  counters: Record<string, SafetyCircuitCounter>,
  key: string,
): SafetyCircuitCounter {
  if (!counters[key]) {
    counters[key] = {
      consecutiveFailures: 0,
      totalFailures: 0,
    };
  }
  return counters[key]!;
}

function incrementCounter(
  counter: SafetyCircuitCounter,
  at: string,
  error: string | undefined,
  threshold: number,
): void {
  counter.consecutiveFailures += 1;
  counter.totalFailures += 1;
  counter.lastFailureAt = at;
  counter.lastError = error;
  if (counter.consecutiveFailures >= threshold && !counter.openedAt) {
    counter.openedAt = at;
  }
}

function isCounterOpen(counter: SafetyCircuitCounter, threshold: number): boolean {
  return counter.consecutiveFailures >= threshold;
}

function countActiveRunsByActor(workspacePath: string, actor: string): number {
  const all = loadActiveRunCountByActor(workspacePath);
  return all[actor] ?? 0;
}

function loadActiveRunCountByActor(workspacePath: string): Record<string, number> {
  const runsPath = path.join(workspacePath, DISPATCH_RUNS_FILE);
  if (!fs.existsSync(runsPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(runsPath, 'utf-8')) as {
      runs?: Array<Record<string, unknown>>;
    };
    const runs = Array.isArray(parsed.runs) ? parsed.runs : [];
    const counts: Record<string, number> = {};
    for (const run of runs) {
      const status = asString(run.status)?.toLowerCase();
      if (status !== 'queued' && status !== 'running') continue;
      const actor = asString(run.actor);
      if (!actor) continue;
      counts[actor] = (counts[actor] ?? 0) + 1;
    }
    return counts;
  } catch {
    return {};
  }
}

function disableTriggerForCircuitBreaker(
  workspacePath: string,
  triggerPath: string,
  actor: string,
  consecutiveFailures: number,
): boolean {
  const config = loadRuntimeConfig(workspacePath);
  if (!config.safety.circuitBreaker.autoDisableTrigger) return false;

  const trigger = store.read(workspacePath, triggerPath);
  if (!trigger || trigger.type !== 'trigger') return false;
  const status = asString(trigger.fields.status)?.toLowerCase() ?? 'draft';
  if (status === 'paused') return false;

  store.update(
    workspacePath,
    triggerPath,
    {
      status: 'paused',
      safety_disabled_reason: 'circuit_breaker',
      safety_disabled_at: new Date().toISOString(),
      safety_disabled_failures: consecutiveFailures,
    },
    undefined,
    actor,
  );
  appendSafetyEvent(workspacePath, actor, 'circuit-breaker-trigger-auto-disabled', {
    trigger_path: triggerPath,
    consecutive_failures: consecutiveFailures,
  });
  return true;
}

function reEnableTriggerIfDisabled(workspacePath: string, triggerPath: string, actor: string): boolean {
  const trigger = store.read(workspacePath, triggerPath);
  if (!trigger || trigger.type !== 'trigger') return false;
  const status = asString(trigger.fields.status)?.toLowerCase();
  const reason = asString(trigger.fields.safety_disabled_reason);
  if (status !== 'paused' || reason !== 'circuit_breaker') return false;
  store.update(
    workspacePath,
    triggerPath,
    {
      status: 'active',
      safety_disabled_reason: undefined,
      safety_disabled_at: undefined,
      safety_disabled_failures: undefined,
    },
    undefined,
    actor,
  );
  return true;
}

function appendSafetyEvent(
  workspacePath: string,
  actor: string,
  event: string,
  details: Record<string, unknown>,
): void {
  ledger.append(
    workspacePath,
    actor,
    'update',
    '.workgraph/safety',
    'safety',
    {
      event,
      ...details,
    },
  );
}

function inferResetTargetType(value: string): 'agent' | 'trigger' {
  if (
    value.includes('/')
    || value.endsWith('.md')
    || value.startsWith('[[')
    || value.startsWith('triggers/')
  ) {
    return 'trigger';
  }
  return 'agent';
}

function normalizeInt(value: unknown, fallback: number, minimum: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(minimum, Math.trunc(value));
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(minimum, Math.trunc(parsed));
  }
  return fallback;
}

function normalizeBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return fallback;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
