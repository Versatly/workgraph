import path from 'node:path';
import YAML from 'yaml';
import fs from '../storage-fs.js';
import * as dispatch from '../dispatch.js';
import * as graph from '../graph.js';
import * as ledger from '../ledger.js';
import * as store from '../store.js';
import * as thread from '../thread.js';
import { formatDurationHours } from './format.js';
import { buildPrimitiveWikiGraph, loadPrimitiveInventory, type MissingWikiLink, type PrimitiveInventory } from './primitives.js';

export type DoctorSeverity = 'warning' | 'error';

export interface DoctorIssue {
  code: string;
  severity: DoctorSeverity;
  message: string;
  path?: string;
  details?: Record<string, unknown>;
}

export interface DoctorChecks {
  orphanWikiLinks: number;
  staleClaims: number;
  staleRuns: number;
  missingRequiredFields: number;
  brokenPrimitiveRegistryReferences: number;
  emptyPrimitiveDirectories: number;
  duplicateSlugs: number;
}

export interface DoctorFixSummary {
  enabled: boolean;
  orphanLinksRemoved: number;
  staleClaimsReleased: number;
  staleRunsCancelled: number;
  filesUpdated: string[];
  errors: string[];
}

export interface DoctorReport {
  generatedAt: string;
  workspacePath: string;
  ok: boolean;
  summary: {
    errors: number;
    warnings: number;
  };
  checks: DoctorChecks;
  issues: DoctorIssue[];
  fixes: DoctorFixSummary;
}

export interface DoctorOptions {
  fix?: boolean;
  actor?: string;
  staleAfterMs?: number;
}

interface StaleClaim {
  target: string;
  owner: string;
  claimedAt: string;
  ageMs: number;
}

interface StaleRun {
  id: string;
  actor: string;
  updatedAt: string;
  ageMs: number;
}

interface DoctorFindings {
  issues: DoctorIssue[];
  checks: DoctorChecks;
  orphanLinks: MissingWikiLink[];
  staleClaims: StaleClaim[];
  staleRuns: StaleRun[];
}

interface DispatchRunSnapshot {
  id: string;
  actor: string;
  status: string;
  updatedAt: string;
}

const DEFAULT_STALE_AFTER_MS = 60 * 60 * 1000;
const DOCTOR_ACTOR = 'workgraph-doctor';

export function diagnoseVaultHealth(workspacePath: string, options: DoctorOptions = {}): DoctorReport {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const fixEnabled = options.fix === true;
  const fixActor = options.actor ?? DOCTOR_ACTOR;
  const fixSummary: DoctorFixSummary = {
    enabled: fixEnabled,
    orphanLinksRemoved: 0,
    staleClaimsReleased: 0,
    staleRunsCancelled: 0,
    filesUpdated: [],
    errors: [],
  };

  let findings = collectDoctorFindings(workspacePath, staleAfterMs);
  if (fixEnabled) {
    const orphanFix = removeOrphanLinks(workspacePath, findings.orphanLinks);
    fixSummary.orphanLinksRemoved = orphanFix.removedLinks;
    fixSummary.filesUpdated.push(...orphanFix.filesUpdated);
    fixSummary.errors.push(...orphanFix.errors);

    const staleClaimFix = releaseStaleClaims(workspacePath, findings.staleClaims);
    fixSummary.staleClaimsReleased = staleClaimFix.released;
    fixSummary.errors.push(...staleClaimFix.errors);

    const staleRunFix = cancelStaleRuns(workspacePath, findings.staleRuns, fixActor);
    fixSummary.staleRunsCancelled = staleRunFix.cancelled;
    fixSummary.errors.push(...staleRunFix.errors);

    if (fixSummary.orphanLinksRemoved > 0) {
      graph.refreshWikiLinkGraphIndex(workspacePath);
    }
    findings = collectDoctorFindings(workspacePath, staleAfterMs);
  }

  const warnings = findings.issues.filter((issue) => issue.severity === 'warning').length;
  const errors = findings.issues.filter((issue) => issue.severity === 'error').length;
  return {
    generatedAt: new Date().toISOString(),
    workspacePath,
    ok: errors === 0,
    summary: { errors, warnings },
    checks: findings.checks,
    issues: findings.issues,
    fixes: {
      ...fixSummary,
      filesUpdated: fixSummary.filesUpdated.slice().sort((a, b) => a.localeCompare(b)),
    },
  };
}

