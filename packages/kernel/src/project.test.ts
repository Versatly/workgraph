import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, saveRegistry } from './registry.js';
import * as project from './project.js';
import * as store from './store.js';
import * as thread from './thread.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-project-'));
  saveRegistry(workspacePath, loadRegistry(workspacePath));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('project thread grouping', () => {
  it('creates projects and attaches created threads to the project thread_refs', () => {
    const createdProject = project.createProject(workspacePath, 'Versatly Ops', 'agent-alpha', {
      description: 'Physical ops project',
      priority: 'high',
      owner: 'agent-alpha',
    });

    const createdThread = thread.createThread(workspacePath, 'Plan factory OS', 'Define project work', 'agent-alpha', {
      project: createdProject.path,
      priority: 'high',
    });

    const reloadedProject = store.read(workspacePath, createdProject.path);
    expect(createdProject.path).toBe('projects/versatly-ops.md');
    expect(createdThread.fields.project).toBe(createdProject.path);
    expect(createdThread.fields.context_refs).toContain(createdProject.path);
    expect(reloadedProject?.fields.thread_refs).toEqual([createdThread.path]);
  });

  it('lists threads under a project by project ref', () => {
    const firstProject = project.createProject(workspacePath, 'Project A', 'agent-alpha');
    const secondProject = project.createProject(workspacePath, 'Project B', 'agent-alpha');
    const projectThread = thread.createThread(workspacePath, 'A thread', 'Work A', 'agent-alpha', {
      project: firstProject.path,
    });
    thread.createThread(workspacePath, 'B thread', 'Work B', 'agent-alpha', {
      project: secondProject.path,
    });

    expect(thread.listThreadsInProject(workspacePath, 'project-a').map((entry) => entry.path)).toEqual([
      projectThread.path,
    ]);
  });
});
