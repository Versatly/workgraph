import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadRegistry, saveRegistry } from './registry.js';
import { onboardWorkspace } from './onboard.js';
import { read as readPrimitive } from './store.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-onboard-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('onboard workspace', () => {
  it('creates onboarding artifacts including onboarding primitive', () => {
    const result = onboardWorkspace(workspacePath, {
      actor: 'agent-setup',
      spaces: ['platform', 'product'],
      createDemoThreads: true,
    });

    expect(result.spacesCreated.length).toBe(2);
    expect(result.threadsCreated.length).toBeGreaterThan(0);
    expect(result.boardPath).toBe('ops/Onboarding Board.md');
    expect(result.commandCenterPath).toBe('ops/Onboarding Command Center.md');
    expect(result.onboardingPath).toContain('onboarding/');

    const onboarding = readPrimitive(workspacePath, result.onboardingPath);
    expect(onboarding).not.toBeNull();
    expect(onboarding?.type).toBe('onboarding');
    expect(onboarding?.fields.actor).toBe('agent-setup');
    expect(onboarding?.fields.status).toBe('active');
  });
});
