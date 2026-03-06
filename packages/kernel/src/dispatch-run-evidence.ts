import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { collectThreadEvidence } from './evidence.js';
import type { DispatchAdapterExecutionResult } from './runtime-adapter-contracts.js';
import type { DispatchRunEvidenceItem } from './types.js';

const PR_URL_PATTERN = /\bhttps?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\b/gi;
const MAX_EVIDENCE_TEXT_CHARS = 3_000;
const MAX_TEST_SIGNALS = 20;

export interface DispatchExecutionEvidenceInput {
  runId: string;
  execution: DispatchAdapterExecutionResult;
  beforeGitState: Set<string> | null;
  afterGitState: Set<string> | null;
}

export interface DispatchExecutionEvidenceResult {
  items: DispatchRunEvidenceItem[];
  summary: {
    count: number;
    byType: Record<string, number>;
    lastCollectedAt: string;
  };
}

export function captureWorkspaceGitState(workspacePath: string): Set<string> | null {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: workspacePath,
    encoding: 'utf-8',
  });
  if ((result.status ?? 1) !== 0) return null;
  const files = new Set<string>();
  for (const rawLine of result.stdout.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const payload = line.slice(3).trim();
    if (!payload) continue;
    if (payload.includes(' -> ')) {
      const [, target] = payload.split(' -> ');
      if (target) files.add(target.trim());
      continue;
    }
    files.add(payload);
  }
  return files;
}

export function collectDispatchExecutionEvidence(
  input: DispatchExecutionEvidenceInput,
): DispatchExecutionEvidenceResult {
  const now = new Date().toISOString();
  const evidence: DispatchRunEvidenceItem[] = [];
  const output = readOptionalText(input.execution.output);
  const error = readOptionalText(input.execution.error);
  const logLines = (input.execution.logs ?? []).map((entry) => `[${entry.level}] ${entry.message}`).join('\n');
  const corpus = [output, error, logLines].filter(Boolean).join('\n');

  if (output) {
    evidence.push(createEvidence(input.runId, now, 'stdout', 'adapter-output', clampText(extractStdout(output))));
  }
  if (error) {
    evidence.push(createEvidence(input.runId, now, 'stderr', 'adapter-error', clampText(error)));
  }

  const prUrls = dedupeStrings(corpus.match(PR_URL_PATTERN) ?? []);
  for (const url of prUrls) {
    evidence.push(createEvidence(input.runId, now, 'pr-url', 'derived', url));
  }

  const testSignals = extractTestSignals(corpus);
  for (const signal of testSignals) {
    evidence.push(createEvidence(input.runId, now, 'test-result', 'derived', signal));
  }

  const inferred = collectThreadEvidence(corpus);
  for (const item of inferred) {
    if (item.type === 'url') {
      evidence.push(createEvidence(input.runId, now, 'url', 'derived', item.value));
    } else if (item.type === 'attachment') {
      evidence.push(createEvidence(input.runId, now, 'attachment', 'derived', item.value));
    } else if (item.type === 'thread-ref') {
      evidence.push(createEvidence(input.runId, now, 'thread-ref', 'derived', item.value));
    } else {
      evidence.push(createEvidence(input.runId, now, 'reply-ref', 'derived', item.value));
    }
  }

  const changedFiles = diffGitStates(input.beforeGitState, input.afterGitState);
  for (const file of changedFiles) {
    evidence.push(createEvidence(input.runId, now, 'file-change', 'git', file));
  }

  if (input.execution.metrics && Object.keys(input.execution.metrics).length > 0) {
    evidence.push(createEvidence(
      input.runId,
      now,
      'metric',
      'adapter-metric',
      clampText(JSON.stringify(input.execution.metrics)),
    ));
  }

  const deduped = dedupeEvidence(evidence);
  return {
    items: deduped,
    summary: {
      count: deduped.length,
      byType: buildTypeCounts(deduped),
      lastCollectedAt: now,
    },
  };
}

function createEvidence(
  runId: string,
  ts: string,
  type: DispatchRunEvidenceItem['type'],
  source: DispatchRunEvidenceItem['source'],
  value: string,
  metadata?: Record<string, unknown>,
): DispatchRunEvidenceItem {
  return {
    id: `runev_${randomUUID()}`,
    runId,
    ts,
    type,
    source,
    value,
    ...(metadata ? { metadata } : {}),
  };
}

function readOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractStdout(output: string): string {
  const match = output.match(/STDOUT:\n([\s\S]*?)\n\nSTDERR:/);
  if (!match?.[1]) return output;
  return match[1].trim();
}

function clampText(value: string): string {
  if (value.length <= MAX_EVIDENCE_TEXT_CHARS) return value;
  return `${value.slice(0, MAX_EVIDENCE_TEXT_CHARS)}\n...[truncated]`;
}

function extractTestSignals(text: string): string[] {
  if (!text) return [];
  const signals = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) =>
      line.length > 0
      && /test|spec|vitest|jest|pass|fail|coverage/i.test(line)
      && /(pass|fail|skip|todo|coverage)/i.test(line),
    );
  return dedupeStrings(signals).slice(0, MAX_TEST_SIGNALS);
}

function diffGitStates(before: Set<string> | null, after: Set<string> | null): string[] {
  if (!before || !after) return [];
  const diff: string[] = [];
  for (const entry of after) {
    if (!before.has(entry)) diff.push(entry);
  }
  return diff.sort((a, b) => a.localeCompare(b));
}

function dedupeEvidence(items: DispatchRunEvidenceItem[]): DispatchRunEvidenceItem[] {
  const deduped = new Map<string, DispatchRunEvidenceItem>();
  for (const item of items) {
    const key = `${item.type}:${item.source}:${item.value}`;
    if (!deduped.has(key)) {
      deduped.set(key, item);
    }
  }
  return [...deduped.values()];
}

function dedupeStrings(items: string[]): string[] {
  return [...new Set(items.map((entry) => entry.trim()).filter(Boolean))];
}

function buildTypeCounts(items: DispatchRunEvidenceItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item.type] = (counts[item.type] ?? 0) + 1;
  }
  return counts;
}
