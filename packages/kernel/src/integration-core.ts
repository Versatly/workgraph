import { loadSkill, writeSkill, type WriteSkillOptions } from './skill.js';
import type { PrimitiveInstance } from './types.js';

export interface SkillIntegrationProvider {
  id: string;
  defaultTitle: string;
  defaultSourceUrl: string;
  distribution: string;
  defaultTags: string[];
  userAgent?: string;
}

export interface InstallSkillIntegrationOptions {
  actor: string;
  owner?: string;
  title?: string;
  sourceUrl?: string;
  force?: boolean;
  status?: WriteSkillOptions['status'];
  tags?: string[];
  fetchSkillMarkdown?: (sourceUrl: string) => Promise<string>;
}

export interface InstallSkillIntegrationResult {
  provider: string;
  skill: PrimitiveInstance;
  sourceUrl: string;
  importedAt: string;
  replacedExisting: boolean;
}

export async function installSkillIntegration(
  workspacePath: string,
  provider: SkillIntegrationProvider,
  options: InstallSkillIntegrationOptions,
): Promise<InstallSkillIntegrationResult> {
  const actor = options.actor.trim();
  if (!actor) {
    throw new Error(`${provider.id} integration requires a non-empty actor.`);
  }

  const title = options.title?.trim() || provider.defaultTitle;
  const sourceUrl = options.sourceUrl?.trim() || provider.defaultSourceUrl;
  const existing = loadSkillIfExists(workspacePath, title);
  if (existing && !options.force) {
    throw new Error(
      `Skill "${title}" already exists at ${existing.path}. Use --force to refresh it from source.`,
    );
  }

  const fetchSkillMarkdown =
    options.fetchSkillMarkdown ??
    ((url: string) => fetchSkillMarkdownFromUrl(url, provider.userAgent));
  const markdown = await fetchSkillMarkdown(sourceUrl);
  if (!markdown.trim()) {
    throw new Error(`Downloaded ${provider.id} skill from ${sourceUrl} is empty.`);
  }

  const skill = writeSkill(workspacePath, title, markdown, actor, {
    owner: options.owner ?? actor,
    status: options.status,
    distribution: provider.distribution,
    tags: mergeTags(provider.defaultTags, options.tags),
  });

  return {
    provider: provider.id,
    skill,
    sourceUrl,
    importedAt: new Date().toISOString(),
    replacedExisting: existing !== null,
  };
}

export async function fetchSkillMarkdownFromUrl(
  sourceUrl: string,
  userAgent = '@versatly/workgraph optional-integration',
): Promise<string> {
  let response;
  try {
    response = await fetch(sourceUrl, {
      headers: {
        'user-agent': userAgent,
      },
    });
  } catch (error) {
    throw new Error(
      `Failed to download skill from ${sourceUrl}: ${errorMessage(error)}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Failed to download skill from ${sourceUrl}: HTTP ${response.status} ${response.statusText}`,
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

function mergeTags(defaultTags: string[], tags: string[] | undefined): string[] {
  const merged = new Set<string>(['optional-integration']);
  for (const tag of defaultTags) {
    const normalized = tag.trim();
    if (normalized) merged.add(normalized);
  }
  for (const tag of tags ?? []) {
    const normalized = tag.trim();
    if (normalized) merged.add(normalized);
  }
  return [...merged];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