function collectDoctorFindings(workspacePath: string, staleAfterMs: number): DoctorFindings {
  const issues: DoctorIssue[] = [];
  const now = Date.now();
  let inventory: PrimitiveInventory | null = null;

  try {
    inventory = loadPrimitiveInventory(workspacePath);
  } catch (error) {
    issues.push({
      code: 'primitive-inventory-load-failed',
      severity: 'error',
      message: `Failed to load primitive inventory: ${errorMessage(error)}`,
    });
  }

  const primitiveGraph = inventory
    ? buildPrimitiveWikiGraph(workspacePath, inventory)
    : {
        missingLinks: [] as MissingWikiLink[],
      };

  for (const orphan of primitiveGraph.missingLinks) {
    issues.push({
      code: 'orphan-wiki-link',
      severity: 'warning',
      message: `Orphan wiki-link in ${orphan.from}: ${orphan.token} -> ${orphan.normalizedTarget}`,
      path: orphan.from,
      details: {
        token: orphan.token,
        target: orphan.normalizedTarget,
      },
    });
  }

  if (inventory) {
    for (const primitive of inventory.primitives) {
      for (const requiredField of primitive.requiredFields) {
        if (isMissingRequiredValue(primitive.fields[requiredField])) {
          issues.push({
            code: 'missing-required-field',
            severity: 'error',
            message: `Missing required frontmatter field "${requiredField}" on ${primitive.path}`,
            path: primitive.path,
            details: {
              field: requiredField,
              type: primitive.type,
            },
          });
        }
      }
    }

    for (const [slug, pathsForSlug] of inventory.slugToPaths.entries()) {
      if (pathsForSlug.length <= 1) continue;
      issues.push({
        code: 'duplicate-slug',
        severity: 'error',
        message: `Duplicate slug "${slug}" is used by: ${pathsForSlug.join(', ')}`,
        details: { slug, paths: pathsForSlug },
      });
    }
  }

  const staleClaims = collectStaleClaims(workspacePath, staleAfterMs, now);
  for (const staleClaim of staleClaims) {
    issues.push({
      code: 'stale-claim',
      severity: 'warning',
      message: `Stale claim on ${staleClaim.target} by ${staleClaim.owner} (${formatDurationHours(staleClaim.ageMs / 3600000)} old)`,
      path: staleClaim.target,
      details: {
        owner: staleClaim.owner,
        claimedAt: staleClaim.claimedAt,
      },
    });
  }

  const staleRuns = collectStaleRuns(workspacePath, staleAfterMs, now);
  for (const staleRun of staleRuns) {
    issues.push({
      code: 'stale-run',
      severity: 'warning',
      message: `Run ${staleRun.id} is stuck in running for ${formatDurationHours(staleRun.ageMs / 3600000)}`,
      details: {
        runId: staleRun.id,
        actor: staleRun.actor,
        updatedAt: staleRun.updatedAt,
      },
    });
  }

  const registryIssues = collectPrimitiveRegistryReferenceIssues(workspacePath, inventory);
  issues.push(...registryIssues);

  if (inventory) {
    const emptyDirectoryIssues = collectEmptyPrimitiveDirectoryIssues(workspacePath, inventory);
    issues.push(...emptyDirectoryIssues);
  }

  const checks: DoctorChecks = {
    orphanWikiLinks: countIssues(issues, 'orphan-wiki-link'),
    staleClaims: countIssues(issues, 'stale-claim'),
    staleRuns: countIssues(issues, 'stale-run'),
    missingRequiredFields: countIssues(issues, 'missing-required-field'),
    brokenPrimitiveRegistryReferences: countIssues(issues, 'broken-primitive-registry-reference'),
    emptyPrimitiveDirectories: countIssues(issues, 'empty-primitive-directory'),
    duplicateSlugs: countIssues(issues, 'duplicate-slug'),
  };

  return {
    issues: issues.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.code.localeCompare(b.code)),
    checks,
    orphanLinks: primitiveGraph.missingLinks,
    staleClaims,
    staleRuns,
  };
}

function collectStaleClaims(workspacePath: string, staleAfterMs: number, now: number): StaleClaim[] {
  const staleClaims: StaleClaim[] = [];
  const claims = ledger.allClaims(workspacePath);
  for (const [target, owner] of claims.entries()) {
    const history = ledger.historyOf(workspacePath, target);
    const lastClaim = history.slice().reverse().find((entry) => entry.op === 'claim');
    if (!lastClaim) continue;
    const claimTs = Date.parse(lastClaim.ts);
    if (!Number.isFinite(claimTs)) continue;
    const ageMs = now - claimTs;
    if (ageMs <= staleAfterMs) continue;
    staleClaims.push({
      target,
      owner,
      claimedAt: lastClaim.ts,
      ageMs,
    });
  }
  return staleClaims.sort((a, b) => b.ageMs - a.ageMs || a.target.localeCompare(b.target));
}

