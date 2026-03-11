import path from 'node:path';
import {
  TRANSPORT_ROOT,
  listTransportRecordFiles,
  normalizeAttemptArray,
  normalizeString,
  normalizeStringArray,
  normalizeTimestamp,
  readTransportRecord,
  renderJsonSection,
  writeTransportRecord,
  type TransportAttempt,
} from './_shared.js';
import { normalizeTransportEnvelope, type TransportEnvelope } from './envelope.js';

const INBOX_DIRECTORY = 'inbox';

export interface TransportInboxRecord {
  id: string;
  envelope: TransportEnvelope;
  status: 'pending' | 'delivered' | 'failed' | 'replayed';
  dedupKeys: string[];
  attempts: TransportAttempt[];
  duplicateOf?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecordTransportInboxInput {
  envelope: TransportEnvelope;
  dedupKeys?: string[];
  message?: string;
}

export interface RecordTransportInboxResult {
  record: TransportInboxRecord;
  duplicate: boolean;
}

export function transportInboxPath(workspacePath: string, id: string): string {
  return path.join(workspacePath, TRANSPORT_ROOT, INBOX_DIRECTORY, `${id}.md`);
}

export function listTransportInbox(workspacePath: string): TransportInboxRecord[] {
  const directory = path.join(workspacePath, TRANSPORT_ROOT, INBOX_DIRECTORY);
  return listTransportRecordFiles(directory)
    .map((filePath) => readTransportRecord(filePath, normalizeTransportInboxRecord))
    .filter((record): record is TransportInboxRecord => record !== null);
}

export function readTransportInboxRecord(
  workspacePath: string,
  id: string,
): TransportInboxRecord | null {
  return readTransportRecord(transportInboxPath(workspacePath, id), normalizeTransportInboxRecord);
}

export function findTransportInboxDuplicate(
  workspacePath: string,
  dedupKeys: string[],
): TransportInboxRecord | null {
  if (dedupKeys.length === 0) return null;
  const desired = new Set(normalizeStringArray(dedupKeys));
  for (const record of listTransportInbox(workspacePath)) {
    const existing = new Set(record.dedupKeys);
    for (const key of desired) {
      if (existing.has(key)) return record;
    }
  }
  return null;
}

export function recordTransportInbox(
  workspacePath: string,
  input: RecordTransportInboxInput,
): RecordTransportInboxResult {
  const dedupKeys = normalizeStringArray(input.dedupKeys ?? input.envelope.dedupKeys);
  const duplicate = findTransportInboxDuplicate(workspacePath, dedupKeys);
  if (duplicate) {
    return {
      record: duplicate,
      duplicate: true,
    };
  }
  const now = new Date().toISOString();
  const record: TransportInboxRecord = {
    id: `in_${input.envelope.id}`,
    envelope: normalizeTransportEnvelope(input.envelope),
    status: 'delivered',
    dedupKeys,
    attempts: [
      {
        ts: now,
        status: 'delivered',
        ...(normalizeString(input.message) ? { message: normalizeString(input.message) } : {}),
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  writeTransportInboxRecord(workspacePath, record);
  return {
    record,
    duplicate: false,
  };
}

function writeTransportInboxRecord(workspacePath: string, record: TransportInboxRecord): void {
  writeTransportRecord(
    transportInboxPath(workspacePath, record.id),
    {
      id: record.id,
      envelope: record.envelope,
      status: record.status,
      dedup_keys: record.dedupKeys,
      attempts: record.attempts,
      duplicate_of: record.duplicateOf,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    },
    [
      renderJsonSection('Envelope', record.envelope),
      renderJsonSection('Attempts', record.attempts),
    ].join('\n'),
  );
}

function normalizeTransportInboxRecord(frontmatter: Record<string, unknown>): TransportInboxRecord {
  return {
    id: normalizeString(frontmatter.id) ?? 'unknown',
    envelope: normalizeTransportEnvelope(frontmatter.envelope),
    status: normalizeString(frontmatter.status) === 'failed'
      ? 'failed'
      : normalizeString(frontmatter.status) === 'replayed'
        ? 'replayed'
        : normalizeString(frontmatter.status) === 'pending'
          ? 'pending'
          : 'delivered',
    dedupKeys: normalizeStringArray(frontmatter.dedup_keys),
    attempts: normalizeAttemptArray(frontmatter.attempts),
    duplicateOf: normalizeString(frontmatter.duplicate_of),
    createdAt: normalizeTimestamp(frontmatter.created_at),
    updatedAt: normalizeTimestamp(frontmatter.updated_at),
  };
}
