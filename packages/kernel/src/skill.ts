/**
 * Skill primitive lifecycle.
 */

import path from 'node:path';
import fs from './storage-fs.js';
import * as store from './store.js';
import * as thread from './thread.js';
import * as ledger from './ledger.js';
import type { LedgerEntry, PrimitiveInstance } from './types.js';

export interface WriteSkillOptions {
  owner?: string;
  version?: string;
  status?: 'draft' | 'proposed' | 'active' | 'deprecated' | 'archived';
  distribution?: string;
  reviewers?: string[];
  tags?: string[];
  dependsOn?: string[];
  expectedUpdatedAt?: string;
  tailscalePath?: string;
}

export interface ProposeSkillOptions {
  proposalThread?: string;
  createThreadIfMissing?: boolean;
  space?: string;
  reviewers?: string[];
}

export interface PromoteSkillOptions {
  version?: string;
}

export function writeSkill(
  workspacePath: string,
  title: string,
  body: string,
  actor: string,
  options: WriteSkillOptions = {},
): PrimitiveInstance {
  const slug = skillSlug(title);
  const bundleSkillPath = folderSkillPath(slug);
  const legacyPath = legacySkillPath(slug);
  const existing = store.read(workspacePath, bundleSkillPath) ?? store.read(workspacePath, legacyPath);
  const status = options.status ?? (existing?.fields.status as string | undefined) ?? 'draft';

  if (existing && options.expectedUpdatedAt) {
    const currentUpdatedAt = String(existing.fields.updated ?? '');
    if (currentUpdatedAt !== options.expectedUpdatedAt) {
      throw new Error(`Concurrent skill update detected for ${existing.path}. Expected updated="${options.expectedUpdatedAt}" but found "${currentUpdatedAt}".`);
    }
  }

  if (!existing) {
    ensureSkillBundleScaffold(workspacePath, slug);
    const created = store.create(workspacePath, 'skill', {
      title,
      owner: options.owner ?? actor,
      version: options.version ?? '0.1.0',
      status,
      distribution: options.distribution ?? 'shared-vault',
      reviewers: options.reviewers ?? [],
      depends_on: options.dependsOn ?? [],
      tags: options.tags ?? [],
    }, body, actor, {
      pathOverride: bundleSkillPath,
    });
    writeSkillManifest(workspacePath, slug, created, actor);
    return created;
  }

  const updated = store.update(workspacePath, existing.path, {
    title,
    owner: options.owner ?? existing.fields.owner ?? actor,
    version: options.version ?? existing.fields.version ?? '0.1.0',
    status,
    distribution: options.distribution ?? existing.fields.distribution ?? 'shared-vault',
    reviewers: options.reviewers ?? existing.fields.reviewers ?? [],
    depends_on: options.dependsOn ?? existing.fields.depends_on ?? [],
    tags: options.tags ?? existing.fields.tags ?? [],
  }, body, actor);
  writeSkillManifest(workspacePath, slug, updated, actor);
  return updated;
}

export function loadSkill(workspacePath: string, skillRef: string): PrimitiveInstance {
  const normalizedCandidates = normalizeSkillRefCandidates(skillRef);
  const skill = normalizedCandidates
    .map((candidate) => store.read(workspacePath, candidate))
    .find((entry): entry is PrimitiveInstance => entry !== null);
  if (!skill) throw new Error(`Skill not found: ${skillRef}`);
  if (skill.type !== 'skill') throw new Error(`Target is not a skill primitive: ${skillRef}`);
  return skill;
}

export function listSkills(
  workspacePath: string,
  options: { status?: string; updatedSince?: string } = {},
): PrimitiveInstance[] {
  let skills = store.list(workspacePath, 'skill');
  if (options.status) {
    skills = skills.filter((skill) => skill.fields.status === options.status);
  }
  if (options.updatedSince) {
    const threshold = Date.parse(options.updatedSince);
    if (Number.isFinite(threshold)) {
      skills = skills.filter((skill) => {
        const updatedAt = Date.parse(String(skill.fields.updated ?? ''));
        return Number.isFinite(updatedAt) && updatedAt >= threshold;
      });
    }
  }
  return skills;
}

export function proposeSkill(
  workspacePath: string,
  skillRef: string,
  actor: string,
  options: ProposeSkillOptions = {},
): PrimitiveInstance {
  const skill = loadSkill(workspacePath, skillRef);
  const slug = skillSlug(String(skill.fields.title ?? skillRef));

  let proposalThread = options.proposalThread;
  if (!proposalThread && options.createThreadIfMissing !== false) {
    const createdThread = thread.createThread(
      workspacePath,
      `Review skill: ${String(skill.fields.title)}`,
      `Review and approve skill ${skill.path} for activation.`,
      actor,
      {
        priority: 'medium',
        space: options.space,
        context_refs: [skill.path],
      },
    );
    proposalThread = createdThread.path;
  }

  const updated = store.update(workspacePath, skill.path, {
    status: 'proposed',
    proposal_thread: proposalThread ?? skill.fields.proposal_thread,
    proposed_at: new Date().toISOString(),
    reviewers: options.reviewers ?? skill.fields.reviewers ?? [],
  }, undefined, actor);
  writeSkillManifest(workspacePath, slug, updated, actor);
  return updated;
}

