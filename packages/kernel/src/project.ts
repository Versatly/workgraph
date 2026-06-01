/**
 * Project lifecycle helpers.
 *
 * Projects are durable coordination containers. Threads can reference a project
 * through the thread `project` field, and each project keeps a denormalized
 * `thread_refs` list for quick listing in MCP/CLI surfaces.
 */
import * as store from './store.js';
import type { PrimitiveInstance } from './types.js';

export interface CreateProjectOptions {
  description?: string;
  status?: string;
  priority?: string;
  owner?: string;
  client?: string;
  member_refs?: string[];
  tags?: string[];
}

export function createProject(
  workspacePath: string,
  title: string,
  actor: string,
  opts: CreateProjectOptions = {},
): PrimitiveInstance {
  const description = String(opts.description ?? '').trim();
  return store.create(workspacePath, 'project', {
    title,
    description,
    status: opts.status ?? 'active',
    priority: opts.priority ?? 'medium',
    owner: opts.owner,
    client: opts.client,
    member_refs: opts.member_refs ?? [],
    thread_refs: [],
    tags: opts.tags ?? [],
  }, renderProjectBody(description), actor);
}

export function listProjects(workspacePath: string, status?: string): PrimitiveInstance[] {
  const projects = store.list(workspacePath, 'project');
  if (!status) return projects;
  return projects.filter((entry) => String(entry.fields.status ?? '') === status);
}

export function threadsInProject(workspacePath: string, projectRef: string): PrimitiveInstance[] {
  const normalizedProject = normalizeProjectRef(projectRef);
  return store.list(workspacePath, 'thread').filter((entry) =>
    normalizeProjectRef(entry.fields.project) === normalizedProject
  );
}

export function addThreadToProject(
  workspacePath: string,
  projectRef: string,
  threadRef: string,
  actor: string,
): PrimitiveInstance {
  const normalizedProject = normalizeProjectRef(projectRef);
  const project = store.read(workspacePath, normalizedProject);
  if (!project) throw new Error(`Project not found: ${normalizedProject}`);
  const normalizedThread = normalizeThreadRef(threadRef);
  const refs = uniqueRefs([...coerceStringArray(project.fields.thread_refs), normalizedThread]);
  return store.update(workspacePath, normalizedProject, {
    thread_refs: refs,
  }, undefined, actor);
}

export function normalizeProjectRef(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const unwrapped = raw.startsWith('[[') && raw.endsWith(']]')
    ? raw.slice(2, -2)
    : raw;
  if (unwrapped.endsWith('.md')) return unwrapped;
  if (unwrapped.startsWith('projects/')) return `${unwrapped}.md`;
  return `projects/${unwrapped}.md`;
}

function normalizeThreadRef(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const unwrapped = raw.startsWith('[[') && raw.endsWith(']]')
    ? raw.slice(2, -2)
    : raw;
  if (unwrapped.endsWith('.md')) return unwrapped;
  if (unwrapped.startsWith('threads/')) return `${unwrapped}.md`;
  return `threads/${unwrapped}.md`;
}

function coerceStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)).filter(Boolean) : [];
}

function uniqueRefs(refs: string[]): string[] {
  return Array.from(new Set(refs.filter(Boolean)));
}

function renderProjectBody(description: string): string {
  return description ? `## Description\n\n${description}\n` : '## Description\n\n';
}
