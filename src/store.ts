/**
 * Workgraph store — CRUD for primitive instances.
 */

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { loadRegistry, getType } from './registry.js';
import * as ledger from './ledger.js';
import * as graph from './graph.js';
import * as policy from './policy.js';
import type { PrimitiveInstance, PrimitiveTypeDefinition } from './types.js';

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export function create(
  workspacePath: string,
  typeName: string,
  fields: Record<string, unknown>,
  body: string,
  actor: string,
): PrimitiveInstance {
  const typeDef = getType(workspacePath, typeName);
  if (!typeDef) {
    throw new Error(`Unknown primitive type "${typeName}". Run \`workgraph primitive list\` to see available types, or \`workgraph primitive define\` to create one.`);
  }

  const now = new Date().toISOString();
  const merged = applyDefaults(typeDef, {
    ...fields,
    created: fields.created ?? now,
    updated: now,
  });
  const initialStatus = typeof merged.status === 'string'
    ? String(merged.status)
    : undefined;
  const createPolicyDecision = policy.canTransitionStatus(
    workspacePath,
    actor,
    typeName,
    'draft',
    initialStatus ?? 'draft',
  );
  if (!createPolicyDecision.allowed) {
    throw new Error(createPolicyDecision.reason ?? 'Policy gate blocked create transition.');
  }
  validateFields(workspacePath, typeDef, merged, 'create');

  const slug = slugify(String(merged.title ?? merged.name ?? typeName));
  const relDir = typeDef.directory;
  const relPath = `${relDir}/${slug}.md`;
  const absDir = path.join(workspacePath, relDir);
  const absPath = path.join(workspacePath, relPath);

  if (!fs.existsSync(absDir)) fs.mkdirSync(absDir, { recursive: true });
  if (fs.existsSync(absPath)) {
    throw new Error(`File already exists: ${relPath}. Use update instead.`);
  }

  const content = matter.stringify(body, stripUndefined(merged));
  fs.writeFileSync(absPath, content, 'utf-8');

  ledger.append(workspacePath, actor, 'create', relPath, typeName, {
    title: merged.title ?? slug,
    ...(typeof merged.status === 'string' ? { status: merged.status } : {}),
  });
  graph.refreshWikiLinkGraphIndex(workspacePath);

  return { path: relPath, type: typeName, fields: merged, body };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function read(workspacePath: string, relPath: string): PrimitiveInstance | null {
  const absPath = path.join(workspacePath, relPath);
  if (!fs.existsSync(absPath)) return null;

  const raw = fs.readFileSync(absPath, 'utf-8');
  const { data, content } = matter(raw);

  const typeName = inferType(workspacePath, relPath);
  return { path: relPath, type: typeName, fields: data, body: content.trim() };
}

export function list(workspacePath: string, typeName: string): PrimitiveInstance[] {
  const typeDef = getType(workspacePath, typeName);
  if (!typeDef) return [];

  const dir = path.join(workspacePath, typeDef.directory);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  const instances: PrimitiveInstance[] = [];

  for (const file of files) {
    const relPath = `${typeDef.directory}/${file}`;
    const inst = read(workspacePath, relPath);
    if (inst) instances.push(inst);
  }

  return instances;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export function update(
  workspacePath: string,
  relPath: string,
  fieldUpdates: Record<string, unknown>,
  bodyUpdate: string | undefined,
  actor: string,
): PrimitiveInstance {
  const existing = read(workspacePath, relPath);
  if (!existing) throw new Error(`Not found: ${relPath}`);

  const now = new Date().toISOString();
  const newFields: Record<string, unknown> = { ...existing.fields, ...fieldUpdates, updated: now };
  const typeDef = getType(workspacePath, existing.type);
  if (!typeDef) throw new Error(`Unknown primitive type "${existing.type}" for ${relPath}`);
  const previousStatus = typeof existing.fields['status'] === 'string'
    ? String(existing.fields['status'])
    : undefined;
  const nextStatus = typeof newFields['status'] === 'string'
    ? String(newFields['status'])
    : undefined;
  const transitionDecision = policy.canTransitionStatus(
    workspacePath,
    actor,
    existing.type,
    previousStatus,
    nextStatus,
  );
  if (!transitionDecision.allowed) {
    throw new Error(transitionDecision.reason ?? 'Policy gate blocked status transition.');
  }

  validateFields(workspacePath, typeDef, newFields, 'update');
  const newBody = bodyUpdate ?? existing.body;
  const absPath = path.join(workspacePath, relPath);

  const content = matter.stringify(newBody, stripUndefined(newFields));
  fs.writeFileSync(absPath, content, 'utf-8');

  ledger.append(workspacePath, actor, 'update', relPath, existing.type, {
    changed: Object.keys(fieldUpdates),
    ...(previousStatus !== nextStatus && nextStatus
      ? {
          from_status: previousStatus ?? null,
          to_status: nextStatus,
        }
      : {}),
  });
  graph.refreshWikiLinkGraphIndex(workspacePath);

  return { path: relPath, type: existing.type, fields: newFields, body: newBody };
}

// ---------------------------------------------------------------------------
// Delete (soft — moves to .workgraph/archive/)
// ---------------------------------------------------------------------------

export function remove(workspacePath: string, relPath: string, actor: string): void {
  const absPath = path.join(workspacePath, relPath);
  if (!fs.existsSync(absPath)) throw new Error(`Not found: ${relPath}`);

  const archiveDir = path.join(workspacePath, '.workgraph', 'archive');
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

  const archivePath = path.join(archiveDir, path.basename(relPath));
  fs.renameSync(absPath, archivePath);

  const typeName = inferType(workspacePath, relPath);
  ledger.append(workspacePath, actor, 'delete', relPath, typeName);
  graph.refreshWikiLinkGraphIndex(workspacePath);
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export function findByField(
  workspacePath: string,
  typeName: string,
  field: string,
  value: unknown,
): PrimitiveInstance[] {
  return list(workspacePath, typeName).filter(inst => inst.fields[field] === value);
}

export function openThreads(workspacePath: string): PrimitiveInstance[] {
  return findByField(workspacePath, 'thread', 'status', 'open');
}

export function activeThreads(workspacePath: string): PrimitiveInstance[] {
  return findByField(workspacePath, 'thread', 'status', 'active');
}

export function blockedThreads(workspacePath: string): PrimitiveInstance[] {
  return findByField(workspacePath, 'thread', 'status', 'blocked');
}

export function threadsInSpace(workspacePath: string, spaceRef: string): PrimitiveInstance[] {
  const normalizedTarget = normalizeRefPath(spaceRef);
  return list(workspacePath, 'thread').filter((thread) => {
    const rawSpace = thread.fields.space;
    if (!rawSpace) return false;
    return normalizeRefPath(rawSpace) === normalizedTarget;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function applyDefaults(
  typeDef: PrimitiveTypeDefinition,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...fields };
  for (const [key, def] of Object.entries(typeDef.fields)) {
    if (result[key] === undefined && def.default !== undefined) {
      result[key] = def.default;
    }
  }
  return result;
}

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) result[k] = v;
  }
  return result;
}

function inferType(workspacePath: string, relPath: string): string {
  const registry = loadRegistry(workspacePath);
  const dir = relPath.split('/')[0];

  for (const typeDef of Object.values(registry.types)) {
    if (typeDef.directory === dir) return typeDef.name;
  }
  return 'unknown';
}

function normalizeRefPath(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const unwrapped = raw.startsWith('[[') && raw.endsWith(']]')
    ? raw.slice(2, -2)
    : raw;
  return unwrapped.endsWith('.md') ? unwrapped : `${unwrapped}.md`;
}

function validateFields(
  workspacePath: string,
  typeDef: PrimitiveTypeDefinition,
  fields: Record<string, unknown>,
  mode: 'create' | 'update',
): void {
  const issues: string[] = [];

  for (const [fieldName, definition] of Object.entries(typeDef.fields)) {
    const value = fields[fieldName];
    if (definition.required && isMissingRequiredValue(value)) {
      issues.push(`Missing required field "${fieldName}"`);
      continue;
    }
    if (value === undefined || value === null) continue;
    if (!isFieldTypeCompatible(definition.type, value)) {
      issues.push(`Field "${fieldName}" expected ${definition.type}, got ${describeValue(value)}`);
      continue;
    }

    if (definition.enum && definition.enum.length > 0 && !definition.enum.includes(value as string | number | boolean)) {
      issues.push(`Field "${fieldName}" must be one of [${definition.enum.join(', ')}]`);
      continue;
    }

    if (definition.template && typeof value === 'string' && !matchesTemplate(definition.template, value)) {
      issues.push(`Field "${fieldName}" does not satisfy template "${definition.template}"`);
      continue;
    }

    if (definition.pattern && typeof value === 'string') {
      let expression: RegExp;
      try {
        expression = new RegExp(definition.pattern);
      } catch {
        issues.push(`Field "${fieldName}" has invalid pattern "${definition.pattern}"`);
        continue;
      }
      if (!expression.test(value)) {
        issues.push(`Field "${fieldName}" does not match pattern "${definition.pattern}"`);
        continue;
      }
    }

    if (definition.type === 'ref' && typeof value === 'string') {
      const refValidation = validateRefValue(workspacePath, value, definition.refTypes);
      if (!refValidation.ok) {
        issues.push(refValidation.reason);
        continue;
      }
    }
  }

  if (issues.length > 0) {
    throw new Error(`Invalid ${typeDef.name} ${mode} payload: ${issues.join('; ')}`);
  }
}

function isMissingRequiredValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' && value.trim().length === 0) return true;
  return false;
}

function isFieldTypeCompatible(type: PrimitiveTypeDefinition['fields'][string]['type'], value: unknown): boolean {
  switch (type) {
    case 'string':
    case 'ref':
      return typeof value === 'string';
    case 'date':
      return typeof value === 'string' && isDateString(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'list':
      return Array.isArray(value);
    case 'any':
      return true;
    default:
      return true;
  }
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function matchesTemplate(template: NonNullable<PrimitiveTypeDefinition['fields'][string]['template']>, value: string): boolean {
  switch (template) {
    case 'slug':
      return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
    case 'semver':
      return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case 'url':
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    case 'iso-date':
      return isDateString(value);
    default:
      return true;
  }
}

function isDateString(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp);
}

function validateRefValue(
  workspacePath: string,
  rawRef: string,
  allowedTypes?: string[],
): { ok: true } | { ok: false; reason: string } {
  const normalized = normalizeRefPath(rawRef);
  if (normalized.startsWith('external/')) {
    return { ok: true };
  }

  const target = read(workspacePath, normalized);
  if (!target && allowedTypes && allowedTypes.length > 0) {
    const refDir = normalized.split('/')[0];
    const registry = loadRegistry(workspacePath);
    const allowedDirs = allowedTypes
      .map((typeName) => registry.types[typeName]?.directory)
      .filter((dirName): dirName is string => !!dirName);
    if (allowedDirs.includes(refDir)) {
      return { ok: true };
    }
  }

  if (!target) {
    return { ok: false, reason: `Reference target not found: ${normalized}` };
  }

  if (allowedTypes && allowedTypes.length > 0 && !allowedTypes.includes(target.type)) {
    return {
      ok: false,
      reason: `Reference ${normalized} has type "${target.type}" but allowed types are [${allowedTypes.join(', ')}]`,
    };
  }

  return { ok: true };
}
