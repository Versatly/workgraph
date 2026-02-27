import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  generateBasesFromPrimitiveRegistry,
  primitiveRegistryManifestPath,
  readPrimitiveRegistryManifest,
  syncPrimitiveRegistryManifest,
} from './bases.js';
import { defineType, loadRegistry, saveRegistry } from './registry.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-bases-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('bases generation', () => {
  it('syncs primitive-registry.yaml from registry definitions', () => {
    const manifest = syncPrimitiveRegistryManifest(workspacePath);
    const manifestPath = primitiveRegistryManifestPath(workspacePath);
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(manifest.primitives.some((primitive) => primitive.name === 'thread')).toBe(true);
    expect(manifest.primitives.some((primitive) => primitive.name === 'skill')).toBe(true);

    const parsed = readPrimitiveRegistryManifest(workspacePath);
    const thread = parsed.primitives.find((primitive) => primitive.name === 'thread');
    expect(thread?.canonical).toBe(true);
    expect(thread?.fields.some((field) => field.name === 'space')).toBe(true);
  });

  it('generates .base files for canonical primitives by default', () => {
    syncPrimitiveRegistryManifest(workspacePath);
    const result = generateBasesFromPrimitiveRegistry(workspacePath);

    expect(result.generated.some((filePath) => filePath.endsWith('/thread.base'))).toBe(true);
    expect(result.generated.some((filePath) => filePath.endsWith('/skill.base'))).toBe(true);

    const threadBase = path.join(workspacePath, '.clawvault/bases/thread.base');
    expect(fs.existsSync(threadBase)).toBe(true);
    expect(fs.readFileSync(threadBase, 'utf-8')).toContain('source:');
  });

  it('can include non-canonical primitive types', () => {
    defineType(workspacePath, 'playbook', 'Reusable orchestration guide', {
      stages: { type: 'list', default: [] },
    }, 'agent-architect');
    syncPrimitiveRegistryManifest(workspacePath);
    const defaultResult = generateBasesFromPrimitiveRegistry(workspacePath);
    expect(defaultResult.generated.some((filePath) => filePath.endsWith('/playbook.base'))).toBe(false);

    const allResult = generateBasesFromPrimitiveRegistry(workspacePath, {
      includeNonCanonical: true,
    });
    expect(allResult.generated.some((filePath) => filePath.endsWith('/playbook.base'))).toBe(true);
  });
});
