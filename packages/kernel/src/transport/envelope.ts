import { createHash, randomUUID } from 'node:crypto';
import {
  asRecord,
  normalizeString,
  normalizeStringArray,
  normalizeTimestamp,
} from './_shared.js';

export type TransportDirection = 'outbound' | 'inbound';

export interface TransportEnvelope {
  id: string;
  direction: TransportDirection;
  channel: string;
  topic: string;
  source: string;
  target: string;
  provider?: string;
  correlationId?: string;
  causationId?: string;
  dedupKeys: string[];
  payloadDigest: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface CreateTransportEnvelopeInput {
  direction: TransportDirection;
  channel: string;
  topic: string;
  source: string;
  target: string;
  provider?: string;
  correlationId?: string;
  causationId?: string;
  dedupKeys?: string[];
  payload?: Record<string, unknown>;
  createdAt?: string;
}

export function createTransportEnvelope(input: CreateTransportEnvelopeInput): TransportEnvelope {
  const payload = asRecord(input.payload);
  return {
    id: `trn_${randomUUID()}`,
    direction: input.direction,
    channel: normalizeRequiredString(input.channel, 'Transport channel is required.'),
    topic: normalizeRequiredString(input.topic, 'Transport topic is required.'),
    source: normalizeRequiredString(input.source, 'Transport source is required.'),
    target: normalizeRequiredString(input.target, 'Transport target is required.'),
    ...(normalizeString(input.provider) ? { provider: normalizeString(input.provider) } : {}),
    ...(normalizeString(input.correlationId) ? { correlationId: normalizeString(input.correlationId) } : {}),
    ...(normalizeString(input.causationId) ? { causationId: normalizeString(input.causationId) } : {}),
    dedupKeys: normalizeStringArray(input.dedupKeys ?? []),
    payloadDigest: createTransportPayloadDigest(payload),
    createdAt: normalizeTimestamp(input.createdAt),
    payload,
  };
}

export function normalizeTransportEnvelope(value: unknown): TransportEnvelope {
  const record = asRecord(value);
  const payload = asRecord(record.payload);
  return {
    id: normalizeRequiredString(record.id, 'Transport envelope id is required.'),
    direction: normalizeTransportDirection(record.direction),
    channel: normalizeRequiredString(record.channel, 'Transport envelope channel is required.'),
    topic: normalizeRequiredString(record.topic, 'Transport envelope topic is required.'),
    source: normalizeRequiredString(record.source, 'Transport envelope source is required.'),
    target: normalizeRequiredString(record.target, 'Transport envelope target is required.'),
    ...(normalizeString(record.provider) ? { provider: normalizeString(record.provider) } : {}),
    ...(normalizeString(record.correlationId) ? { correlationId: normalizeString(record.correlationId) } : {}),
    ...(normalizeString(record.causationId) ? { causationId: normalizeString(record.causationId) } : {}),
    dedupKeys: normalizeStringArray(record.dedupKeys),
    payloadDigest: normalizeRequiredString(record.payloadDigest, 'Transport envelope payload digest is required.'),
    createdAt: normalizeTimestamp(record.createdAt),
    payload,
  };
}

export function createTransportPayloadDigest(payload: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function normalizeRequiredString(value: unknown, message: string): string {
  const normalized = normalizeString(value);
  if (!normalized) throw new Error(message);
  return normalized;
}

function normalizeTransportDirection(value: unknown): TransportDirection {
  const normalized = normalizeString(value)?.toLowerCase();
  if (normalized === 'outbound' || normalized === 'inbound') return normalized;
  throw new Error(`Invalid transport direction "${String(value)}". Expected outbound|inbound.`);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((left, right) => left.localeCompare(right));
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}
