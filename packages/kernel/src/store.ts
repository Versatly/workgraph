/**
 * Workgraph store — CRUD for primitive instances.
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import fs from './storage-fs.js';
import matter from 'gray-matter';
import { loadRegistry, getType } from './registry.js';
import * as ledger from './ledger.js';
import * as graph from './graph.js';
import * as auth from './auth.js';
import * as policy from './policy.js';
import type { PrimitiveInstance, PrimitiveTypeDefinition } from './types.js';

const ETAG_FIELD = 'etag';
const TYPE_HINT_FIELD = '_wg_type';

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface PrimitiveCreateOptions {
  pathOverride?: string;
  skipAuthorization?: boolean;
  requiredCapabilities?: string[];
  action?: string;
}

export function create(
  workspacePath: string,
  typeName: string,
  fields: Record<string, unknown>,
  body: string,
  actor: string,
  options: PrimitiveCreateOptions = {},
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
  const mergedWithTypeHint = maybeAddTypeHint(workspacePath, typeDef, merged, typeName);
  const initialStatus = typeof mergedWithTypeHint.status === 'string'
    ? String(mergedWithTypeHint.status)
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
  if (!options.skipAuthorization) {
    auth.assertAuthorizedMutation(workspacePath, {
      actor,
      action: options.action ?? `store.${typeName}.create`,
      target: options.pathOverride,
      requiredCapabilities: options.requiredCapabilities ?? capabilitiesForStoreMutation(typeName, 'create'),
      metadata: {
        primitive_type: typeName,
        mutation: 'create',
      },
    });
  }
  validateFields(workspacePath, typeDef, mergedWithTypeHint, 'create');

  const relDir = typeDef.directory;
  const slug = slugify(String(mergedWithTypeHint.title ?? mergedWithTypeHint.name ?? typeName));
  const relPath = resolveCreatePath(relDir, slug, options.pathOverride);
  const absDir = path.dirname(path.join(workspacePath, relPath));
  const absPath = path.join(workspacePath, relPath);

  if (!fs.existsSync(absDir)) fs.mkdirSync(absDir, { recursive: true });
  if (fs.existsSync(absPath)) {
    throw new Error(`File already exists: ${relPath}. Use update instead.`);
  }

  const serialized = renderDocumentWithEtag(body, mergedWithTypeHint);
  fs.writeFileSync(absPath, serialized.content, 'utf-8');

  ledger.append(workspacePath, actor, 'create', relPath, typeName, {
    title: serialized.frontmatter.title ?? slug,
    ...(typeof serialized.frontmatter.status === 'string' ? { status: serialized.frontmatter.status } : {}),
  });
  graph.refreshWikiLinkGraphIndex(workspacePath);

  return { path: relPath, type: typeName, fields: serialized.frontmatter, body };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function read(workspacePath: string, relPath: string): PrimitiveInstance | null {
  const absPath = path.join(workspacePath, relPath);
  if (!fs.existsSync(absPath)) return null;

  const raw = fs.readFileSync(absPath, 'utf-8');
  const { data, content } = matter(raw);
  const fields = ensureEtagField(raw, data as Record<string, unknown>);

  const typeName = inferType(workspacePath, relPath, fields);
  return { path: relPath, type: typeName, fields, body: content.trim() };
}

export function list(workspacePath: string, typeName: string): PrimitiveInstance[] {
  const typeDef = getType(workspacePath, typeName);
  if (!typeDef) return [];

  const dir = path.join(workspacePath, typeDef.directory);
  if (!fs.existsSync(dir)) return [];

  const files = listMarkdownFilesRecursive(dir);
  const instances: PrimitiveInstance[] = [];

  for (const file of files) {
    const relPath = path.relative(workspacePath, file).replace(/\\/g, '/');
    const inst = read(workspacePath, relPath);
    if (inst) instances.push(inst);
  }

  return instances;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export interface PrimitiveUpdateOptions {
  expectedEtag?: string;
  concurrentConflictMode?: 'warn' | 'error';
  skipAuthorization?: boolean;
  requiredCapabilities?: string[];
  action?: string;
}

export function update(
  workspacePath: string,
  relPath: string,
  fieldUpdates: Record<string, unknown>,
  bodyUpdate: string | undefined,
  actor: string,
  options: PrimitiveUpdateOptions = {},
): PrimitiveInstance {
  const existing = read(workspacePath, relPath);
  if (!existing) throw new Error(`Not found: ${relPath}`);
  const absPath = path.join(workspacePath, relPath);
  const rawBeforeWrite = fs.readFileSync(absPath, 'utf-8');
  const computedCurrentEtag = computeEtagFromRawFileContent(rawBeforeWrite);
  const storedEtag = typeof existing.fields[ETAG_FIELD] === 'string'
    ? String(existing.fields[ETAG_FIELD])
    : undefined;
  const currentEtag = storedEtag ?? computedCurrentEtag;
  if (storedEtag && storedEtag !== computedCurrentEtag) {
    handleConcurrentConflict(
      `Stored etag mismatch for ${relPath}. Expected stored="${storedEtag}" but computed="${computedCurrentEtag}".`,
      'warn',
    );
  }
  if (options.expectedEtag && options.expectedEtag !== currentEtag) {
    handleConcurrentConflict(
      `Concurrent modification detected for ${relPath}. Expected etag="${options.expectedEtag}" but found "${currentEtag}".`,
      options.concurrentConflictMode ?? 'error',
    );
  }

  const now = new Date().toISOString();
  const sanitizedFieldUpdates = { ...fieldUpdates };
  delete sanitizedFieldUpdates[ETAG_FIELD];
  const newFields: Record<string, unknown> = { ...existing.fields, ...sanitizedFieldUpdates, updated: now };
  delete newFields[ETAG_FIELD];
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
  if (!options.skipAuthorization) {
    auth.assertAuthorizedMutation(workspacePath, {
      actor,
      action: options.action ?? `store.${existing.type}.update`,
      target: existing.path,
      requiredCapabilities: options.requiredCapabilities ?? capabilitiesForStoreMutation(existing.type, 'update'),
      metadata: {
        primitive_type: existing.type,
        mutation: 'update',
      },
    });
  }

  validateFields(workspacePath, typeDef, newFields, 'update');
  const newBody = bodyUpdate ?? existing.body;
  const serialized = renderDocumentWithEtag(newBody, newFields);
  fs.writeFileSync(absPath, serialized.content, 'utf-8');
  const changedFields = Object.keys(sanitizedFieldUpdates);

  ledger.append(workspacePath, actor, 'update', relPath, existing.type, {
    changed: changedFields,
    ...(options.expectedEtag ? { expected_etag: options.expectedEtag } : {}),
    ...(options.expectedEtag ? { previous_etag: currentEtag } : {}),
    new_etag: serialized.frontmatter[ETAG_FIELD],
    ...(previousStatus !== nextStatus && nextStatus
      ? {
          from_status: previousStatus ?? null,
          to_status: nextStatus,
        }
      : {}),
  });
  graph.refreshWikiLinkGraphIndex(workspacePath);

  return { path: relPath, type: existing.type, fields: serialized.frontmatter, body: newBody };
}

// ---------------------------------------------------------------------------
// Delete (soft — moves to .workgraph/archive/)
// ---------------------------------------------------------------------------

export interface PrimitiveRemoveOptions {
  skipAuthorization?: boolean;
  requiredCapabilities?: string[];
  action?: string;
}

export function remove(
  workspacePath: string,
  relPath: string,
  actor: string,
  options: PrimitiveRemoveOptions = {},
): void {
  const absPath = path.join(workspacePath, relPath);
  if (!fs.existsSync(absPath)) throw new Error(`Not found: ${relPath}`);
  const typeName = inferType(workspacePath, relPath, {});
  if (!options.skipAuthorization) {
    auth.assertAuthorizedMutation(workspacePath, {
      actor,
      action: options.action ?? `store.${typeName}.delete`,
      target: relPath,
      requiredCapabilities: options.requiredCapabilities ?? capabilitiesForStoreMutation(typeName, 'delete'),
      metadata: {
        primitive_type: typeName,
        mutation: 'delete',
      },
    });
  }

  const archiveDir = path.join(workspacePath, '.workgraph', 'archive');
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

  const archivePath = path.join(archiveDir, path.basename(relPath));
  fs.renameSync(absPath, archivePath);

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

function resolveCreatePath(directory: string, slug: string, pathOverride?: string): string {
  if (!pathOverride) {
    return `${directory}/${slug}.md`;
  }
  const normalized = pathOverride.replace(/\\/g, '/').replace(/^\.\//, '');
  const withExtension = normalized.endsWith('.md') ? normalized : `${normalized}.md`;
  if (!withExtension.startsWith(`${directory}/`)) {
    throw new Error(`Invalid create path override "${pathOverride}". Must stay under "${directory}/".`);
  }
  return withExtension;
}

function listMarkdownFilesRecursive(rootDir: string): string[] {
  const output: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.md')) {
        output.push(absPath);
      }
    }
  }
  return output;
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

function omitField(obj: Record<string, unknown>, fieldName: string): Record<string, unknown> {
  const clone = { ...obj };
  delete clone[fieldName];
  return clone;
}

function renderDocumentWithEtag(
  body: string,
  frontmatterFields: Record<string, unknown>,
): { content: string; frontmatter: Record<string, unknown> } {
  const withoutEtag = stripUndefined(omitField(frontmatterFields, ETAG_FIELD));
  const canonical = matter.stringify(body, withoutEtag);
  const etag = createHash('md5').update(canonical).digest('hex');
  const frontmatter = {
    ...withoutEtag,
    [ETAG_FIELD]: etag,
  };
  return {
    content: matter.stringify(body, frontmatter),
    frontmatter,
  };
}

function ensureEtagField(raw: string, fields: Record<string, unknown>): Record<string, unknown> {
  const existing = typeof fields[ETAG_FIELD] === 'string'
    ? String(fields[ETAG_FIELD]).trim()
    : '';
  if (existing) return fields;
  return {
    ...fields,
    [ETAG_FIELD]: computeEtagFromRawFileContent(raw),
  };
}

function computeEtagFromRawFileContent(raw: string): string {
  const parsed = matter(raw);
  const withoutEtag = stripUndefined(omitField(parsed.data as Record<string, unknown>, ETAG_FIELD));
  const canonical = matter.stringify(parsed.content, withoutEtag);
  return createHash('md5').update(canonical).digest('hex');
}

function maybeAddTypeHint(
  workspacePath: string,
  typeDef: PrimitiveTypeDefinition,
  fields: Record<string, unknown>,
  typeName: string,
): Record<string, unknown> {
  if (typeof fields[TYPE_HINT_FIELD] === 'string') return fields;
  const registry = loadRegistry(workspacePath);
  const sharedDirectory = Object.values(registry.types)
    .filter((entry) => entry.directory === typeDef.directory)
    .length > 1;
  if (!sharedDirectory) return fields;
  return {
    ...fields,
    [TYPE_HINT_FIELD]: typeName,
  };
}

function handleConcurrentConflict(message: string, mode: 'warn' | 'error'): void {
  if (mode === 'warn') {
    console.warn(`Warning: ${message}`);
    return;
  }
  throw new Error(message);
}

function inferType(workspacePath: string, relPath: string, fields: Record<string, unknown>): string {
  const registry = loadRegistry(workspacePath);
  const hintedType = typeof fields[TYPE_HINT_FIELD] === 'string'
    ? String(fields[TYPE_HINT_FIELD]).trim()
    : '';
  if (hintedType && registry.types[hintedType]) {
    return hintedType;
  }

  const normalizedPath = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const candidates = Object.values(registry.types).filter((typeDef) =>
    normalizedPath === typeDef.directory || normalizedPath.startsWith(`${typeDef.directory}/`)
  );
  if (candidates.length === 0) return 'unknown';
  if (candidates.length === 1) return candidates[0].name;

  return candidates
    .sort((a, b) => b.directory.length - a.directory.length || a.name.localeCompare(b.name))[0]
    .name;
}

function normalizeRefPath(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const unwrapped = raw.startsWith('[[') && raw.endsWith(']]')
    ? raw.slice(2, -2)
    : raw;
  return unwrapped.endsWith('.md') ? unwrapped : `${unwrapped}.md`;
}

function capabilitiesForStoreMutation(
  typeName: string,
  mutation: 'create' | 'update' | 'delete',
): string[] {
  switch (typeName) {
    case 'thread':
      return mutation === 'create'
        ? ['thread:create', 'thread:manage', 'policy:manage']
        : ['thread:update', 'thread:manage', 'thread:complete', 'policy:manage'];
    case 'run':
      return ['dispatch:run', 'policy:manage'];
    case 'policy':
      return ['policy:manage'];
    case 'policy-gate':
      return ['gate:manage', 'policy:manage'];
    case 'checkpoint':
      return ['checkpoint:create', 'dispatch:run', 'policy:manage'];
    case 'role':
    case 'trust-token':
    case 'agent-registration-request':
    case 'agent-registration-approval':
      return ['agent:register', 'policy:manage'];
    case 'presence':
      return ['agent:heartbeat', 'agent:register', 'policy:manage'];
    default:
      return [];
  }
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
