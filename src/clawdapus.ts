import { loadSkill, writeSkill, type WriteSkillOptions } from './skill.js';
import type { PrimitiveInstance } from './types.js';

export const DEFAULT_CLAWDAPUS_SKILL_URL =
  'https://raw.githubusercontent.com/mostlydev/clawdapus/master/skills/clawdapus/SKILL.md';

export interface InstallClawdapusSkillOptions {
  actor: string;
  owner?: string;
  title?: string;
  sourceUrl?: string;
  force?: boolean;
  status?: WriteSkillOptions['status'];
  tags?: string[];
  fetchSkillMarkdown?: (sourceUrl: string) => Promise<string>;
}

export interface InstallClawdapusSkillResult {
  skill: PrimitiveInstance;
  sourceUrl: string;
  importedAt: string;
  replacedExisting: boolean;
}

export async function installClawdapusSkill(
  workspacePath: string,
  options: InstallClawdapusSkillOptions,
): Promise<InstallClawdapusSkillResult> {
  const actor = options.actor.trim();
  if (!actor) {
    throw new Error('Clawdapus integration requires a non-empty actor.');
  }

  const title = options.title?.trim() || 'clawdapus';
  const sourceUrl = options.sourceUrl?.trim() || DEFAULT_CLAWDAPUS_SKILL_URL;
  const existing = loadSkillIfExists(workspacePath, title);
  if (existing && !options.force) {
    throw new Error(
      `Skill "${title}" already exists at ${existing.path}. Use --force to refresh it from source.`,
    );
  }

  const fetchSkillMarkdown = options.fetchSkillMarkdown ?? fetchClawdapusSkillMarkdown;
  const markdown = await fetchSkillMarkdown(sourceUrl);
  if (!markdown.trim()) {
    throw new Error(`Downloaded Clawdapus skill from ${sourceUrl} is empty.`);
  }

  const skill = writeSkill(workspacePath, title, markdown, actor, {
    owner: options.owner ?? actor,
    status: options.status,
    distribution: 'clawdapus-optional-integration',
    tags: mergeTags(options.tags),
  });

  return {
    skill,
    sourceUrl,
    importedAt: new Date().toISOString(),
    replacedExisting: existing !== null,
  };
}

export async function fetchClawdapusSkillMarkdown(sourceUrl: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(sourceUrl, {
      headers: {
        'user-agent': '@versatly/workgraph clawdapus-optional-integration',
      },
    });
  } catch (error) {
    throw new Error(
      `Failed to download Clawdapus skill from ${sourceUrl}: ${errorMessage(error)}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Failed to download Clawdapus skill from ${sourceUrl}: HTTP ${response.status} ${response.statusText}`,
    );
  }
  return response.text();
}

function loadSkillIfExists(workspacePath: string, skillRef: string): PrimitiveInstance | null {
  try {
    return loadSkill(workspacePath, skillRef);
  } catch (error) {
    const message = errorMessage(error);
    if (message.startsWith('Skill not found:')) {
      return null;
    }
    throw error;
  }
}

function mergeTags(tags: string[] | undefined): string[] {
  const merged = new Set<string>(['clawdapus', 'optional-integration']);
  for (const tag of tags ?? []) {
    const normalized = tag.trim();
    if (normalized) merged.add(normalized);
  }
  return [...merged];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
