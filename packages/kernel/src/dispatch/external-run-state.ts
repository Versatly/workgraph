import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type {
  DispatchRun,
  DispatchRunDispatchTracking,
  DispatchRunExternalIdentity,
  RunStatus,
} from '../types.js';

const DISPATCH_BROKER_DIRECTORY = '.workgraph/dispatch-broker';

export interface DispatchRunBrokerState {
  runId: string;
  external?: DispatchRunExternalIdentity;
  tracking: DispatchRunDispatchTracking;
  updatedAt: string;
}

export interface FindBrokerStateInput {
  runId?: string;
  provider?: string;
  externalRunId?: string;
  correlationKeys?: string[];
}

export function dispatchBrokerStatePath(workspacePath: string, runId: string): string {
  return path.join(workspacePath, DISPATCH_BROKER_DIRECTORY, `${runId}.md`);
}

export function readDispatchBrokerState(
  workspacePath: string,
  runId: string,
): DispatchRunBrokerState | null {
  const filePath = dispatchBrokerStatePath(workspacePath, runId);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = matter(fs.readFileSync(filePath, 'utf-8'));
    return normalizeBrokerState({
      runId,
      ...asRecord(parsed.data),
    });
  } catch {
    return null;
  }
}

export function listDispatchBrokerStates(workspacePath: string): DispatchRunBrokerState[] {
  const directory = path.join(workspacePath, DISPATCH_BROKER_DIRECTORY);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => readDispatchBrokerState(workspacePath, entry.slice(0, -3)))
    .filter((entry): entry is DispatchRunBrokerState => entry !== null)
    .sort((left, right) => left.runId.localeCompare(right.runId));
}

export function writeDispatchBrokerState(
  workspacePath: string,
  input: DispatchRunBrokerState,
): DispatchRunBrokerState {
  const state = normalizeBrokerState(input);
  const filePath = dispatchBrokerStatePath(workspacePath, state.runId);
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const content = matter.stringify(renderBrokerStateBody(state), {
    run_id: state.runId,
    ...(state.external ? { external: stripUndefined(state.external) } : {}),
    dispatch_tracking: stripUndefined(state.tracking),
    updated_at: state.updatedAt,
  });
  fs.writeFileSync(filePath, content, 'utf-8');
  return state;
}

export function updateDispatchBrokerState(
  workspacePath: string,
  runId: string,
  updater: (current: DispatchRunBrokerState | null) => DispatchRunBrokerState | null,
): DispatchRunBrokerState | null {
  const current = readDispatchBrokerState(workspacePath, runId);
  const next = updater(current);
  if (!next) return null;
  return writeDispatchBrokerState(workspacePath, next);
}

export function findDispatchBrokerState(
  workspacePath: string,
  input: FindBrokerStateInput,
): DispatchRunBrokerState | null {
  if (input.runId) {
    return readDispatchBrokerState(workspacePath, input.runId);
  }
  const desiredProvider = normalizeOptionalString(input.provider);
  const desiredExternalRunId = normalizeOptionalString(input.externalRunId);
  const desiredCorrelationKeys = new Set(
    (input.correlationKeys ?? [])
      .map((entry) => String(entry).trim())
      .filter(Boolean),
  );
  if (!desiredProvider && !desiredExternalRunId && desiredCorrelationKeys.size === 0) {
    return null;
  }
  for (const candidate of listDispatchBrokerStates(workspacePath)) {
    const external = candidate.external;
    if (!external) continue;
    if (desiredProvider && external.provider !== desiredProvider) continue;
    if (desiredExternalRunId && external.externalRunId === desiredExternalRunId) {
      return candidate;
    }
    if (desiredCorrelationKeys.size > 0) {
      const keys = new Set(external.correlationKeys ?? []);
      for (const key of desiredCorrelationKeys) {
        if (keys.has(key)) return candidate;
      }
    }
  }
  return null;
}

export function hydrateRunWithDispatchBrokerState(
  run: DispatchRun,
  brokerState: DispatchRunBrokerState | null,
): DispatchRun {
  if (!brokerState) {
    return {
      ...run,
      dispatchTracking: normalizeDispatchTracking(run.dispatchTracking),
    };
  }
  return {
    ...run,
    external: mergeExternalIdentity(run.external, brokerState.external),
    dispatchTracking: mergeDispatchTracking(run.dispatchTracking, brokerState.tracking),
  };
}

