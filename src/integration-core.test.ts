import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, saveRegistry } from './registry.js';
import {
  fetchSkillMarkdownFromUrl,
  installSkillIntegration,
  type SkillIntegrationProvider,
} from './integration-core.js';
import { loadSkill } from './skill.js';

let workspacePath: string;

const provider: SkillIntegrationProvider = {
  id: 'provider-x',
  defaultTitle: 'Provider Skill',
  defaultSourceUrl: 'https://example.com/skill.md',
  distribution: 'remote',
  defaultTags: ['provider', 'docs'],
  userAgent: 'workgraph-test-agent',
};

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-integration-core-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('integration-core module', () => {
  it('installs a skill integration with merged tags and metadata', async () => {
    const result = await installSkillIntegration(workspacePath, provider, {
      actor: 'agent-integrator',
      owner: 'team-knowledge',
      tags: ['custom', 'docs'],
      fetchSkillMarkdown: async () => '# Imported Skill\n\nUse carefully.',
    });

    expect(result.provider).toBe('provider-x');
    expect(result.replacedExisting).toBe(false);
    expect(result.skill.path).toBe('skills/provider-skill/SKILL.md');
    expect(result.sourceUrl).toBe(provider.defaultSourceUrl);
    expect(result.skill.fields.owner).toBe('team-knowledge');
    expect(result.skill.fields.distribution).toBe('remote');
    expect(result.skill.fields.tags).toEqual(
      expect.arrayContaining(['optional-integration', 'provider', 'docs', 'custom']),
    );
  });

  it('requires a non-empty actor', async () => {
    await expect(
      installSkillIntegration(workspacePath, provider, {
        actor: '   ',
        fetchSkillMarkdown: async () => '# content',
      }),
    ).rejects.toThrow('requires a non-empty actor');
  });

  it('rejects install when skill already exists unless force is enabled', async () => {
    await installSkillIntegration(workspacePath, provider, {
      actor: 'agent-integrator',
      fetchSkillMarkdown: async () => '# First content',
    });

    await expect(
      installSkillIntegration(workspacePath, provider, {
        actor: 'agent-integrator',
        fetchSkillMarkdown: async () => '# Second content',
      }),
    ).rejects.toThrow('already exists');
  });

  it('replaces existing skill when force is true', async () => {
    await installSkillIntegration(workspacePath, provider, {
      actor: 'agent-integrator',
      fetchSkillMarkdown: async () => '# Old version',
    });

    const refreshed = await installSkillIntegration(workspacePath, provider, {
      actor: 'agent-integrator',
      force: true,
      fetchSkillMarkdown: async () => '# New version',
    });

    expect(refreshed.replacedExisting).toBe(true);
    const loaded = loadSkill(workspacePath, 'provider-skill');
    expect(loaded.body).toContain('New version');
  });

  it('fails when downloaded markdown is empty', async () => {
    await expect(
      installSkillIntegration(workspacePath, provider, {
        actor: 'agent-integrator',
        fetchSkillMarkdown: async () => '   \n\n',
      }),
    ).rejects.toThrow('is empty');
  });

  it('fetches skill markdown from URL and forwards custom user-agent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('# Remote skill body', {
        status: 200,
        statusText: 'OK',
      }),
    );

    const markdown = await fetchSkillMarkdownFromUrl(
      'https://example.com/remote-skill.md',
      'custom-agent/1.0',
    );

    expect(markdown).toBe('# Remote skill body');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.com/remote-skill.md',
      expect.objectContaining({
        headers: {
          'user-agent': 'custom-agent/1.0',
        },
      }),
    );
  });

  it('wraps network and HTTP failures during skill download', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(
      fetchSkillMarkdownFromUrl('https://example.com/fail-network.md'),
    ).rejects.toThrow('Failed to download skill from https://example.com/fail-network.md: socket hang up');

    fetchSpy.mockResolvedValueOnce(
      new Response('not found', {
        status: 404,
        statusText: 'Not Found',
      }),
    );
    await expect(
      fetchSkillMarkdownFromUrl('https://example.com/fail-http.md'),
    ).rejects.toThrow('HTTP 404 Not Found');
  });
});
