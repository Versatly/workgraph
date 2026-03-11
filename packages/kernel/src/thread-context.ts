import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import * as store from './store.js';

const THREAD_CONTEXT_ROOT = '.workgraph/thread-context';
const THREAD_CONTEXT_SUBDIRECTORY = 'context';
const DEFAULT_RELEVANCE_SCORE = 0.5;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

export interface ThreadContextEntry {
  path: string;
  threadPath: string;
  threadTid: string;
  title: string;
  source?: string;
  added_by: string;
  added_at: string;
  relevance_score: number;
  content: string;
}

export interface AddThreadContextEntryInput {
  title: string;
  content: string;
  source?: string;
  addedBy: string;
  relevanceScore?: number;
}

export interface ThreadContextSearchResult {
  path: string;
  title: string;
  source?: string;
  added_by: string;
  added_at: string;
  relevance_score: number;
  bm25_score: number;
  snippet: string;
}

export interface ThreadContextSummary {
  threadPath: string;
  threadTid: string;
  totalEntries: number;
  topEntries: Array<{
    path: string;
    title: string;
    source?: string;
    added_at: string;
    relevance_score: number;
  }>;
}

export interface PruneThreadContextInput {
  maxAgeMinutes?: number;
  minRelevance?: number;
  now?: Date;
}

export interface PruneThreadContextResult {
  threadPath: string;
  threadTid: string;
  removedCount: number;
  keptCount: number;
  removed: Array<{
    path: string;
    title: string;
    added_at: string;
    relevance_score: number;
    reasons: Array<'max_age' | 'min_relevance'>;
  }>;
}

interface ThreadContextEntryRecord extends ThreadContextEntry {
  absolutePath: string;
}

export function addThreadContextEntry(
  workspacePath: string,
  rawThreadPath: string,
  input: AddThreadContextEntryInput,
): ThreadContextEntry {
  const threadPath = normalizeThreadPath(rawThreadPath);
  const title = normalizeRequiredString(input.title, 'Context entry title is required.');
  const content = normalizeRequiredString(input.content, 'Context entry content is required.');
  const addedBy = normalizeRequiredString(input.addedBy, 'Context entry actor is required.');
  const source = normalizeOptionalString(input.source);
  const relevanceScore = normalizeRelevanceScore(input.relevanceScore);
  const addedAt = new Date().toISOString();
  const target = resolveThreadContextLocation(workspacePath, threadPath);
  if (!fs.existsSync(target.contextDir)) {
    fs.mkdirSync(target.contextDir, { recursive: true });
  }
  const fileName = buildContextEntryFileName(title, content, addedAt, addedBy);
  const absolutePath = path.join(target.contextDir, fileName);
  const relativePath = path.relative(workspacePath, absolutePath).replace(/\\/g, '/');
  const frontmatter = {
    title,
    ...(source ? { source } : {}),
    added_by: addedBy,
    added_at: addedAt,
    relevance_score: relevanceScore,
  };
  const rendered = matter.stringify(`${content}\n`, frontmatter);
  fs.writeFileSync(absolutePath, rendered, 'utf-8');
  return {
    path: relativePath,
    threadPath,
    threadTid: target.threadTid,
    title,
    ...(source ? { source } : {}),
    added_by: addedBy,
    added_at: addedAt,
    relevance_score: relevanceScore,
    content,
  };
}

export function listThreadContextEntries(workspacePath: string, rawThreadPath: string): ThreadContextEntry[] {
  const threadPath = normalizeThreadPath(rawThreadPath);
  return readThreadContextEntries(workspacePath, threadPath).map(stripRecordPathForPublicResult);
}

export function summarizeThreadContext(
  workspacePath: string,
  rawThreadPath: string,
  options: { topN?: number } = {},
): ThreadContextSummary {
  const threadPath = normalizeThreadPath(rawThreadPath);
  const location = resolveThreadContextLocation(workspacePath, threadPath);
  const entries = readThreadContextEntries(workspacePath, threadPath);
  const topN = normalizePositiveInt(options.topN, 3);
  const topEntries = entries
    .slice()
    .sort((left, right) =>
      right.relevance_score - left.relevance_score
      || right.added_at.localeCompare(left.added_at)
      || left.path.localeCompare(right.path))
    .slice(0, topN)
    .map((entry) => ({
      path: entry.path,
      title: entry.title,
      ...(entry.source ? { source: entry.source } : {}),
      added_at: entry.added_at,
      relevance_score: entry.relevance_score,
    }));
  return {
    threadPath,
    threadTid: location.threadTid,
    totalEntries: entries.length,
    topEntries,
  };
}

