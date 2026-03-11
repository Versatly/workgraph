import path from 'node:path';
import {
  TRANSPORT_ROOT,
  asRecord,
  listTransportRecordFiles,
  type TransportAttempt,
  normalizeAttemptArray,
  normalizeString,
  normalizeTimestamp,
  readTransportRecord,
  renderJsonSection,
  writeTransportRecord,
} from './_shared.js';
import { normalizeTransportEnvelope, type TransportEnvelope } from './envelope.js';

const DEAD_LETTER_DIRECTORY = 'dead-letter';

export interface TransportDeadLetterRecord {
  id: string;
  sourceRecordType: 'outbox' | 'inbox';
  sourceRecordId: string;
  status: 'failed' | 'replayed';
  envelope: TransportEnvelope;
  attempts: TransportAttempt[];
  error: {
    message: string;
    ts: string;
    context?: Record<string, unknown>;
  };
  replayedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecordTransportDeadLetterInput {
  sourceRecordType: 'outbox' | 'inbox';
  sourceRecordId: string;
  envelope: TransportEnvelope;
  attempts: TransportAttempt[];
  error: {
    message: string;
    ts?: string;
    context?: Record<string, unknown>;
  };
}

export function transportDeadLetterPath(workspacePath: string, id: string): string {
  return path.join(workspacePath, TRANSPORT_ROOT, DEAD_LETTER_DIRECTORY, `${id}.md`);
}

export function listTransportDeadLetters(workspacePath: string): TransportDeadLetterRecord[] {
  const directory = path.join(workspacePath, TRANSPORT_ROOT, DEAD_LETTER_DIRECTORY);
  return listTransportRecordFiles(directory)
    .map((filePath) => readTransportRecord(filePath, normalizeTransportDeadLetterRecord))
    .filter((record): record is TransportDeadLetterRecord => record !== null);
}

export function readTransportDeadLetter(
  workspacePath: string,
  id: string,
): TransportDeadLetterRecord | null {
  return readTransportRecord(transportDeadLetterPath(workspacePath, id), normalizeTransportDeadLetterRecord);
}

export function recordTransportDeadLetter(
  workspacePath: string,
  input: RecordTransportDeadLetterInput,
): TransportDeadLetterRecord {
  const now = new Date().toISOString();
  const record: TransportDeadLetterRecord = {
    id: `dlq_${input.sourceRecordId}`,
    sourceRecordType: input.sourceRecordType,
    sourceRecordId: input.sourceRecordId,
    status: 'failed',
    envelope: normalizeTransportEnvelope(input.envelope),
    attempts: input.attempts,
    error: {
      message: input.error.message,
      ts: input.error.ts ?? now,
      ...(input.error.context ? { context: input.error.context } : {}),
    },
    createdAt: now,
    updatedAt: now,
  };
  writeTransportDeadLetter(workspacePath, record);
  return record;
}

export function markTransportDeadLetterReplayed(
  workspacePath: string,
  id: string,
): TransportDeadLetterRecord | null {
  const existing = readTransportDeadLetter(workspacePath, id);
  if (!existing) return null;
  const updated: TransportDeadLetterRecord = {
    ...existing,
    status: 'replayed',
    replayedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeTransportDeadLetter(workspacePath, updated);
  return updated;
}

function writeTransportDeadLetter(workspacePath: string, record: TransportDeadLetterRecord): void {
  writeTransportRecord(
    transportDeadLetterPath(workspacePath, record.id),
    {
      id: record.id,
      source_record_type: record.sourceRecordType,
      source_record_id: record.sourceRecordId,
      status: record.status,
      envelope: record.envelope,
      attempts: record.attempts,
      error: record.error,
      replayed_at: record.replayedAt,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    },
    [
      renderJsonSection('Envelope', record.envelope),
      renderJsonSection('Attempts', record.attempts),
      renderJsonSection('Error', record.error),
    ].join('\n'),
  );
}

function normalizeTransportDeadLetterRecord(frontmatter: Record<string, unknown>): TransportDeadLetterRecord {
  const error = asRecord(frontmatter.error);
  return {
    id: normalizeString(frontmatter.id) ?? 'unknown',
    sourceRecordType: normalizeString(frontmatter.source_record_type) === 'inbox' ? 'inbox' : 'outbox',
    sourceRecordId: normalizeString(frontmatter.source_record_id) ?? 'unknown',
    status: normalizeString(frontmatter.status) === 'replayed' ? 'replayed' : 'failed',
    envelope: normalizeTransportEnvelope(frontmatter.envelope),
    attempts: normalizeAttemptArray(frontmatter.attempts),
    error: {
      message: normalizeString(error.message) ?? 'Unknown delivery error.',
      ts: normalizeTimestamp(error.ts),
      ...(asRecord(error.context) && Object.keys(asRecord(error.context)).length > 0
        ? { context: asRecord(error.context) }
        : {}),
    },
    replayedAt: normalizeString(frontmatter.replayed_at),
    createdAt: normalizeTimestamp(frontmatter.created_at),
    updatedAt: normalizeTimestamp(frontmatter.updated_at),
  };
}
