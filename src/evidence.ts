import type {
  EvidencePolicy,
  ThreadEvidenceInput,
  ThreadEvidenceItem,
  ThreadEvidenceType,
  ThreadEvidenceValidationResult,
} from './types.js';

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
const WIKILINK_PATTERN = /\[\[([^[\]]+)\]\]/g;
const THREAD_PATH_PATTERN = /\bthreads\/[a-z0-9._/-]+(?:\.md)?\b/gi;
const REPLY_REF_PATTERN = /\b(?:reply|thread):[a-z0-9._/-]+\b/gi;
const ATTACHMENT_PATH_PATTERN = /\b(?:attachments|artifacts|evidence|files|logs)\/[^\s)\]]+\b/gi;

export function normalizeEvidencePolicy(value: unknown): EvidencePolicy {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'none') return 'none';
  if (normalized === 'relaxed') return 'relaxed';
  return 'strict';
}

export function collectThreadEvidence(
  output: string | undefined,
  inputEvidence: ThreadEvidenceInput[] = [],
): ThreadEvidenceItem[] {
  const inferred = output ? extractEvidenceFromText(output) : [];
  const explicit = inputEvidence.map((entry) => normalizeExplicitEvidence(entry));
  return dedupeEvidence([...inferred, ...explicit]);
}

export function extractEvidenceFromText(text: string): ThreadEvidenceItem[] {
  const evidence: ThreadEvidenceItem[] = [];

  for (const rawUrl of text.match(URL_PATTERN) ?? []) {
    evidence.push(createEvidence('url', stripTrailingPunctuation(rawUrl)));
  }

  for (const match of text.matchAll(WIKILINK_PATTERN)) {
    const rawRef = match[1]?.split('|')[0]?.trim() ?? '';
    if (!rawRef) continue;
    const inferredType = inferEvidenceType(rawRef);
    evidence.push(createEvidence(inferredType, normalizeEvidenceValue(inferredType, rawRef)));
  }

  for (const match of text.matchAll(THREAD_PATH_PATTERN)) {
    const value = normalizeThreadRef(match[0] ?? '');
    if (value) evidence.push(createEvidence('thread-ref', value));
  }

  for (const replyRef of text.match(REPLY_REF_PATTERN) ?? []) {
    evidence.push(createEvidence('reply-ref', replyRef.trim()));
  }

  for (const attachmentPath of text.match(ATTACHMENT_PATH_PATTERN) ?? []) {
    evidence.push(createEvidence('attachment', attachmentPath.trim()));
  }

  return dedupeEvidence(evidence);
}

export function validateThreadEvidence(
  evidence: ThreadEvidenceItem[],
  policy: EvidencePolicy,
): ThreadEvidenceValidationResult {
  if (policy === 'none') {
    const normalized = evidence.map((item) => ({ ...item, valid: true, reason: undefined }));
    return {
      policy,
      evidence: normalized,
      validEvidence: normalized,
      invalidEvidence: [],
      ok: true,
    };
  }

  const validated = evidence.map(validateEvidenceItem);
  const validEvidence = validated.filter((entry) => entry.valid);
  const invalidEvidence = validated.filter((entry) => !entry.valid);

  const hasRequiredEvidence = validEvidence.length > 0;
  const ok = policy === 'strict'
    ? hasRequiredEvidence && invalidEvidence.length === 0
    : hasRequiredEvidence;

  return {
    policy,
    evidence: validated,
    validEvidence,
    invalidEvidence,
    ok,
  };
}

function normalizeExplicitEvidence(input: ThreadEvidenceInput): ThreadEvidenceItem {
  if (typeof input === 'string') {
    const inferred = inferEvidenceType(input);
    return createEvidence(inferred, normalizeEvidenceValue(inferred, input));
  }
  const inferred = input.type ? normalizeEvidenceType(input.type) : inferEvidenceType(input.value);
  return createEvidence(inferred, normalizeEvidenceValue(inferred, input.value));
}

function normalizeEvidenceType(type: ThreadEvidenceType): ThreadEvidenceType {
  switch (type) {
    case 'url':
    case 'attachment':
    case 'thread-ref':
    case 'reply-ref':
      return type;
    default:
      return 'reply-ref';
  }
}

