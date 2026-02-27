/**
 * Skill primitive lifecycle.
 */

import path from 'node:path';
import * as store from './store.js';
import * as thread from './thread.js';
import type { PrimitiveInstance } from './types.js';

export interface WriteSkillOptions {
  owner?: string;
  version?: string;
  status?: 'draft' | 'proposed' | 'active' | 'deprecated' | 'archived';
  distribution?: string;
  tailscalePath?: string;
  reviewers?: string[];
  tags?: string[];
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
  const relPath = pathForSkillTitle(title);
  const existing = store.read(workspacePath, relPath);
  const status = options.status ?? (existing?.fields.status as string | undefined) ?? 'draft';

  if (!existing) {
    return store.create(workspacePath, 'skill', {
      title,
      owner: options.owner ?? actor,
      version: options.version ?? '0.1.0',
      status,
      distribution: options.distribution ?? 'tailscale-shared-vault',
      tailscale_path: options.tailscalePath,
      reviewers: options.reviewers ?? [],
      tags: options.tags ?? [],
    }, body, actor);
  }

  return store.update(workspacePath, existing.path, {
    title,
    owner: options.owner ?? existing.fields.owner ?? actor,
    version: options.version ?? existing.fields.version ?? '0.1.0',
    status,
    distribution: options.distribution ?? existing.fields.distribution ?? 'tailscale-shared-vault',
    tailscale_path: options.tailscalePath ?? existing.fields.tailscale_path,
    reviewers: options.reviewers ?? existing.fields.reviewers ?? [],
    tags: options.tags ?? existing.fields.tags ?? [],
  }, body, actor);
}

export function loadSkill(workspacePath: string, skillRef: string): PrimitiveInstance {
  const normalized = normalizeSkillRef(skillRef);
  const skill = store.read(workspacePath, normalized);
  if (!skill) throw new Error(`Skill not found: ${skillRef}`);
  if (skill.type !== 'skill') throw new Error(`Target is not a skill primitive: ${skillRef}`);
  return skill;
}

export function listSkills(
  workspacePath: string,
  options: { status?: string } = {},
): PrimitiveInstance[] {
  let skills = store.list(workspacePath, 'skill');
  if (options.status) {
    skills = skills.filter((skill) => skill.fields.status === options.status);
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

  return store.update(workspacePath, skill.path, {
    status: 'proposed',
    proposal_thread: proposalThread ?? skill.fields.proposal_thread,
    proposed_at: new Date().toISOString(),
    reviewers: options.reviewers ?? skill.fields.reviewers ?? [],
  }, undefined, actor);
}

export function promoteSkill(
  workspacePath: string,
  skillRef: string,
  actor: string,
  options: PromoteSkillOptions = {},
): PrimitiveInstance {
  const skill = loadSkill(workspacePath, skillRef);
  const currentVersion = String(skill.fields.version ?? '0.1.0');
  const nextVersion = options.version ?? bumpPatchVersion(currentVersion);

  return store.update(workspacePath, skill.path, {
    status: 'active',
    version: nextVersion,
    promoted_at: new Date().toISOString(),
  }, undefined, actor);
}

function pathForSkillTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return `skills/${slug}.md`;
}

function normalizeSkillRef(skillRef: string): string {
  const raw = skillRef.trim();
  if (!raw) return raw;
  if (raw.includes('/')) {
    return raw.endsWith('.md') ? raw : `${raw}.md`;
  }
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return `skills/${slug}.md`;
}

function bumpPatchVersion(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return '0.1.0';
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10) + 1;
  return `${major}.${minor}.${patch}`;
}
