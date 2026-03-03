import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, saveRegistry } from './registry.js';
import { installIntegration, listIntegrations } from './integration.js';
import { loadSkill } from './skill.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-integration-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('integration registry', () => {
  it('lists supported optional integrations', () => {
    const integrations = listIntegrations();
    expect(integrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'clawdapus',
          defaultTitle: 'clawdapus',
        }),
      ]),
    );
  });

  it('installs clawdapus through generic integration dispatcher', async () => {
    const result = await installIntegration(workspacePath, 'clawdapus', {
      actor: 'agent-ops',
      fetchSkillMarkdown: async () => '# Imported Through Registry',
    });

    expect(result.provider).toBe('clawdapus');
    expect(result.skill.path).toBe('skills/clawdapus/SKILL.md');
    expect(loadSkill(workspacePath, 'clawdapus').body).toContain('Imported Through Registry');
  });

  it('throws a clear error for unknown integrations', async () => {
    await expect(
      installIntegration(workspacePath, 'unknown-provider', {
        actor: 'agent-ops',
      }),
    ).rejects.toThrow('Unknown integration "unknown-provider"');
  });
});