function collectStaleRuns(workspacePath: string, staleAfterMs: number, now: number): StaleRun[] {
  const runs = readDispatchRunsSnapshot(workspacePath)
    .filter((run) => run.status === 'running');
  const staleRuns: StaleRun[] = [];
  for (const run of runs) {
    const updatedTs = Date.parse(run.updatedAt);
    if (!Number.isFinite(updatedTs)) continue;
    const ageMs = now - updatedTs;
    if (ageMs <= staleAfterMs) continue;
    staleRuns.push({
      id: run.id,
      actor: run.actor,
      updatedAt: run.updatedAt,
      ageMs,
    });
  }
  return staleRuns.sort((a, b) => b.ageMs - a.ageMs || a.id.localeCompare(b.id));
}

function collectPrimitiveRegistryReferenceIssues(workspacePath: string, inventory: PrimitiveInventory | null): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  const manifestPath = path.join(workspacePath, '.workgraph', 'primitive-registry.yaml');
  if (!fs.existsSync(manifestPath)) {
    issues.push({
      code: 'broken-primitive-registry-reference',
      severity: 'error',
      message: 'Missing .workgraph/primitive-registry.yaml',
      path: '.workgraph/primitive-registry.yaml',
    });
    return issues;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (error) {
    issues.push({
      code: 'broken-primitive-registry-reference',
      severity: 'error',
      message: `Unable to parse primitive-registry.yaml: ${errorMessage(error)}`,
      path: '.workgraph/primitive-registry.yaml',
    });
    return issues;
  }

  const primitives = (parsed as { primitives?: Array<Record<string, unknown>> })?.primitives;
  if (!Array.isArray(primitives)) {
    issues.push({
      code: 'broken-primitive-registry-reference',
      severity: 'error',
      message: 'primitive-registry.yaml is missing a "primitives" array.',
      path: '.workgraph/primitive-registry.yaml',
    });
    return issues;
  }

  const seenNames = new Map<string, number>();
  for (const primitiveEntry of primitives) {
    const name = String(primitiveEntry.name ?? '').trim();
    const directory = String(primitiveEntry.directory ?? '').trim();
    if (!name || !directory) {
      issues.push({
        code: 'broken-primitive-registry-reference',
        severity: 'error',
        message: 'primitive-registry.yaml contains an entry with missing name or directory.',
        path: '.workgraph/primitive-registry.yaml',
      });
      continue;
    }

    seenNames.set(name, (seenNames.get(name) ?? 0) + 1);
    const registryType = inventory?.typeDefs.get(name);
    if (!registryType) {
      issues.push({
        code: 'broken-primitive-registry-reference',
        severity: 'error',
        message: `primitive-registry.yaml references unknown primitive "${name}".`,
        path: '.workgraph/primitive-registry.yaml',
      });
      continue;
    }
    if (registryType.directory !== directory) {
      issues.push({
        code: 'broken-primitive-registry-reference',
        severity: 'error',
        message: `primitive-registry.yaml directory mismatch for "${name}": expected "${registryType.directory}", got "${directory}".`,
        path: '.workgraph/primitive-registry.yaml',
      });
    }
    if (!fs.existsSync(path.join(workspacePath, directory))) {
      issues.push({
        code: 'broken-primitive-registry-reference',
        severity: 'error',
        message: `primitive-registry.yaml references missing directory "${directory}/".`,
        path: '.workgraph/primitive-registry.yaml',
      });
    }
  }

  for (const [name, count] of seenNames.entries()) {
    if (count <= 1) continue;
    issues.push({
      code: 'broken-primitive-registry-reference',
      severity: 'error',
      message: `primitive-registry.yaml has duplicate entries for primitive "${name}".`,
      path: '.workgraph/primitive-registry.yaml',
    });
  }

  if (inventory) {
    const manifestNames = new Set(primitives.map((entry) => String(entry.name ?? '').trim()).filter(Boolean));
    for (const typeName of inventory.typeDefs.keys()) {
      if (manifestNames.has(typeName)) continue;
      issues.push({
        code: 'broken-primitive-registry-reference',
        severity: 'warning',
        message: `Registry type "${typeName}" is missing from primitive-registry.yaml.`,
        path: '.workgraph/primitive-registry.yaml',
      });
    }
  }

  return issues;
}

