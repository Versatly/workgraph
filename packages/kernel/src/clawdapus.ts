import {
  fetchSkillMarkdownFromUrl,
  installSkillIntegration,
  type InstallSkillIntegrationOptions,
  type InstallSkillIntegrationResult,
  type SkillIntegrationProvider,
} from './integration-core.js';

export const DEFAULT_CLAWDAPUS_SKILL_URL =
  'https://raw.githubusercontent.com/mostlydev/clawdapus/master/skills/clawdapus/SKILL.md';

export const CLAWDAPUS_INTEGRATION_PROVIDER: SkillIntegrationProvider = {
  id: 'clawdapus',
  defaultTitle: 'clawdapus',
  defaultSourceUrl: DEFAULT_CLAWDAPUS_SKILL_URL,
  distribution: 'clawdapus-optional-integration',
  defaultTags: ['clawdapus'],
  userAgent: '@versatly/workgraph clawdapus-optional-integration',
};

export type InstallClawdapusSkillOptions = InstallSkillIntegrationOptions;
export type InstallClawdapusSkillResult = InstallSkillIntegrationResult;

export async function installClawdapusSkill(
  workspacePath: string,
  options: InstallClawdapusSkillOptions,
): Promise<InstallClawdapusSkillResult> {
  return installSkillIntegration(
    workspacePath,
    CLAWDAPUS_INTEGRATION_PROVIDER,
    options,
  );
}

export async function fetchClawdapusSkillMarkdown(sourceUrl: string): Promise<string> {
  return fetchSkillMarkdownFromUrl(sourceUrl, CLAWDAPUS_INTEGRATION_PROVIDER.userAgent);
}
