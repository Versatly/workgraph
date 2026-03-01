import { describe, expect, it } from 'vitest';
import {
  collectThreadEvidence,
  extractEvidenceFromText,
  normalizeEvidencePolicy,
  validateThreadEvidence,
} from './evidence.js';

describe('evidence policy normalization', () => {
  it('defaults unknown values to strict', () => {
    expect(normalizeEvidencePolicy(undefined)).toBe('strict');
    expect(normalizeEvidencePolicy('unknown')).toBe('strict');
  });

  it('accepts strict, relaxed, and none', () => {
    expect(normalizeEvidencePolicy('strict')).toBe('strict');
    expect(normalizeEvidencePolicy('relaxed')).toBe('relaxed');
    expect(normalizeEvidencePolicy('none')).toBe('none');
  });
});

describe('evidence extraction', () => {
  it('extracts url, thread refs, reply refs, and attachment paths from text', () => {
    const text = [
      'See https://github.com/versatly/workgraph/pull/100 for rollout evidence.',
      'Linked thread: [[threads/ship-auth]]',
      'Reply trace: reply:abc-123',
      'Attachment: artifacts/release-log.txt',
      'Direct thread path threads/cleanup-task.md',
    ].join('\n');

    const evidence = extractEvidenceFromText(text);
    expect(evidence.some((entry) => entry.type === 'url')).toBe(true);
    expect(evidence.some((entry) => entry.type === 'thread-ref' && entry.value === 'threads/ship-auth.md')).toBe(true);
    expect(evidence.some((entry) => entry.type === 'reply-ref' && entry.value === 'reply:abc-123')).toBe(true);
    expect(evidence.some((entry) => entry.type === 'attachment' && entry.value === 'artifacts/release-log.txt')).toBe(true);
    expect(evidence.some((entry) => entry.type === 'thread-ref' && entry.value === 'threads/cleanup-task.md')).toBe(true);
  });

  it('deduplicates repeated evidence items', () => {
    const text = 'https://github.com/versatly/workgraph/issues/1 https://github.com/versatly/workgraph/issues/1';
    const evidence = extractEvidenceFromText(text);
    expect(evidence).toHaveLength(1);
  });

  it('collects inferred and explicit evidence together', () => {
    const evidence = collectThreadEvidence(
      'https://github.com/versatly/workgraph/issues/2',
      ['reply:abc', { type: 'thread-ref', value: 'threads/demo-thread' }],
    );
    expect(evidence.some((entry) => entry.type === 'url')).toBe(true);
    expect(evidence.some((entry) => entry.type === 'reply-ref' && entry.value === 'reply:abc')).toBe(true);
    expect(evidence.some((entry) => entry.type === 'thread-ref' && entry.value === 'threads/demo-thread.md')).toBe(true);
  });
});

describe('evidence validation', () => {
  it('requires at least one valid evidence item in strict mode', () => {
    const result = validateThreadEvidence([], 'strict');
    expect(result.ok).toBe(false);
  });

  it('accepts valid https url in strict mode', () => {
    const evidence = collectThreadEvidence('https://github.com/versatly/workgraph/issues/10');
    const result = validateThreadEvidence(evidence, 'strict');
    expect(result.ok).toBe(true);
    expect(result.validEvidence).toHaveLength(1);
  });

  it('rejects example.com and localhost urls in strict mode', () => {
    const result = validateThreadEvidence([
      { type: 'url', value: 'https://example.com/proof', valid: false },
      { type: 'url', value: 'http://localhost:3000/build', valid: false },
    ], 'strict');
    expect(result.ok).toBe(false);
    expect(result.invalidEvidence).toHaveLength(2);
  });

  it('rejects loopback and wildcard example domains', () => {
    const result = validateThreadEvidence([
      { type: 'url', value: 'https://foo.example.org/evidence', valid: false },
      { type: 'url', value: 'https://127.0.0.1/evidence', valid: false },
      { type: 'url', value: 'https://0.0.0.0/evidence', valid: false },
    ], 'strict');
    expect(result.ok).toBe(false);
    expect(result.invalidEvidence.map((entry) => entry.reason).every(Boolean)).toBe(true);
  });

  it('rejects synthetic smoke/remediate paths', () => {
    const result = validateThreadEvidence([
      { type: 'attachment', value: 'artifacts/smoke/report.log', valid: false },
      { type: 'url', value: 'https://github.com/remediate/report', valid: false },
    ], 'strict');
    expect(result.ok).toBe(false);
    expect(result.invalidEvidence).toHaveLength(2);
  });

  it('validates thread refs and reply refs', () => {
    const result = validateThreadEvidence([
      { type: 'thread-ref', value: 'threads/release-thread.md', valid: false },
      { type: 'reply-ref', value: 'reply:run-123', valid: false },
    ], 'strict');
    expect(result.ok).toBe(true);
  });

  it('rejects malformed reply refs', () => {
    const result = validateThreadEvidence([
      { type: 'reply-ref', value: 'not-a-reply-ref', valid: false },
    ], 'strict');
    expect(result.ok).toBe(false);
  });

  it('strict mode fails if any invalid evidence exists', () => {
    const result = validateThreadEvidence([
      { type: 'url', value: 'https://github.com/versatly/workgraph/pull/99', valid: false },
      { type: 'url', value: 'https://example.com/fake', valid: false },
    ], 'strict');
    expect(result.ok).toBe(false);
    expect(result.validEvidence).toHaveLength(1);
    expect(result.invalidEvidence).toHaveLength(1);
  });

  it('relaxed mode allows mixed validity if at least one is valid', () => {
    const result = validateThreadEvidence([
      { type: 'url', value: 'https://github.com/versatly/workgraph/pull/101', valid: false },
      { type: 'url', value: 'https://example.com/fake', valid: false },
    ], 'relaxed');
    expect(result.ok).toBe(true);
    expect(result.validEvidence).toHaveLength(1);
  });

  it('relaxed mode still fails with no valid evidence', () => {
    const result = validateThreadEvidence([
      { type: 'url', value: 'https://example.com/fake', valid: false },
    ], 'relaxed');
    expect(result.ok).toBe(false);
  });

  it('none mode bypasses strict evidence requirements', () => {
    const result = validateThreadEvidence([], 'none');
    expect(result.ok).toBe(true);
    expect(result.validEvidence).toHaveLength(0);
  });
});