export function searchThreadContextEntries(
  workspacePath: string,
  rawThreadPath: string,
  query: string,
  options: { limit?: number } = {},
): ThreadContextSearchResult[] {
  const threadPath = normalizeThreadPath(rawThreadPath);
  const normalizedQuery = normalizeRequiredString(query, 'Search query is required.');
  const entries = readThreadContextEntries(workspacePath, threadPath);
  if (entries.length === 0) return [];
  const queryTokens = tokenize(normalizedQuery);
  if (queryTokens.length === 0) return [];
  const queryTerms = uniqueStrings(queryTokens);
  const indexed = entries.map((entry) => buildSearchRecord(entry));
  const averageDocLength = indexed.reduce((sum, item) => sum + item.docLength, 0) / indexed.length;
  const docFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    let count = 0;
    for (const item of indexed) {
      if (item.termFrequency.has(term)) count += 1;
    }
    docFrequency.set(term, count);
  }
  const limit = normalizePositiveInt(options.limit, 10);
  const scored = indexed
    .map((item) => ({
      item,
      score: computeBm25Score(item, queryTerms, docFrequency, indexed.length, averageDocLength),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score - left.score
      || right.item.entry.relevance_score - left.item.entry.relevance_score
      || right.item.entry.added_at.localeCompare(left.item.entry.added_at)
      || left.item.entry.path.localeCompare(right.item.entry.path))
    .slice(0, limit);
  return scored.map(({ item, score }) => ({
    path: item.entry.path,
    title: item.entry.title,
    ...(item.entry.source ? { source: item.entry.source } : {}),
    added_by: item.entry.added_by,
    added_at: item.entry.added_at,
    relevance_score: item.entry.relevance_score,
    bm25_score: roundScore(score),
    snippet: buildSnippet(item.entry.content, queryTerms),
  }));
}

export function pruneThreadContextEntries(
  workspacePath: string,
  rawThreadPath: string,
  options: PruneThreadContextInput = {},
): PruneThreadContextResult {
  const threadPath = normalizeThreadPath(rawThreadPath);
  const location = resolveThreadContextLocation(workspacePath, threadPath);
  const entries = readThreadContextEntries(workspacePath, threadPath);
  const nowMs = (options.now ?? new Date()).getTime();
  const maxAgeMinutes = options.maxAgeMinutes !== undefined
    ? normalizePositiveInt(options.maxAgeMinutes, 0)
    : undefined;
  const minRelevance = options.minRelevance !== undefined
    ? normalizeRelevanceScore(options.minRelevance)
    : undefined;
  const cutoffMs = maxAgeMinutes !== undefined
    ? nowMs - maxAgeMinutes * 60_000
    : undefined;
  const removed: PruneThreadContextResult['removed'] = [];
  let keptCount = 0;
  for (const entry of entries) {
    const reasons: Array<'max_age' | 'min_relevance'> = [];
    if (cutoffMs !== undefined) {
      const addedAtMs = Date.parse(entry.added_at);
      if (Number.isFinite(addedAtMs) && addedAtMs < cutoffMs) {
        reasons.push('max_age');
      }
    }
    if (minRelevance !== undefined && entry.relevance_score < minRelevance) {
      reasons.push('min_relevance');
    }
    if (reasons.length === 0) {
      keptCount += 1;
      continue;
    }
    fs.rmSync(entry.absolutePath, { force: true });
    removed.push({
      path: entry.path,
      title: entry.title,
      added_at: entry.added_at,
      relevance_score: entry.relevance_score,
      reasons,
    });
  }
  return {
    threadPath,
    threadTid: location.threadTid,
    removedCount: removed.length,
    keptCount,
    removed,
  };
}

function readThreadContextEntries(workspacePath: string, threadPath: string): ThreadContextEntryRecord[] {
  const location = resolveThreadContextLocation(workspacePath, threadPath);
  if (!fs.existsSync(location.contextDir)) return [];
  const files = fs.readdirSync(location.contextDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.join(location.contextDir, entry.name))
    .sort((left, right) => left.localeCompare(right));
  const output: ThreadContextEntryRecord[] = [];
  for (const absolutePath of files) {
    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(fs.readFileSync(absolutePath, 'utf-8'));
    } catch {
      continue;
    }
    const title = normalizeOptionalString(parsed.data.title) ?? path.basename(absolutePath, '.md');
    const source = normalizeOptionalString(parsed.data.source);
    const addedBy = normalizeOptionalString(parsed.data.added_by) ?? 'unknown';
    const addedAt = normalizeIsoString(parsed.data.added_at) ?? new Date(0).toISOString();
    const relevanceScore = normalizeRelevanceScore(parsed.data.relevance_score);
    const relativePath = path.relative(workspacePath, absolutePath).replace(/\\/g, '/');
    output.push({
      path: relativePath,
      threadPath,
      threadTid: location.threadTid,
      title,
      ...(source ? { source } : {}),
      added_by: addedBy,
      added_at: addedAt,
      relevance_score: relevanceScore,
      content: parsed.content.trim(),
      absolutePath,
    });
  }
  return output.sort((left, right) =>
    right.relevance_score - left.relevance_score
    || right.added_at.localeCompare(left.added_at)
    || left.path.localeCompare(right.path));
}

