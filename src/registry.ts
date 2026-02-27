/**
 * Dynamic primitive type registry.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { FieldDefinition, PrimitiveTypeDefinition, Registry } from './types.js';
import * as ledger from './ledger.js';

const REGISTRY_FILE = '.clawvault/registry.json';
const CURRENT_VERSION = 1;

// ---------------------------------------------------------------------------
// Built-in primitive types
// ---------------------------------------------------------------------------

const BUILT_IN_TYPES: PrimitiveTypeDefinition[] = [
  {
    name: 'thread',
    description: 'A unit of coordinated work. The core workgraph node.',
    directory: 'threads',
    builtIn: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'system',
    fields: {
      title:       { type: 'string', required: true, description: 'What this thread is about' },
      goal:        { type: 'string', required: true, description: 'What success looks like' },
      status:      { type: 'string', required: true, default: 'open', description: 'open | active | blocked | done | cancelled' },
      owner:       { type: 'string', description: 'Agent that claimed this thread' },
      priority:    { type: 'string', default: 'medium', description: 'urgent | high | medium | low' },
      deps:        { type: 'list', default: [], description: 'Thread refs this depends on' },
      parent:      { type: 'ref', description: 'Parent thread if decomposed from larger thread' },
      space:       { type: 'ref', description: 'Space ref this thread belongs to' },
      context_refs:{ type: 'list', default: [], description: 'Docs that inform this work' },
      tags:        { type: 'list', default: [], description: 'Freeform tags' },
      created:     { type: 'date', required: true },
      updated:     { type: 'date', required: true },
    },
  },
  {
    name: 'space',
    description: 'A workspace boundary that groups related threads and sets context.',
    directory: 'spaces',
    builtIn: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'system',
    fields: {
      title:       { type: 'string', required: true, description: 'Space name' },
      description: { type: 'string', description: 'What this space is for' },
      members:     { type: 'list', default: [], description: 'Agent names that participate' },
      thread_refs: { type: 'list', default: [], description: 'Thread refs in this space' },
      tags:        { type: 'list', default: [], description: 'Freeform tags' },
      created:     { type: 'date', required: true },
      updated:     { type: 'date', required: true },
    },
  },
  {
    name: 'decision',
    description: 'A recorded decision with reasoning and context.',
    directory: 'decisions',
    builtIn: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'system',
    fields: {
      title:       { type: 'string', required: true },
      date:        { type: 'date', required: true },
      status:      { type: 'string', default: 'active', description: 'active | superseded | reverted' },
      context_refs:{ type: 'list', default: [], description: 'What informed this decision' },
      tags:        { type: 'list', default: [] },
    },
  },
  {
    name: 'lesson',
    description: 'A captured insight or pattern learned from experience.',
    directory: 'lessons',
    builtIn: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'system',
    fields: {
      title:       { type: 'string', required: true },
      date:        { type: 'date', required: true },
      confidence:  { type: 'string', default: 'medium', description: 'high | medium | low' },
      context_refs:{ type: 'list', default: [] },
      tags:        { type: 'list', default: [] },
    },
  },
  {
    name: 'fact',
    description: 'A structured piece of knowledge with optional temporal validity.',
    directory: 'facts',
    builtIn: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'system',
    fields: {
      subject:     { type: 'string', required: true },
      predicate:   { type: 'string', required: true },
      object:      { type: 'string', required: true },
      confidence:  { type: 'number', default: 1.0 },
      valid_from:  { type: 'date' },
      valid_until: { type: 'date' },
      source:      { type: 'ref', description: 'Where this fact came from' },
    },
  },
  {
    name: 'agent',
    description: 'A registered participant in the workgraph.',
    directory: 'agents',
    builtIn: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'system',
    fields: {
      name:         { type: 'string', required: true },
      role:         { type: 'string', description: 'What this agent specializes in' },
      capabilities: { type: 'list', default: [], description: 'What this agent can do' },
      active_threads: { type: 'list', default: [], description: 'Threads currently claimed' },
      last_seen:    { type: 'date' },
    },
  },
  {
    name: 'skill',
    description: 'A reusable agent skill shared through the workgraph workspace.',
    directory: 'skills',
    builtIn: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'system',
    fields: {
      title:        { type: 'string', required: true, description: 'Skill title' },
      status:       { type: 'string', required: true, default: 'draft', description: 'draft | proposed | active | deprecated | archived' },
      version:      { type: 'string', default: '0.1.0', description: 'Semantic version of this skill' },
      owner:        { type: 'string', description: 'Primary skill owner/maintainer' },
      reviewers:    { type: 'list', default: [], description: 'Reviewers involved in proposal' },
      proposal_thread: { type: 'ref', description: 'Thread coordinating review/promotion' },
      proposed_at:  { type: 'date' },
      promoted_at:  { type: 'date' },
      distribution: { type: 'string', default: 'tailscale-shared-vault', description: 'Distribution channel for skill usage' },
      tailscale_path: { type: 'string', description: 'Shared vault path over Tailscale' },
      tags:         { type: 'list', default: [] },
      created:      { type: 'date', required: true },
      updated:      { type: 'date', required: true },
    },
  },
];

// ---------------------------------------------------------------------------
// Registry operations
// ---------------------------------------------------------------------------

export function registryPath(workspacePath: string): string {
  return path.join(workspacePath, REGISTRY_FILE);
}

export function loadRegistry(workspacePath: string): Registry {
  const rPath = registryPath(workspacePath);
  if (fs.existsSync(rPath)) {
    const raw = fs.readFileSync(rPath, 'utf-8');
    const registry: Registry = JSON.parse(raw);
    return ensureBuiltIns(registry);
  }
  return seedRegistry();
}

export function saveRegistry(workspacePath: string, registry: Registry): void {
  const rPath = registryPath(workspacePath);
  const dir = path.dirname(rPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(rPath, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
}

export function defineType(
  workspacePath: string,
  name: string,
  description: string,
  fields: Record<string, FieldDefinition>,
  actor: string,
  directory?: string,
): PrimitiveTypeDefinition {
  const registry = loadRegistry(workspacePath);
  const safeName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');

  if (registry.types[safeName]?.builtIn) {
    throw new Error(`Cannot redefine built-in type "${safeName}". You can extend it with new fields instead.`);
  }

  const now = new Date().toISOString();
  const typeDef: PrimitiveTypeDefinition = {
    name: safeName,
    description,
    fields: {
      title:   { type: 'string', required: true },
      created: { type: 'date', required: true },
      updated: { type: 'date', required: true },
      tags:    { type: 'list', default: [] },
      ...fields,
    },
    directory: directory ?? `${safeName}s`,
    builtIn: false,
    createdAt: now,
    createdBy: actor,
  };

  registry.types[safeName] = typeDef;
  saveRegistry(workspacePath, registry);
  ledger.append(workspacePath, actor, 'define', '.clawvault/registry.json', safeName, {
    name: safeName,
    directory: typeDef.directory,
    fields: Object.keys(typeDef.fields),
  });
  return typeDef;
}

export function getType(workspacePath: string, name: string): PrimitiveTypeDefinition | undefined {
  const registry = loadRegistry(workspacePath);
  return registry.types[name];
}

export function listTypes(workspacePath: string): PrimitiveTypeDefinition[] {
  const registry = loadRegistry(workspacePath);
  return Object.values(registry.types);
}

export function extendType(
  workspacePath: string,
  name: string,
  newFields: Record<string, FieldDefinition>,
  _actor: string,
): PrimitiveTypeDefinition {
  const registry = loadRegistry(workspacePath);
  const existing = registry.types[name];
  if (!existing) throw new Error(`Type "${name}" not found in registry.`);

  existing.fields = { ...existing.fields, ...newFields };
  saveRegistry(workspacePath, registry);
  return existing;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function seedRegistry(): Registry {
  const types: Record<string, PrimitiveTypeDefinition> = {};
  for (const t of BUILT_IN_TYPES) {
    types[t.name] = t;
  }
  return { version: CURRENT_VERSION, types };
}

function ensureBuiltIns(registry: Registry): Registry {
  for (const t of BUILT_IN_TYPES) {
    if (!registry.types[t.name]) {
      registry.types[t.name] = t;
    }
  }
  return registry;
}