function collectEmptyPrimitiveDirectoryIssues(workspacePath: string, inventory: PrimitiveInventory): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  for (const typeDef of inventory.typeDefs.values()) {
    const directoryPath = path.join(workspacePath, typeDef.directory);
    if (!fs.existsSync(directoryPath)) continue;
    const markdownCount = listMarkdownFilesRecursive(directoryPath).length;
    if (markdownCount > 0) continue;
    issues.push({
      code: 'empty-primitive-directory',
      severity: 'warning',
      message: `Primitive directory "${typeDef.directory}/" is empty.`,
      path: `${typeDef.directory}/`,
      details: {
        type: typeDef.name,
      },
    });
  }
  return issues;
}

function removeOrphanLinks(
  workspacePath: string,
  orphanLinks: MissingWikiLink[],
): { removedLinks: number; filesUpdated: string[]; errors: string[] } {
  const errors: string[] = [];
  const filesUpdated: string[] = [];
  if (orphanLinks.length === 0) {
    return { removedLinks: 0, filesUpdated, errors };
  }

  const tokensBySource = new Map<string, Set<string>>();
  for (const orphan of orphanLinks) {
    const tokenSet = tokensBySource.get(orphan.from) ?? new Set<string>();
    tokenSet.add(orphan.token);
    tokensBySource.set(orphan.from, tokenSet);
  }

  let removedLinks = 0;
  for (const [sourcePath, tokenSet] of tokensBySource.entries()) {
    const absPath = path.join(workspacePath, sourcePath);
    if (!fs.existsSync(absPath)) continue;
    try {
      const raw = fs.readFileSync(absPath, 'utf-8');
      let fileRemoved = 0;
      const updated = raw.replace(/\[\[([^[\]]+)\]\]/g, (token) => {
        if (!tokenSet.has(token)) return token;
        fileRemoved += 1;
        return '';
      });
      if (fileRemoved === 0) continue;
      fs.writeFileSync(absPath, updated, 'utf-8');
      removedLinks += fileRemoved;
      filesUpdated.push(sourcePath);
    } catch (error) {
      errors.push(`Failed to remove orphan links from ${sourcePath}: ${errorMessage(error)}`);
    }
  }

  return {
    removedLinks,
    filesUpdated: filesUpdated.sort((a, b) => a.localeCompare(b)),
    errors,
  };
}

function releaseStaleClaims(
  workspacePath: string,
  staleClaims: StaleClaim[],
): { released: number; errors: string[] } {
  const errors: string[] = [];
  let released = 0;
  for (const staleClaim of staleClaims) {
    try {
      thread.release(
        workspacePath,
        staleClaim.target,
        staleClaim.owner,
        'Auto-release stale claim by workgraph doctor',
      );
      released += 1;
    } catch (error) {
      const fallbackActor = staleClaim.owner || DOCTOR_ACTOR;
      try {
        ledger.append(workspacePath, fallbackActor, 'release', staleClaim.target, 'thread', {
          reason: 'Auto-release stale claim by workgraph doctor',
        });
        const existing = store.read(workspacePath, staleClaim.target);
        if (existing) {
          store.update(
            workspacePath,
            staleClaim.target,
            { status: 'open', owner: null },
            undefined,
            fallbackActor,
          );
        }
        released += 1;
      } catch (fallbackError) {
        errors.push(
          `Failed to release stale claim ${staleClaim.target}: ${errorMessage(error)} / fallback: ${errorMessage(fallbackError)}`,
        );
      }
    }
  }
  return { released, errors };
}

function cancelStaleRuns(
  workspacePath: string,
  staleRuns: StaleRun[],
  actor: string,
): { cancelled: number; errors: string[] } {
  const errors: string[] = [];
  let cancelled = 0;
  for (const staleRun of staleRuns) {
    try {
      dispatch.stop(workspacePath, staleRun.id, actor);
      cancelled += 1;
    } catch (error) {
      errors.push(`Failed to cancel stale run ${staleRun.id}: ${errorMessage(error)}`);
    }
  }
  return { cancelled, errors };
}

function readDispatchRunsSnapshot(workspacePath: string): DispatchRunSnapshot[] {
  const runsPath = path.join(workspacePath, '.workgraph', 'dispatch-runs.json');
  if (!fs.existsSync(runsPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(runsPath, 'utf-8')) as { runs?: DispatchRunSnapshot[] };
    return Array.isArray(parsed.runs)
      ? parsed.runs
      : [];
  } catch {
    return [];
  }
}

function listMarkdownFilesRecursive(rootDirectory: string): string[] {
  const files: string[] = [];
  const stack = [rootDirectory];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(absPath);
      }
    }
  }
  return files;
}

function isMissingRequiredValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  return false;
}

function countIssues(issues: DoctorIssue[], code: string): number {
  return issues.filter((issue) => issue.code === code).length;
}

function severityRank(severity: DoctorSeverity): number {
  return severity === 'error' ? 0 : 1;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
