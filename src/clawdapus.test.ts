import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, saveRegistry } from './registry.js';
import {
  DEFAULT_CLAWDAPUS_SKILL_URL,
  installClawdapusSkill,
} from './clawdapus.js';
import { loadSkill } from './skill.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-clawdapus-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('clawdapus optional integration', () => {
  it('installs clawdapus skill into workspace via injected source loader', async () => {
    const result = await installClawdapusSkill(workspacePath, {
      actor: 'agent-ops',
      fetchSkillMarkdown: async (sourceUrl) => {
        expect(sourceUrl).toBe(DEFAULT_CLAWDAPUS_SKILL_URL);
        return '# Clawdapus\n\nImported content.';
      },
    });

    expect(result.replacedExisting).toBe(false);
    expect(result.skill.path).toBe('skills/clawdapus/SKILL.md');
    expect(result.skill.fields.distribution).toBe('clawdapus-optional-integration');
    expect(result.skill.fields.owner).toBe('agent-ops');
    expect(result.skill.fields.tags).toEqual(
      expect.arrayContaining(['clawdapus', 'optional-integration']),
    );

    const loaded = loadSkill(workspacePath, 'clawdapus');
    expect(loaded.body).toContain('Imported content.');
  });

  it('refuses to overwrite an existing imported skill unless force is set', async () => {
    await installClawdapusSkill(workspacePath, {
      actor: 'agent-ops',
      fetchSkillMarkdown: async () => '# v1',
    });

    await expect(
      installClawdapusSkill(workspacePath, {
        actor: 'agent-ops',
        fetchSkillMarkdown: async () => '# v2',
      }),
    ).rejects.toThrow('Use --force to refresh it from source.');
  });

  it('refreshes existing skill content when force is true', async () => {
    await installClawdapusSkill(workspacePath, {
      actor: 'agent-ops',
      fetchSkillMarkdown: async () => '# v1',
    });

    const refreshed = await installClawdapusSkill(workspacePath, {
      actor: 'agent-ops',
      force: true,
      fetchSkillMarkdown: async () => '# v2',
    });

    expect(refreshed.replacedExisting).toBe(true);
    expect(loadSkill(workspacePath, 'clawdapus').body).toContain('# v2');
  });

  it('propagates source fetch errors with context', async () => {
    await expect(
      installClawdapusSkill(workspacePath, {
        actor: 'agent-ops',
        fetchSkillMarkdown: async () => {
          throw new Error('network down');
        },
      }),
    ).rejects.toThrow('network down');
  });
});
