import {
  CLAWDAPUS_INTEGRATION_PROVIDER,
  installClawdapusSkill,
} from './clawdapus.js';
import type {
  InstallSkillIntegrationOptions,
  InstallSkillIntegrationResult,
  SkillIntegrationProvider,
} from './integration-core.js';

export interface IntegrationDescriptor {
  id: string;
  description: string;
  defaultTitle: string;
  defaultSourceUrl: string;
}

interface IntegrationRegistration {
  provider: SkillIntegrationProvider;
  description: string;
  install: (
    workspacePath: string,
    options: InstallSkillIntegrationOptions,
  ) => Promise<InstallSkillIntegrationResult>;
}

const INTEGRATIONS: Record<string, IntegrationRegistration> = {
  clawdapus: {
    provider: CLAWDAPUS_INTEGRATION_PROVIDER,
    description: 'Infrastructure-layer governance skill import for AI agent containers.',
    install: installClawdapusSkill,
  },
};

export function listIntegrations(): IntegrationDescriptor[] {
  return Object.values(INTEGRATIONS).map((integration) => ({
    id: integration.provider.id,
    description: integration.description,
    defaultTitle: integration.provider.defaultTitle,
    defaultSourceUrl: integration.provider.defaultSourceUrl,
  }));
}

export async function installIntegration(
  workspacePath: string,
  integrationId: string,
  options: InstallSkillIntegrationOptions,
): Promise<InstallSkillIntegrationResult> {
  const integration = INTEGRATIONS[integrationId.trim().toLowerCase()];
  if (!integration) {
    throw new Error(
      `Unknown integration "${integrationId}". Supported integrations: ${supportedIntegrationList()}.`,
    );
  }
  return integration.install(workspacePath, options);
}

function supportedIntegrationList(): string {
  return Object.keys(INTEGRATIONS).sort().join(', ');
}
