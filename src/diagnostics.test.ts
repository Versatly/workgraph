import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import * as dispatch from './dispatch.js';
import * as ledger from './ledger.js';
import * as store from './store.js';
import * as thread from './thread.js';
import * as workspace from './workspace.js';
import { diagnoseVaultHealth } from './diagnostics/doctor.js';
import { computeVaultStats } from './diagnostics/stats.js';
import { visualizeVaultGraph } from './diagnostics/viz.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-diagnostics-'));
  workspace.initWorkspace(workspacePath, {
    createReadme: false,
  });
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('diagnostics tooling', () => {
  it('doctor detects issues and auto-fixes orphan links + stale claims/runs', () => {
    const alpha = thread.createThread(workspacePath, 'Alpha Node', 'alpha goal', 'agent-a');
    const beta = thread.createThread(workspacePath, 'Beta Node', 'beta goal', 'agent-a');
    store.update(
      workspacePath,
      alpha.path,
      {},
      `## Links\n\n- [[${beta.path}]]\n- [[threads/non-existent.md]]\n`,
      'agent-a',
    );
    thread.claim(workspacePath, beta.path, 'agent-b');

    const run = dispatch.createRun(workspacePath, {
      actor: 'agent-runner',
      objective: 'stale run candidate',
    });
    dispatch.markRun(workspacePath, run.id, 'agent-runner', 'running');

    const oldIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    ageClaimEntry(workspacePath, beta.path, oldIso);
    ageRunEntry(workspacePath, run.id, oldIso);

    store.create(workspacePath, 'decision', {
      title: 'Alpha Node',
      date: new Date().toISOString(),
    }, '', 'agent-a');

    fs.writeFileSync(
      path.join(workspacePath, 'threads', 'missing-required.md'),
      '---\ntitle: Missing Goal\nstatus: open\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\n---\n\nmissing required goal\n',
      'utf-8',
    );

    injectBrokenManifestReference(workspacePath);

    const before = diagnoseVaultHealth(workspacePath, {
      staleAfterMs: 60 * 60 * 1000,
    });
    expect(issueCount(before, 'orphan-wiki-link')).toBeGreaterThan(0);
    expect(issueCount(before, 'stale-claim')).toBeGreaterThan(0);
    expect(issueCount(before, 'stale-run')).toBeGreaterThan(0);
    expect(issueCount(before, 'missing-required-field')).toBeGreaterThan(0);
    expect(issueCount(before, 'broken-primitive-registry-reference')).toBeGreaterThan(0);
    expect(issueCount(before, 'duplicate-slug')).toBeGreaterThan(0);

    const after = diagnoseVaultHealth(workspacePath, {
      fix: true,
      actor: 'doctor-bot',
      staleAfterMs: 60 * 60 * 1000,
    });
    expect(after.fixes.orphanLinksRemoved).toBeGreaterThan(0);
    expect(after.fixes.staleClaimsReleased).toBeGreaterThan(0);
    expect(after.fixes.staleRunsCancelled).toBeGreaterThan(0);
    expect(after.checks.orphanWikiLinks).toBe(0);
    expect(after.checks.staleClaims).toBe(0);
    expect(after.checks.staleRuns).toBe(0);

    const alphaRaw = fs.readFileSync(path.join(workspacePath, alpha.path), 'utf-8');
    expect(alphaRaw).not.toContain('[[threads/non-existent.md]]');
    expect(alphaRaw).toContain(`[[${beta.path}]]`);
    expect(ledger.currentOwner(workspacePath, beta.path)).toBeNull();
    expect(dispatch.status(workspacePath, run.id).status).toBe('cancelled');
  });

  it('stats reports deterministic primitive, link, and velocity metrics', () => {
    const alpha = thread.createThread(workspacePath, 'Alpha Thread', 'goal alpha', 'agent-a');
    const beta = thread.createThread(workspacePath, 'Beta Thread', 'goal beta', 'agent-a');
    thread.claim(workspacePath, alpha.path, 'agent-a');
    thread.done(workspacePath, alpha.path, 'agent-a', 'done');
    store.update(
      workspacePath,
      beta.path,
      {},
      `## Links\n\n- [[${alpha.path}]]\n- [[threads/missing-link.md]]\n`,
      'agent-a',
    );
    store.create(workspacePath, 'decision', {
      title: 'Design Choice',
      date: new Date().toISOString(),
    }, '', 'agent-a');

    const stats = computeVaultStats(workspacePath);
    expect(stats.primitives.total).toBe(3);
    expect(stats.primitives.byType.thread).toBe(2);
    expect(stats.primitives.byType.decision).toBe(1);
    expect(stats.links.total).toBe(1);
    expect(stats.links.orphanCount).toBe(1);
    expect(stats.links.mostConnectedNodes.length).toBeGreaterThan(0);
    expect(stats.frontmatter.averageCompleteness).toBeCloseTo(1, 5);
    expect(stats.ledger.totalEvents).toBeGreaterThan(0);
    const bucketTotal = stats.ledger.eventRatePerDay.byDay.reduce((sum, item) => sum + item.count, 0);
    expect(bucketTotal).toBe(stats.ledger.totalEvents);
    expect(stats.threads.completedCount).toBe(1);
    expect(stats.threads.averageOpenToDoneHours).toBeGreaterThanOrEqual(0);
  });

  it('viz renders box-drawing graph output with focus mode', () => {
    const root = thread.createThread(workspacePath, 'Root Node', 'root goal', 'agent-a');
    const leaf = thread.createThread(workspacePath, 'Leaf Node', 'leaf goal', 'agent-a');
    store.update(
      workspacePath,
      root.path,
      {},
      `See [[${leaf.path}]]`,
      'agent-a',
    );

    const viz = visualizeVaultGraph(workspacePath, {
      focus: root.path,
      depth: 2,
      color: false,
    });
    expect(viz.rendered).toContain(root.path);
    expect(viz.rendered).toContain(leaf.path);
    expect(viz.rendered).toContain('[thread]');
    expect(viz.rendered.includes('├') || viz.rendered.includes('└')).toBe(true);
    expect(viz.rendered).toContain('─▶');
  });
});