function resolveThreadContextLocation(
  workspacePath: string,
  threadPath: string,
): { threadPath: string; threadTid: string; contextDir: string } {
  const threadInstance = store.read(workspacePath, threadPath);
  if (!threadInstance || threadInstance.type !== 'thread') {
    throw new Error(`Thread not found: ${threadPath}`);
  }
  const frontmatterTid = normalizeOptionalString(threadInstance.fields.tid);
  const fallbackTid = sanitizeThreadTid(path.basename(threadPath, '.md'));
  const threadTid = sanitizeThreadTid(frontmatterTid ?? fallbackTid);
  const contextDir = path.join(workspacePath, THREAD_CONTEXT_ROOT, threadTid, THREAD_CONTEXT_SUBDIRECTORY);
  return {
    threadPath,
    threadTid,
    contextDir,
  };
}

function buildContextEntryFileName(title: string, content: string, addedAtIso: string, actor: string): string {
  const stamp = addedAtIso
    .replace(/:/g, '')
    .replace(/\./g, '')
    .replace('T', '-')
    .replace('Z', '');
  const slug = slugify(title) || 'context';
  const digest = createHash('sha1')
    .update(`${title}\n${content}\n${addedAtIso}\n${actor}`)
    .digest('hex')
    .slice(0, 8);
  return `${stamp}-${slug}-${digest}.md`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function sanitizeThreadTid(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return sanitized || 'thread';
}

function normalizeThreadPath(value: string): string {
  const trimmed = String(value ?? '').trim().replace(/^\.\//, '').replace(/\\/g, '/');
  if (!trimmed) {
    throw new Error('Thread path is required.');
  }
  const withPrefix = trimmed.includes('/') ? trimmed : `threads/${trimmed}`;
  return withPrefix.endsWith('.md') ? withPrefix : `${withPrefix}.md`;
}

function normalizeRequiredString(value: unknown, message: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw new Error(message);
  return normalized;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeIsoString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

function normalizeRelevanceScore(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_RELEVANCE_SCORE;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return roundScore(value);
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function buildSearchRecord(entry: ThreadContextEntryRecord): {
  entry: ThreadContextEntryRecord;
  termFrequency: Map<string, number>;
  docLength: number;
} {
  const searchable = [entry.title, entry.source ?? '', entry.content].join('\n');
  const tokens = tokenize(searchable);
  const termFrequency = new Map<string, number>();
  for (const token of tokens) {
    termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
  }
  return {
    entry,
    termFrequency,
    docLength: Math.max(1, tokens.length),
  };
}

function computeBm25Score(
  record: {
    termFrequency: Map<string, number>;
    docLength: number;
    entry: ThreadContextEntryRecord;
  },
  queryTerms: string[],
  docFrequency: Map<string, number>,
  docCount: number,
  averageDocLength: number,
): number {
  const avgDocLength = averageDocLength > 0 ? averageDocLength : 1;
  let bm25Score = 0;
  for (const term of queryTerms) {
    const tf = record.termFrequency.get(term) ?? 0;
    if (tf <= 0) continue;
    const df = docFrequency.get(term) ?? 0;
    if (df <= 0) continue;
    const idf = Math.log(1 + ((docCount - df + 0.5) / (df + 0.5)));
    const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (record.docLength / avgDocLength));
    bm25Score += idf * ((tf * (BM25_K1 + 1)) / denominator);
  }
  if (bm25Score <= 0) return 0;
  // Relevance frontmatter nudges tie-breaks without replacing BM25 ranking.
  return bm25Score + record.entry.relevance_score * 0.05;
}

function buildSnippet(content: string, queryTerms: string[]): string {
  const normalized = content.trim();
  if (!normalized) return '';
  const lower = normalized.toLowerCase();
  let matchIndex = -1;
  let matchedTerm = '';
  for (const term of queryTerms) {
    const idx = lower.indexOf(term.toLowerCase());
    if (idx >= 0 && (matchIndex < 0 || idx < matchIndex)) {
      matchIndex = idx;
      matchedTerm = term;
    }
  }
  if (matchIndex < 0) {
    return normalized.slice(0, 240);
  }
  const window = Math.max(60, matchedTerm.length + 40);
  const start = Math.max(0, matchIndex - window);
  const end = Math.min(normalized.length, matchIndex + matchedTerm.length + window);
  return normalized.slice(start, end);
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function stripRecordPathForPublicResult(entry: ThreadContextEntryRecord): ThreadContextEntry {
  return {
    path: entry.path,
    threadPath: entry.threadPath,
    threadTid: entry.threadTid,
    title: entry.title,
    ...(entry.source ? { source: entry.source } : {}),
    added_by: entry.added_by,
    added_at: entry.added_at,
    relevance_score: entry.relevance_score,
    content: entry.content,
  };
}