export function isBrokeredRun(run: DispatchRun): boolean {
  return Boolean(run.external?.provider || run.dispatchTracking?.dispatchedAt);
}

export function mergeExternalIdentity(
  current: DispatchRunExternalIdentity | undefined,
  incoming: DispatchRunExternalIdentity | undefined,
): DispatchRunExternalIdentity | undefined {
  if (!current && !incoming) return undefined;
  if (!current) return normalizeExternalIdentity(incoming);
  if (!incoming) return normalizeExternalIdentity(current);
  const correlationKeys = [...new Set([
    ...(current.correlationKeys ?? []),
    ...(incoming.correlationKeys ?? []),
  ])];
  return {
    provider: incoming.provider || current.provider,
    externalRunId: incoming.externalRunId || current.externalRunId,
    externalAgentId: incoming.externalAgentId ?? current.externalAgentId,
    externalThreadId: incoming.externalThreadId ?? current.externalThreadId,
    ...(correlationKeys.length > 0 ? { correlationKeys } : {}),
    metadata: {
      ...(current.metadata ?? {}),
      ...(incoming.metadata ?? {}),
    },
    lastKnownStatus: incoming.lastKnownStatus ?? current.lastKnownStatus,
    lastKnownAt: incoming.lastKnownAt ?? current.lastKnownAt,
  };
}

export function mergeDispatchTracking(
  current: Partial<DispatchRunDispatchTracking> | DispatchRunDispatchTracking | undefined,
  incoming: Partial<DispatchRunDispatchTracking> | DispatchRunDispatchTracking | undefined,
): DispatchRunDispatchTracking {
  const normalizedCurrent = normalizeDispatchTracking(current);
  const normalizedIncoming = normalizeDispatchTracking(incoming);
  return {
    dispatchedAt: normalizedIncoming.dispatchedAt ?? normalizedCurrent.dispatchedAt,
    lastSentAt: normalizedIncoming.lastSentAt ?? normalizedCurrent.lastSentAt,
    outboundPayloadDigest: normalizedIncoming.outboundPayloadDigest ?? normalizedCurrent.outboundPayloadDigest,
    acknowledged: normalizedIncoming.acknowledged ?? normalizedCurrent.acknowledged,
    acknowledgedAt: normalizedIncoming.acknowledgedAt ?? normalizedCurrent.acknowledgedAt,
    retryCount: Math.max(normalizedCurrent.retryCount, normalizedIncoming.retryCount),
    lastReconciledAt: normalizedIncoming.lastReconciledAt ?? normalizedCurrent.lastReconciledAt,
    reconciliationError: normalizedIncoming.reconciliationError ?? normalizedCurrent.reconciliationError,
    cancellationRequestedAt: normalizedIncoming.cancellationRequestedAt ?? normalizedCurrent.cancellationRequestedAt,
    cancellationAcknowledgedAt: normalizedIncoming.cancellationAcknowledgedAt ?? normalizedCurrent.cancellationAcknowledgedAt,
  };
}

export function normalizeDispatchTracking(
  tracking: Partial<DispatchRunDispatchTracking> | DispatchRunDispatchTracking | undefined,
): DispatchRunDispatchTracking {
  return {
    dispatchedAt: normalizeOptionalString(tracking?.dispatchedAt),
    lastSentAt: normalizeOptionalString(tracking?.lastSentAt),
    outboundPayloadDigest: normalizeOptionalString(tracking?.outboundPayloadDigest),
    acknowledged: tracking?.acknowledged === true ? true : undefined,
    acknowledgedAt: normalizeOptionalString(tracking?.acknowledgedAt),
    retryCount: typeof tracking?.retryCount === 'number' && Number.isFinite(tracking.retryCount)
      ? Math.max(0, Math.trunc(tracking.retryCount))
      : 0,
    lastReconciledAt: normalizeOptionalString(tracking?.lastReconciledAt),
    reconciliationError: normalizeOptionalString(tracking?.reconciliationError),
    cancellationRequestedAt: normalizeOptionalString(tracking?.cancellationRequestedAt),
    cancellationAcknowledgedAt: normalizeOptionalString(tracking?.cancellationAcknowledgedAt),
  };
}

