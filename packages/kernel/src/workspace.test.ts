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
  it('creates a starter workspace with seeded primitives and onboarding docs', () => {
    const result = initWorkspace(workspacePath, { name: 'agent-space' });

    expect(result.config.name).toBe('agent-space');
    expect(result.alreadyInitialized).toBe(false);
    expect(isWorkgraphWorkspace(workspacePath)).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, '.workgraph/registry.json'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'threads'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'spaces'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'agents'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'skills'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'onboarding'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'QUICKSTART.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, '.workgraph/server.json'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, '.workgraph/primitive-registry.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, '.workgraph/bases/thread.base'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, '.workgraph/graph-index.json'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'roles/admin.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'roles/ops.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'roles/contributor.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'roles/viewer.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'policies/registration-approval.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'policies/thread-lifecycle.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'policies/escalation.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'policy-gates/completion.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'spaces/general.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, result.bootstrapTrustTokenPath))).toBe(true);
    expect(result.bootstrapTrustToken).toMatch(/^wg-bootstrap-[a-f0-9]{24}$/);
    expect(result.seededTypes).toContain('thread');
    expect(result.seededTypes).toContain('role');
    expect(result.seededTypes).toContain('trust-token');
    expect(result.generatedBases.length).toBeGreaterThan(0);

    expect(readFile(path.join(workspacePath, 'roles/admin.md'))).toMatch(/^---\n[\s\S]+?\n---\n/);
    expect(readFile(path.join(workspacePath, 'policies/registration-approval.md'))).toMatch(/^---\n[\s\S]+?\n---\n/);
    expect(readFile(path.join(workspacePath, 'policy-gates/completion.md'))).toMatch(/^---\n[\s\S]+?\n---\n/);
    expect(readFile(path.join(workspacePath, 'QUICKSTART.md'))).toContain('Start the server');
    expect(readFile(path.join(workspacePath, 'QUICKSTART.md'))).toContain('Register your first agent');
  });

  it('supports no-type-dirs and no-readme mode', () => {
    const result = initWorkspace(workspacePath, { createTypeDirs: false, createReadme: false, createBases: false });
    expect(fs.existsSync(path.join(workspacePath, '.workgraph/registry.json'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, '.workgraph/primitive-registry.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'threads'))).toBe(false);
    expect(fs.existsSync(path.join(workspacePath, 'README.md'))).toBe(false);
    expect(fs.existsSync(path.join(workspacePath, 'QUICKSTART.md'))).toBe(false);
    expect(fs.existsSync(path.join(workspacePath, 'roles/admin.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'policy-gates/completion.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, result.bootstrapTrustTokenPath))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, '.workgraph/bases/thread.base'))).toBe(false);
  });

  it('is idempotent and preserves existing workspace data on re-run', () => {
    const first = initWorkspace(workspacePath);
    const adminPath = path.join(workspacePath, 'roles/admin.md');
    const edited = `${readFile(adminPath).trim()}\n\n## Team override\n\nKeep this custom note.\n`;
    fs.writeFileSync(adminPath, edited, 'utf-8');

    const second = initWorkspace(workspacePath);

    expect(second.alreadyInitialized).toBe(true);
    expect(second.bootstrapTrustToken).toBe(first.bootstrapTrustToken);
    expect(readFile(adminPath)).toContain('## Team override');
    expect(readFile(adminPath)).toContain('Keep this custom note.');
    expect(fs.existsSync(path.join(workspacePath, 'roles/admin.md'))).toBe(true);
  });

  it('writes workspace config in predictable location', () => {
    initWorkspace(workspacePath);
    expect(fs.existsSync(workspaceConfigPath(workspacePath))).toBe(true);
  });
});

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}