export function skillHistory(
  workspacePath: string,
  skillRef: string,
  options: { limit?: number } = {},
): LedgerEntry[] {
  const skill = loadSkill(workspacePath, skillRef);
  const entries = ledger.historyOf(workspacePath, skill.path);
  if (options.limit && options.limit > 0) {
    return entries.slice(-options.limit);
  }
  return entries;
}

export function skillDiff(
  workspacePath: string,
  skillRef: string,
): {
  path: string;
  latestEntryTs: string | null;
  previousEntryTs: string | null;
  changedFields: string[];
} {
  const skill = loadSkill(workspacePath, skillRef);
  const entries = ledger.historyOf(workspacePath, skill.path).filter((entry) => entry.op === 'create' || entry.op === 'update');
  const latest = entries.length > 0 ? entries[entries.length - 1] : null;
  const previous = entries.length > 1 ? entries[entries.length - 2] : null;
  const changedFields = Array.isArray(latest?.data?.changed)
    ? latest!.data!.changed.map((value) => String(value))
    : latest?.op === 'create'
      ? Object.keys(skill.fields)
      : [];
  return {
    path: skill.path,
    latestEntryTs: latest?.ts ?? null,
    previousEntryTs: previous?.ts ?? null,
    changedFields,
  };
}

export function promoteSkill(
  workspacePath: string,
  skillRef: string,
  actor: string,
  options: PromoteSkillOptions = {},
): PrimitiveInstance {
  const skill = loadSkill(workspacePath, skillRef);
  const slug = skillSlug(String(skill.fields.title ?? skillRef));
  const currentVersion = String(skill.fields.version ?? '0.1.0');
  const nextVersion = options.version ?? bumpPatchVersion(currentVersion);

  const updated = store.update(workspacePath, skill.path, {
    status: 'active',
    version: nextVersion,
    promoted_at: new Date().toISOString(),
  }, undefined, actor);
  writeSkillManifest(workspacePath, slug, updated, actor);
  return updated;
}

function skillSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function normalizeSkillRefCandidates(skillRef: string): string[] {
  const raw = skillRef.trim();
  if (!raw) return [];
  if (raw.includes('/')) {
    const normalized = raw.endsWith('.md') ? raw : `${raw}.md`;
    if (normalized.endsWith('/SKILL.md')) return [normalized];
    if (normalized.endsWith('/SKILL')) return [`${normalized}.md`];
    if (normalized.endsWith('.md')) {
      const noExt = normalized.slice(0, -3);
      return [normalized, `${noExt}/SKILL.md`];
    }
    return [normalized, `${normalized}/SKILL.md`];
  }
  const slug = skillSlug(raw);
  return [folderSkillPath(slug), legacySkillPath(slug)];
}

function bumpPatchVersion(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return '0.1.0';
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10) + 1;
  return `${major}.${minor}.${patch}`;
}

function folderSkillPath(slug: string): string {
  return `skills/${slug}/SKILL.md`;
}

function legacySkillPath(slug: string): string {
  return `skills/${slug}.md`;
}

function ensureSkillBundleScaffold(workspacePath: string, slug: string): void {
  const skillRoot = path.join(workspacePath, 'skills', slug);
  fs.mkdirSync(skillRoot, { recursive: true });
  for (const subdir of ['scripts', 'examples', 'tests', 'assets']) {
    fs.mkdirSync(path.join(skillRoot, subdir), { recursive: true });
  }
}

function writeSkillManifest(
  workspacePath: string,
  slug: string,
  skill: PrimitiveInstance,
  actor: string,
): void {
  const manifestPath = path.join(workspacePath, 'skills', slug, 'skill-manifest.json');
  const dir = path.dirname(manifestPath);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    version: 1,
    slug,
    title: String(skill.fields.title ?? slug),
    primitivePath: skill.path,
    owner: String(skill.fields.owner ?? actor),
    skillVersion: String(skill.fields.version ?? '0.1.0'),
    status: String(skill.fields.status ?? 'draft'),
    dependsOn: Array.isArray(skill.fields.depends_on)
      ? skill.fields.depends_on.map((value) => String(value))
      : [],
    components: {
      skillDoc: 'SKILL.md',
      scriptsDir: 'scripts/',
      examplesDir: 'examples/',
      testsDir: 'tests/',
      assetsDir: 'assets/',
    },
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}
