/**
 * Dynamic primitive type registry.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { FieldDefinition, PrimitiveTypeDefinition, Registry } from './types.js';
import * as ledger from './ledger.js';

const REGISTRY_FILE = '.workgraph/registry.json';
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
      status:      {
        type: 'string',
        required: true,
        default: 'open',
        enum: ['open', 'active', 'blocked', 'done', 'cancelled'],
        description: 'open | active | blocked | done | cancelled',
      },
      owner:       { type: 'string', description: 'Agent that claimed this thread' },
      priority:    {
        type: 'string',
        default: 'medium',
        enum: ['urgent', 'high', 'medium', 'low'],
        description: 'urgent | high | medium | low',
      },
      deps:        { type: 'list', default: [], description: 'Thread refs this depends on' },
      parent:      { type: 'ref', refTypes: ['thread'], description: 'Parent thread if decomposed from larger thread' },
      tid:         { type: 'string', description: 'Thread slug identifier (T-ID)' },
      space:       { type: 'ref', refTypes: ['space'], description: 'Space ref this thread belongs to' },
      context_refs:{ type: 'list', default: [], description: 'Docs that inform this work' },
      tags:        { type: 'list', default: [], description: 'Freeform tags' },
      gates:       { type: 'list', default: [], description: 'Policy-gate refs that must pass before claim' },
      approvals:   { type: 'list', default: [], description: 'Approvals granted for gate checks' },
      terminalLock:{ type: 'boolean', default: true, description: 'Whether done status is terminally locked' },
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
      status:      { type: 'string', default: 'draft', enum: ['draft', 'proposed', 'approved', 'active', 'superseded', 'reverted'], description: 'draft | proposed | approved | active | superseded | reverted' },
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
      tags:        { type: 'list', default: [], description: 'Classification tags for downstream synthesis' },
      created:     { type: 'date', required: true },
      updated:     { type: 'date', required: true },
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
    name: 'presence',
    description: 'Agent heartbeat presence status for runtime coordination.',
    directory: 'agents',
    builtIn: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'system',
    fields: {
      name:         { type: 'string', required: true },
      status:       {
        type: 'string',
        required: true,
        default: 'online',
        enum: ['online', 'busy', 'offline'],
        description: 'online | busy | offline',
      },
      current_task: { type: 'string', description: 'Current thread slug/path' },
      last_seen:    { type: 'date', required: true },
      capabilities: { type: 'list', default: [], description: 'Agent capability tags' },
      created:      { type: 'date', required: true },
      updated:      { type: 'date', required: true },
    },
  },
  {
    name: 'person',
    description: 'A human stakeholder referenced by projects, clients, and incidents.',
    directory: 'people',
    builtIn: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'system',
    fields: {
      name: { type: 'string', required: true },
      email: { type: 'string', template: 'email' },
      role: { type: 'string' },
      client: { type: 'ref', refTypes: ['client'] },
      project_refs: { type: 'list', default: [] },
      tags: { type: 'list', default: [] },
      created: { type: 'date', required: true },
      updated: { type: 'date', required: true },
    },
  },
  {
    name: 'client',
    description: 'An external customer/account coordinated in the workgraph.',
    directory: 'clients',
    builtIn: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'system',
    fields: {
      name: { type: 'string', required: true },
      status: { type: 'string', default: 'active', enum: ['prospect', 'active', 'paused', 'closed'] },
      owner: { type: 'string' },
      contact_ref: { type: 'ref', refTypes: ['person'] },
      project_refs: { type: 'list', default: [] },
      tags: { type: 'list', default: [] },
      created: { type: 'date', required: true },
      updated: { type: 'date', required: true },
    },
  },
  {
    name: 'project',
    description: 'A coordinated initiative spanning multiple threads and stakeholders.',
    directory: 'projects',
    builtIn: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'system',
    fields: {
      title: { type: 'string', required: true },
      status: { type: 'string', default: 'active', enum: ['planned', 'active', 'blocked', 'done', 'cancelled'] },
      owner: { type: 'string' },
      client: { type: 'ref', refTypes: ['client'] },
      member_refs: { type: 'list', default: [] },
      thread_refs: { type: 'list', default: [] },
      tags: { type: 'list', default: [] },
      created: { type: 'date', required: true },
      updated: { type: 'date', required: true },
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
      status:       { type: 'string', required: true, default: 'draft', enum: ['draft', 'proposed', 'active', 'deprecated', 'archived'], description: 'draft | proposed | active | deprecated | archived' },
      version:      { type: 'string', default: '0.1.0', template: 'semver', description: 'Semantic version of this skill' },
      owner:        { type: 'string', description: 'Primary skill owner/maintainer' },
      reviewers:    { type: 'list', default: [], description: 'Reviewers involved in proposal' },
      proposal_thread: { type: 'ref', description: 'Thread coordinating review/promotion' },
      proposed_at:  { type: 'date' },
      promoted_at:  { type: 'date' },
      depends_on:   { type: 'list', default: [], description: 'Skill dependencies by slug or path' },
      distribution: { type: 'string', default: 'shared-vault', description: 'Distribution channel for skill usage' },
      tags:         { type: 'list', default: [] },
      created:      { type: 'date', required: true },
      updated:      { type: 'date', required: true },
    },
  },
  {
    name: 'onboarding',
    description: 'Agent or team onboarding lifecycle primitive.',
    directory: 'onboarding',
    builtIn: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'system',
    fields: {
      title: { type: 'string', required: true },
      actor: { type: 'string', required: true },
      status: { type: 'string', default: 'active', enum: ['active', 'completed', 'paused'] },
      spaces: { type: 'list', default: [] },
      thread_refs: { type: 'list', default: [] },
      board: { type: 'ref' },
      command_center: { type: 'ref' },
      created: { type: 'date', required: true },
      updated: { type: 'date', required: true },
      tags: { type: 'list', default: [] },
    },
  },
  {
    name: 'policy',
    description: 'Governance policy primitive for approvals and guardrails.',
    directory: 'policies',
    builtIn: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'system',
    fields: {
      title: { type: 'string', required: true },
      status: { type: 'string', default: 'draft', enum: ['draft', 'proposed', 'approved', 'active', 'retired'] },
      scope: { type: 'string', default: 'workspace' },
      approvers: { type: 'list', default: [] },
      created: { type: 'date', required: true },
      updated: { type: 'date', required: true },
      tags: { type: 'list', default: [] },
    },
  },
  {
    name: 'policy-gate',
    description: 'Quality gate rules that must pass before thread claim.',
    directory: 'policy-gates',
    builtIn: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'system',
    fields: {
      title: { type: 'string', required: true },
      status: { type: 'string', default: 'active', enum: ['draft', 'active', 'approved', 'retired'] },
      required_facts: { type: 'list', default: [] },
      required_approvals: { type: 'list', default: [] },
      min_age_seconds: { type: 'number', default: 0 },
      requiredDescendants: { type: 'boolean', default: false },
      evidencePolicy: { type: 'string', default: 'strict', enum: ['strict', 'relaxed', 'none'] },
      created: { type: 'date', required: true },
      updated: { type: 'date', required: true },
      tags: { type: 'list', default: [] },
    },
  },
  {
    name: 'incident',
    description: 'Incident coordination primitive with gated lifecycle.',
    directory: 'incidents',
    builtIn: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'system',
    fields: {
      title: { type: 'string', required: true },
      severity: { type: 'string', default: 'sev3', enum: ['sev0', 'sev1', 'sev2', 'sev3', 'sev4'] },
      status: { type: 'string', default: 'draft', enum: ['draft', 'proposed', 'approved', 'active', 'resolved', 'closed'] },
      owner: { type: 'string' },
      created: { type: 'date', required: true },
      updated: { type: 'date', required: true },
      tags: { type: 'list', default: [] },
    },
  },
  {
    name: 'trigger',
    description: 'Event trigger contract with policy-aware activation.',
    directory: 'triggers',
    builtIn: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'system',
    fields: {
      title: { type: 'string', required: true },
      event: { type: 'string', description: 'Legacy event selector for compatibility' },
      condition: { type: 'any', description: 'Condition object (cron/event/file-watch/thread-complete)' },
      status: { type: 'string', default: 'draft', enum: ['draft', 'proposed', 'approved', 'active', 'paused', 'retired'] },
      action: { type: 'any', required: true },
      cooldown: { type: 'number', default: 0 },
      cascade_on: { type: 'list', default: [] },
      synthesis: { type: 'any', description: 'Optional synthesis-specific trigger configuration' },
      idempotency_scope: { type: 'string', default: 'event+target' },
      created: { type: 'date', required: true },
      updated: { type: 'date', required: true },
      tags: { type: 'list', default: [] },
    },
  },
  {
    name: 'checkpoint',
    description: 'Agent checkpoint/hand-off primitive for orientation continuity.',
    directory: 'checkpoints',
    builtIn: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'system',
    fields: {
      title: { type: 'string', required: true },
      actor: { type: 'string', required: true },
      summary: { type: 'string', required: true },
      next: { type: 'list', default: [] },
      blocked: { type: 'list', default: [] },
      created: { type: 'date', required: true },
      updated: { type: 'date', required: true },
      tags: { type: 'list', default: [] },
    },
  },
  {
    name: 'run',
    description: 'Background agent run primitive with lifecycle state.',
    directory: 'runs',
    builtIn: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'system',
    fields: {
      title: { type: 'string', required: true },
      objective: { type: 'string', required: true },
      runtime: { type: 'string', required: true },
      status: { type: 'string', required: true, default: 'queued', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] },
      run_id: { type: 'string', required: true },
      owner: { type: 'string' },
      lease_expires: { type: 'date' },
      lease_duration_minutes: { type: 'number' },
      last_heartbeat: { type: 'date' },
      heartbeat_timestamps: { type: 'list', default: [] },
      created: { type: 'date', required: true },
      updated: { type: 'date', required: true },
      tags: { type: 'list', default: [] },
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
  ledger.append(workspacePath, actor, 'define', '.workgraph/registry.json', safeName, {
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
      continue;
    }
    const existing = registry.types[t.name];
    if (existing.builtIn) {
      registry.types[t.name] = {
        ...existing,
        description: t.description,
        directory: t.directory,
        fields: {
          ...existing.fields,
          ...t.fields,
        },
      };
    }
  }
  // Remove deprecated skill transport field to keep schema infrastructure-agnostic.
  if (registry.types.skill?.builtIn && 'tailscale_path' in registry.types.skill.fields) {
    delete registry.types.skill.fields.tailscale_path;
  }
  return registry;
}
