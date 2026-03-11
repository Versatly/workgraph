import path from 'node:path';
import {
  TRANSPORT_ROOT,
  listTransportRecordFiles,
  normalizeAttemptArray,
  normalizeAttemptStatus,
  normalizeString,
  normalizeTimestamp,
  readTransportRecord,
  renderJsonSection,
  writeTransportRecord,
  type TransportAttempt,
} from './_shared.js';
import { normalizeTransportEnvelope, type TransportEnvelope } from './envelope.js';
import { recordTransportDeadLetter } from './dead-letter.js';

const OUTBOX_DIRECTORY = 'outbox';

export interface TransportOutboxRecord {
  id: string;
  envelope: TransportEnvelope;
  deliveryHandler: string;
  deliveryTarget: string;
  status: 'pending' | 'delivered' | 'failed' | 'replayed';
  attempts: TransportAttempt[];
  deliveredAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTransportOutboxRecordInput {
  envelope: TransportEnvelope;
  deliveryHandler: string;
  deliveryTarget: string;
  message?: string;
}

export function transportOutboxPath(workspacePath: string, id: string): string {
  return path.join(workspacePath, TRANSPORT_ROOT, OUTBOX_DIRECTORY, `${id}.md`);
}

export function listTransportOutbox(workspacePath: string): TransportOutboxRecord[] {
  const directory = path.join(workspacePath, TRANSPORT_ROOT, OUTBOX_DIRECTORY);
  return listTransportRecordFiles(directory)
    .map((filePath) => readTransportRecord(filePath, normalizeTransportOutboxRecord))
    .filter((record): record is TransportOutboxRecord => record !== null);
}

export function readTransportOutboxRecord(
  workspacePath: string,
  id: string,
): TransportOutboxRecord | null {
  return readTransportRecord(transportOutboxPath(workspacePath, id), normalizeTransportOutboxRecord);
}

export function createTransportOutboxRecord(
  workspacePath: string,
  input: CreateTransportOutboxRecordInput,
): TransportOutboxRecord {
  const now = new Date().toISOString();
  const record: TransportOutboxRecord = {
    id: `out_${input.envelope.id}`,
    envelope: normalizeTransportEnvelope(input.envelope),
    deliveryHandler: normalizeRequiredString(input.deliveryHandler, 'Transport outbox delivery handler is required.'),
    deliveryTarget: normalizeRequiredString(input.deliveryTarget, 'Transport outbox delivery target is required.'),
    status: 'pending',
    attempts: [
      {
        ts: now,
        status: 'pending',
        ...(normalizeString(input.message) ? { message: normalizeString(input.message) } : {}),
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  writeTransportOutboxRecord(workspacePath, record);
  return record;
}

export function markTransportOutboxDelivered(
  workspacePath: string,
  id: string,
  message?: string,
): TransportOutboxRecord | null {
  const existing = readTransportOutboxRecord(workspacePath, id);
  if (!existing) return null;
  const now = new Date().toISOString();
  const updated: TransportOutboxRecord = {
    ...existing,
    status: existing.status === 'replayed' ? 'replayed' : 'delivered',
    deliveredAt: now,
    updatedAt: now,
    attempts: [
      ...existing.attempts,
      {
        ts: now,
        status: 'delivered',
        ...(normalizeString(message) ? { message: normalizeString(message) } : {}),
      },
    ],
    lastError: undefined,
  };
  writeTransportOutboxRecord(workspacePath, updated);
  return updated;
}

export function markTransportOutboxFailed(
  workspacePath: string,
  id: string,
  error: { message: string; context?: Record<string, unknown> },
): TransportOutboxRecord | null {
  const existing = readTransportOutboxRecord(workspacePath, id);
  if (!existing) return null;
  const now = new Date().toISOString();
  const updated: TransportOutboxRecord = {
    ...existing,
    status: 'failed',
    updatedAt: now,
    attempts: [
      ...existing.attempts,
      {
        ts: now,
        status: 'failed',
        error: error.message,
      },
    ],
    lastError: error.message,
  };
  writeTransportOutboxRecord(workspacePath, updated);
  recordTransportDeadLetter(workspacePath, {
    sourceRecordType: 'outbox',
    sourceRecordId: updated.id,
    envelope: updated.envelope,
    attempts: updated.attempts,
    error: {
      message: error.message,
      ts: now,
      context: error.context,
    },
  });
  return updated;
}

export async function replayTransportOutboxRecord(
  workspacePath: string,
  id: string,
  deliver: (record: TransportOutboxRecord) => Promise<void> | void,
): Promise<TransportOutboxRecord | null> {
  const existing = readTransportOutboxRecord(workspacePath, id);
  if (!existing) return null;
  const replayStart = new Date().toISOString();
  const replaying: TransportOutboxRecord = {
    ...existing,
    status: 'replayed',
    updatedAt: replayStart,
    attempts: [
      ...existing.attempts,
      {
        ts: replayStart,
        status: 'replayed',
        message: 'Replay requested.',
      },
    ],
  };
  writeTransportOutboxRecord(workspacePath, replaying);
  try {
    await deliver(replaying);
    return markTransportOutboxDelivered(workspacePath, id, 'Replay delivered successfully.');
  } catch (error) {
    return markTransportOutboxFailed(workspacePath, id, {
      message: error instanceof Error ? error.message : String(error),
      context: {
        replay: true,
      },
    });
  }
}

function writeTransportOutboxRecord(workspacePath: string, record: TransportOutboxRecord): void {
  writeTransportRecord(
    transportOutboxPath(workspacePath, record.id),
    {
      id: record.id,
      envelope: record.envelope,
      delivery_handler: record.deliveryHandler,
      delivery_target: record.deliveryTarget,
      status: record.status,
      attempts: record.attempts,
      delivered_at: record.deliveredAt,
      last_error: record.lastError,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    },
    [
      renderJsonSection('Envelope', record.envelope),
      renderJsonSection('Attempts', record.attempts),
    ].join('\n'),
  );
}

function normalizeTransportOutboxRecord(frontmatter: Record<string, unknown>): TransportOutboxRecord {
  return {
    id: normalizeString(frontmatter.id) ?? 'unknown',
    envelope: normalizeTransportEnvelope(frontmatter.envelope),
    deliveryHandler: normalizeString(frontmatter.delivery_handler) ?? 'unknown',
    deliveryTarget: normalizeString(frontmatter.delivery_target) ?? 'unknown',
    status: normalizeAttemptStatus(frontmatter.status) ?? 'pending',
    attempts: normalizeAttemptArray(frontmatter.attempts),
    deliveredAt: normalizeString(frontmatter.delivered_at),
    lastError: normalizeString(frontmatter.last_error),
    createdAt: normalizeTimestamp(frontmatter.created_at),
    updatedAt: normalizeTimestamp(frontmatter.updated_at),
  };
}

function normalizeRequiredString(value: unknown, message: string): string {
  const normalized = normalizeString(value);
  if (!normalized) throw new Error(message);
  return normalized;
}
