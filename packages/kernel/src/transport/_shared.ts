import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

export const TRANSPORT_ROOT = '.workgraph/transport';

export interface TransportAttempt {
  ts: string;
  status: 'pending' | 'delivered' | 'failed' | 'replayed';
  message?: string;
  error?: string;
}

export function readTransportRecord<T>(filePath: string, hydrate: (frontmatter: Record<string, unknown>) => T): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = matter(fs.readFileSync(filePath, 'utf-8'));
    return hydrate(asRecord(parsed.data));
  } catch {
    return null;
  }
}

export function writeTransportRecord(
  filePath: string,
  frontmatter: Record<string, unknown>,
  body: string,
): void {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(filePath, matter.stringify(body, stripUndefined(frontmatter)), 'utf-8');
}

export function listTransportRecordFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => path.join(directory, entry))
    .sort((left, right) => {
      const leftStat = fs.statSync(left);
      const rightStat = fs.statSync(right);
      return rightStat.mtimeMs - leftStat.mtimeMs;
    });
}

export function renderJsonSection(title: string, value: unknown): string {
  return [
    `## ${title}`,
    '',
    '```json',
    JSON.stringify(value, null, 2),
    '```',
    '',
  ].join('\n');
}

export function normalizeTimestamp(value: unknown, fallback: string = new Date().toISOString()): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry ?? '').trim()).filter(Boolean))];
}

export function normalizeAttemptArray(value: unknown): TransportAttempt[] {
  if (!Array.isArray(value)) return [];
  const attempts: TransportAttempt[] = [];
  for (const entry of value) {
    const candidate = asRecord(entry);
    const ts = normalizeTimestamp(candidate.ts);
    const status = normalizeAttemptStatus(candidate.status);
    if (!status) continue;
    attempts.push({
      ts,
      status,
      ...(normalizeString(candidate.message) ? { message: normalizeString(candidate.message) } : {}),
      ...(normalizeString(candidate.error) ? { error: normalizeString(candidate.error) } : {}),
    });
  }
  return attempts;
}

export function normalizeAttemptStatus(value: unknown): TransportAttempt['status'] | undefined {
  const normalized = normalizeString(value)?.toLowerCase();
  if (normalized === 'pending' || normalized === 'delivered' || normalized === 'failed' || normalized === 'replayed') {
    return normalized;
  }
  return undefined;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function stripUndefined<T>(value: T): T {
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
