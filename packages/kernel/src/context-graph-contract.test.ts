import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listContextLenses } from './lens.js';
import {
  assertCoreContextGraphInvariants,
  CORE_CONTEXT_GRAPH_CONTRACT,
  evaluateCoreContextGraphInvariants,
} from './context-graph-contract.js';
import { loadRegistry, saveRegistry } from './registry.js';
import { PRIMITIVE_QUERY_FILTER_KEYS } from './query.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-context-contract-'));
  const registry = loadRegistry(workspacePath);
  saveRegistry(workspacePath, registry);
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('core context graph contract', () => {
  it('locks a versioned primitive and relationship contract snapshot', () => {
    expect(CORE_CONTEXT_GRAPH_CONTRACT).toMatchSnapshot();
  });

  it('enforces invariants for registry plus query/lens contracts', () => {
    const report = evaluateCoreContextGraphInvariants({
      registry: loadRegistry(workspacePath),
      queryFilterKeys: PRIMITIVE_QUERY_FILTER_KEYS,
      lenses: listContextLenses(),
    });
    expect(report).toMatchSnapshot();
    expect(report.ok).toBe(true);
    expect(() =>
      assertCoreContextGraphInvariants({
        registry: loadRegistry(workspacePath),
        queryFilterKeys: PRIMITIVE_QUERY_FILTER_KEYS,
        lenses: listContextLenses(),
      })
    ).not.toThrow();
  });

  it('detects relationship drift when required link fields are removed', () => {
    const registry = loadRegistry(workspacePath);
    delete registry.types.thread.fields.space;

    const report = evaluateCoreContextGraphInvariants({
      registry,
      queryFilterKeys: PRIMITIVE_QUERY_FILTER_KEYS,
      lenses: listContextLenses(),
    });
    expect(report.ok).toBe(false);
    expect(report.violations.some((violation) =>
      violation.code === 'relationship-field-missing' && violation.relationshipId === 'thread.space'
    )).toBe(true);
  });
});