function issueCount(report: ReturnType<typeof diagnoseVaultHealth>, code: string): number {
  return report.issues.filter((issue) => issue.code === code).length;
}

function ageClaimEntry(workspacePath: string, targetPath: string, oldIso: string): void {
  const ledgerPath = path.join(workspacePath, '.workgraph', 'ledger.jsonl');
  const entries = ledger.readAll(workspacePath);
  const claimIndex = entries.findIndex((entry) => entry.op === 'claim' && entry.target === targetPath);
  if (claimIndex === -1) throw new Error(`Claim entry not found for ${targetPath}`);
  entries[claimIndex].ts = oldIso;
  fs.writeFileSync(ledgerPath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf-8');
}

function ageRunEntry(workspacePath: string, runId: string, oldIso: string): void {
  const runsPath = path.join(workspacePath, '.workgraph', 'dispatch-runs.json');
  const parsed = JSON.parse(fs.readFileSync(runsPath, 'utf-8')) as {
    runs?: Array<{ id: string; updatedAt: string }>;
  };
  const run = parsed.runs?.find((entry) => entry.id === runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  run.updatedAt = oldIso;
  fs.writeFileSync(runsPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
}

function injectBrokenManifestReference(workspacePath: string): void {
  const manifestPath = path.join(workspacePath, '.workgraph', 'primitive-registry.yaml');
  const manifest = YAML.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
    primitives: Array<Record<string, unknown>>;
  };
  manifest.primitives.push({
    name: 'ghost',
    directory: 'ghosts',
    canonical: false,
    builtIn: false,
    fields: [],
  });
  fs.writeFileSync(manifestPath, YAML.stringify(manifest), 'utf-8');
}
