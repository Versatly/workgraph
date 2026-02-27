/**
 * Workgraph store — CRUD for primitive instances.
 */

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { loadRegistry, getType } from './registry.js';
import * as ledger from './ledger.js';
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
  validateFields(typeDef, merged, 'create');

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
  });

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
  const newFields = { ...existing.fields, ...fieldUpdates, updated: now };
  const typeDef = getType(workspacePath, existing.type);
  if (!typeDef) throw new Error(`Unknown primitive type "${existing.type}" for ${relPath}`);
  validateFields(typeDef, newFields, 'update');
  const newBody = bodyUpdate ?? existing.body;
  const absPath = path.join(workspacePath, relPath);

  const content = matter.stringify(newBody, stripUndefined(newFields));
  fs.writeFileSync(absPath, content, 'utf-8');

  ledger.append(workspacePath, actor, 'update', relPath, existing.type, {
    changed: Object.keys(fieldUpdates),
  });

  return { path: relPath, type: existing.type, fields: newFields, body: newBody };
}

// ---------------------------------------------------------------------------
// Delete (soft — moves to .clawvault/archive/)
// ---------------------------------------------------------------------------

export function remove(workspacePath: string, relPath: string, actor: string): void {
  const absPath = path.join(workspacePath, relPath);
  if (!fs.existsSync(absPath)) throw new Error(`Not found: ${relPath}`);

  const archiveDir = path.join(workspacePath, '.clawvault', 'archive');
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

  const archivePath = path.join(archiveDir, path.basename(relPath));
  fs.renameSync(absPath, archivePath);

  const typeName = inferType(workspacePath, relPath);
  ledger.append(workspacePath, actor, 'delete', relPath, typeName);
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
    case 'date':
      return typeof value === 'string';
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
