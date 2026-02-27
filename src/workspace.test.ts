import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initWorkspace, isWorkgraphWorkspace, workspaceConfigPath } from './workspace.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-workspace-'));
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('workspace init', () => {
  it('creates a pure workgraph workspace with registry and type directories', () => {
    const result = initWorkspace(workspacePath, { name: 'agent-space' });

    expect(result.config.name).toBe('agent-space');
    expect(isWorkgraphWorkspace(workspacePath)).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, '.clawvault/registry.json'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'threads'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'spaces'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'agents'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'skills'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, '.clawvault/primitive-registry.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, '.clawvault/bases/thread.base'))).toBe(true);
    expect(result.seededTypes).toContain('thread');
    expect(result.generatedBases.length).toBeGreaterThan(0);
  });

  it('supports no-type-dirs and no-readme mode', () => {
    initWorkspace(workspacePath, { createTypeDirs: false, createReadme: false, createBases: false });
    expect(fs.existsSync(path.join(workspacePath, '.clawvault/registry.json'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, '.clawvault/primitive-registry.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'threads'))).toBe(false);
    expect(fs.existsSync(path.join(workspacePath, 'README.md'))).toBe(false);
    expect(fs.existsSync(path.join(workspacePath, '.clawvault/bases/thread.base'))).toBe(false);
  });

  it('fails on re-initialization', () => {
    initWorkspace(workspacePath);
    expect(() => initWorkspace(workspacePath)).toThrow('already initialized');
  });

  it('writes workspace config in predictable location', () => {
    initWorkspace(workspacePath);
    expect(fs.existsSync(workspaceConfigPath(workspacePath))).toBe(true);
  });
});