export function normalizeExternalIdentity(
  external: DispatchRunExternalIdentity | undefined,
): DispatchRunExternalIdentity | undefined {
  if (!external) return undefined;
  const provider = normalizeOptionalString(external.provider);
  const externalRunId = normalizeOptionalString(external.externalRunId);
  if (!provider || !externalRunId) return undefined;
  const correlationKeys = (external.correlationKeys ?? [])
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  return {
    provider,
    externalRunId,
    externalAgentId: normalizeOptionalString(external.externalAgentId),
    externalThreadId: normalizeOptionalString(external.externalThreadId),
    ...(correlationKeys.length > 0 ? { correlationKeys: [...new Set(correlationKeys)] } : {}),
    ...(isRecord(external.metadata) ? { metadata: external.metadata } : {}),
    lastKnownStatus: normalizeRunStatus(external.lastKnownStatus),
    lastKnownAt: normalizeOptionalString(external.lastKnownAt),
  };
}

function normalizeBrokerState(value: unknown): DispatchRunBrokerState {
  const root = asRecord(value);
  const runId = normalizeOptionalString(root.runId) ?? normalizeOptionalString(root.run_id) ?? 'unknown';
  const trackingRoot = asRecord(root.dispatch_tracking ?? root.tracking);
  return {
    runId,
    external: normalizeExternalIdentity(asRecord(root.external) as unknown as DispatchRunExternalIdentity | undefined),
    tracking: normalizeDispatchTracking(trackingRoot as unknown as DispatchRunDispatchTracking),
    updatedAt: normalizeOptionalString(root.updatedAt) ?? normalizeOptionalString(root.updated_at) ?? new Date().toISOString(),
  };
}

function renderBrokerStateBody(state: DispatchRunBrokerState): string {
  const lines = [
    '## External run broker state',
    '',
    `Run: ${state.runId}`,
    `Updated: ${state.updatedAt}`,
    '',
    '## External',
    '',
  ];
  if (state.external) {
    lines.push(`Provider: ${state.external.provider}`);
    lines.push(`External run id: ${state.external.externalRunId}`);
    lines.push(`Last known status: ${state.external.lastKnownStatus ?? 'unknown'}`);
    lines.push(`Last known at: ${state.external.lastKnownAt ?? 'unknown'}`);
    if ((state.external.correlationKeys ?? []).length > 0) {
      lines.push(`Correlation keys: ${(state.external.correlationKeys ?? []).join(', ')}`);
    }
  } else {
    lines.push('No external identity recorded.');
  }
  lines.push('');
  lines.push('## Dispatch tracking');
  lines.push('');
  lines.push(`Dispatched at: ${state.tracking.dispatchedAt ?? 'n/a'}`);
  lines.push(`Last sent at: ${state.tracking.lastSentAt ?? 'n/a'}`);
  lines.push(`Acknowledged: ${state.tracking.acknowledged === true ? 'yes' : 'no'}`);
  lines.push(`Acknowledged at: ${state.tracking.acknowledgedAt ?? 'n/a'}`);
  lines.push(`Retry count: ${state.tracking.retryCount}`);
  lines.push(`Last reconciled at: ${state.tracking.lastReconciledAt ?? 'n/a'}`);
  lines.push(`Reconciliation error: ${state.tracking.reconciliationError ?? 'n/a'}`);
  lines.push(`Cancellation requested at: ${state.tracking.cancellationRequestedAt ?? 'n/a'}`);
  lines.push(`Cancellation acknowledged at: ${state.tracking.cancellationAcknowledgedAt ?? 'n/a'}`);
  return `${lines.join('\n')}\n`;
}

function normalizeRunStatus(value: unknown): RunStatus | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (
    normalized === 'queued'
    || normalized === 'running'
    || normalized === 'succeeded'
    || normalized === 'failed'
    || normalized === 'cancelled'
  ) {
    return normalized;
  }
  return undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .map((entry) => stripUndefined(entry))
      .filter((entry) => entry !== undefined) as T;
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const cleaned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined) continue;
    cleaned[key] = stripUndefined(entry);
  }
  return cleaned as T;
}