function inferEvidenceType(value: string): ThreadEvidenceType {
  const trimmed = String(value ?? '').trim();
  if (/^https?:\/\//i.test(trimmed)) return 'url';
  if (/^(?:reply|thread):/i.test(trimmed)) return 'reply-ref';
  if (trimmed.startsWith('threads/')) return 'thread-ref';
  if (/^(?:attachments|artifacts|evidence|files|logs)\//i.test(trimmed)) return 'attachment';
  return 'reply-ref';
}

function normalizeEvidenceValue(type: ThreadEvidenceType, value: string): string {
  const trimmed = String(value ?? '').trim();
  if (type === 'url') {
    return stripTrailingPunctuation(trimmed);
  }
  if (type === 'thread-ref') {
    return normalizeThreadRef(trimmed) ?? trimmed;
  }
  return trimmed;
}

function normalizeThreadRef(value: string): string | null {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  const noAnchor = trimmed.split('#')[0]?.trim() ?? '';
  if (!noAnchor.toLowerCase().startsWith('threads/')) return null;
  return noAnchor.endsWith('.md') ? noAnchor : `${noAnchor}.md`;
}

function validateEvidenceItem(item: ThreadEvidenceItem): ThreadEvidenceItem {
  const value = String(item.value ?? '').trim();
  if (!value) {
    return { ...item, valid: false, reason: 'Evidence value is empty.' };
  }

  if (item.type === 'url') {
    return validateUrlEvidence(item, value);
  }
  if (item.type === 'attachment') {
    if (isSyntheticPath(value)) {
      return { ...item, valid: false, reason: 'Synthetic attachment path is not allowed.' };
    }
    return { ...item, valid: true, reason: undefined };
  }
  if (item.type === 'thread-ref') {
    const normalized = normalizeThreadRef(value);
    if (!normalized) {
      return { ...item, valid: false, reason: 'Thread evidence must reference a threads/*.md path.' };
    }
    if (isSyntheticPath(normalized)) {
      return { ...item, valid: false, reason: 'Synthetic thread reference path is not allowed.' };
    }
    return { ...item, value: normalized, valid: true, reason: undefined };
  }
  if (/^(?:reply|thread):[a-z0-9._/-]+$/i.test(value)) {
    return { ...item, valid: true, reason: undefined };
  }
  return { ...item, valid: false, reason: 'Reply evidence must use reply:<id> or thread:<id> format.' };
}

function validateUrlEvidence(item: ThreadEvidenceItem, rawValue: string): ThreadEvidenceItem {
  let parsed: URL;
  try {
    parsed = new URL(rawValue);
  } catch {
    return { ...item, valid: false, reason: 'Evidence URL is not a valid absolute URL.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ...item, valid: false, reason: 'Evidence URL must use http or https.' };
  }

  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') {
    return { ...item, valid: false, reason: `Evidence URL host "${host}" is not allowed.` };
  }
  if (host === 'example.com' || host.endsWith('.example.com') || host.startsWith('example.') || host.includes('.example.')) {
    return { ...item, valid: false, reason: 'Evidence URL host is synthetic/example and not allowed.' };
  }
  if (!host.includes('.')) {
    return { ...item, valid: false, reason: 'Evidence URL must include a real domain host.' };
  }

  if (isSyntheticPath(parsed.pathname)) {
    return { ...item, valid: false, reason: 'Evidence URL path appears synthetic and is not allowed.' };
  }
  return { ...item, valid: true, reason: undefined, value: parsed.toString() };
}

function isSyntheticPath(value: string): boolean {
  const normalized = String(value ?? '').toLowerCase();
  return normalized.includes('/smoke/') || normalized.includes('/remediate/');
}

function createEvidence(type: ThreadEvidenceType, value: string): ThreadEvidenceItem {
  return { type, value, valid: false };
}

function dedupeEvidence(items: ThreadEvidenceItem[]): ThreadEvidenceItem[] {
  const deduped = new Map<string, ThreadEvidenceItem>();
  for (const item of items) {
    const key = `${item.type}:${item.value}`;
    if (!deduped.has(key)) deduped.set(key, item);
  }
  return [...deduped.values()];
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[),.;!?]+$/, '');
}
