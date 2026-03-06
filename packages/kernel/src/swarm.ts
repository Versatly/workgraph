/**
 * WorkGraph Swarm — Decompose goals into hundreds of tasks,
 * spawn agent containers to claim and complete them, merge results.
 *
 * Architecture:
 *   1. Planner: Takes a goal → decomposes into N threads with dependencies
 *   2. Orchestrator: Spawns containers, each runs a worker that claims threads
 *   3. Worker: Claims a thread, does work, writes result, marks done
 *   4. Synthesizer: Watches for completion, merges results
 */

import fs from './storage-fs.js';
import * as path from 'node:path';
import * as thread from './thread.js';
import * as store from './store.js';
import * as ledger from './ledger.js';
import type { PrimitiveInstance } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SwarmGoal {
  title: string;
  description: string;
  outputFormat?: 'markdown' | 'json' | 'code';
  maxTasks?: number;
  maxConcurrent?: number;
  tags?: string[];
}

export interface SwarmTask {
  title: string;
  description: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  dependsOn?: string[];
  estimatedMinutes?: number;
  outputType?: string;
  tags?: string[];
}

export interface SwarmPlan {
  goal: SwarmGoal;
  tasks: SwarmTask[];
  phases: SwarmPhase[];
  createdAt: string;
  estimatedTotalMinutes: number;
}

export interface SwarmPhase {
  name: string;
  description: string;
  taskIndices: number[];
  parallel: boolean;
}

export interface SwarmDeployment {
  planPath: string;
  workspacePath: string;
  threadPaths: string[];
  spaceSlug: string;
  createdAt: string;
  status: 'deployed' | 'running' | 'completing' | 'done' | 'failed';
}

export interface SwarmStatus {
  deployment: SwarmDeployment;
  total: number;
  claimed: number;
  done: number;
  blocked: number;
  open: number;
  readyToClaim: number;
  percentComplete: number;
  threads: Array<{
    path: string;
    title: string;
    status: string;
    owner?: string;
    priority: string;
  }>;
}

// ---------------------------------------------------------------------------
// Plan Generation (produces structured plan from goal)
// ---------------------------------------------------------------------------

/**
 * Generate a swarm plan from a goal description.
 * This creates the plan structure — call deployPlan() to create actual threads.
 *
 * In production, pipe goal through an LLM for decomposition.
 * This function provides the structured output format the LLM should produce.
 */
export function createPlanTemplate(goal: SwarmGoal): SwarmPlan {
  return {
    goal,
    tasks: [],
    phases: [],
    createdAt: new Date().toISOString(),
    estimatedTotalMinutes: 0,
  };
}

/**
 * Validate a swarm plan for internal consistency.
 */
export function validatePlan(plan: SwarmPlan): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!plan.goal.title) errors.push('Goal title is required');
  if (plan.tasks.length === 0) errors.push('Plan has no tasks');
  if (plan.tasks.length > (plan.goal.maxTasks ?? 1000)) {
    errors.push(`Plan has ${plan.tasks.length} tasks, exceeds max ${plan.goal.maxTasks ?? 1000}`);
  }

  // Check dependency references
  const taskTitles = new Set(plan.tasks.map(t => t.title));
  for (const task of plan.tasks) {
    for (const dep of task.dependsOn ?? []) {
      if (!taskTitles.has(dep)) {
        errors.push(`Task "${task.title}" depends on unknown task "${dep}"`);
      }
    }
  }

  // Check for circular dependencies
  const visited = new Set<string>();
  const stack = new Set<string>();
  const depMap = new Map<string, string[]>();
  for (const task of plan.tasks) {
    depMap.set(task.title, task.dependsOn ?? []);
  }

  function hasCycle(node: string): boolean {
    if (stack.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    stack.add(node);
    for (const dep of depMap.get(node) ?? []) {
      if (hasCycle(dep)) return true;
    }
    stack.delete(node);
    return false;
  }

  for (const task of plan.tasks) {
    visited.clear();
    stack.clear();
    if (hasCycle(task.title)) {
      errors.push(`Circular dependency detected involving "${task.title}"`);
      break;
    }
  }

  // Check phases reference valid task indices
  for (const phase of plan.phases) {
    for (const idx of phase.taskIndices) {
      if (idx < 0 || idx >= plan.tasks.length) {
        errors.push(`Phase "${phase.name}" references invalid task index ${idx}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Plan Deployment (creates threads in a workspace)
// ---------------------------------------------------------------------------

/**
 * Deploy a swarm plan into a WorkGraph workspace.
 * Creates a space for the swarm and threads for each task.
 * Dependencies are encoded as wiki-links in thread bodies.
 */
export function deployPlan(
  workspacePath: string,
  plan: SwarmPlan,
  actor: string,
): SwarmDeployment {
  const validation = validatePlan(plan);
  if (!validation.valid) {
    throw new Error(`Invalid plan: ${validation.errors.join('; ')}`);
  }

  // Create swarm space
  const spaceSlug = slugify(`swarm-${plan.goal.title}`);
  const spacePath = path.join('spaces', `${spaceSlug}.md`);
  const spaceFullPath = path.join(workspacePath, spacePath);
  if (!fs.existsSync(spaceFullPath)) {
    const spaceDir = path.join(workspacePath, 'spaces');
    fs.mkdirSync(spaceDir, { recursive: true });
    const spaceFrontmatter = [
      '---',
      `title: "Swarm: ${plan.goal.title}"`,
      `status: active`,
      `created: '${new Date().toISOString()}'`,
      `updated: '${new Date().toISOString()}'`,
      '---',
      '',
      `# Swarm Space: ${plan.goal.title}`,
      '',
      plan.goal.description,
      '',
      `Total tasks: ${plan.tasks.length}`,
    ].join('\n');
    fs.writeFileSync(spaceFullPath, spaceFrontmatter);
  }

  // Create threads for each task
  const threadPaths: string[] = [];
  const slugMap = new Map<string, string>(); // task title -> thread slug

  for (const task of plan.tasks) {
    const taskSlug = slugify(task.title);
    slugMap.set(task.title, taskSlug);
  }

  for (const task of plan.tasks) {
    const taskSlug = slugMap.get(task.title)!;
    // Build body with dependency links
    let body = `# ${task.title}\n\n${task.description}\n`;

    if (task.dependsOn && task.dependsOn.length > 0) {
      body += `\n## Dependencies\n`;
      for (const dep of task.dependsOn) {
        const depSlug = slugMap.get(dep);
        if (depSlug) {
          body += `- [[${depSlug}]]\n`;
        }
      }
    }

    body += `\n## Output\n\n_Agent writes result here._\n`;

    if (task.tags && task.tags.length > 0) {
      body += `\nTags: ${task.tags.join(', ')}\n`;
    }

    const created = thread.createThread(workspacePath, task.title, body, actor, {
      priority: task.priority,
      space: `spaces/${spaceSlug}`,
    });

    threadPaths.push(created.path);
  }

  // Save deployment manifest  
  const deployment: SwarmDeployment = {
    planPath: path.join('.workgraph', `swarm-${spaceSlug}.json`),
    workspacePath,
    threadPaths,
    spaceSlug,
    createdAt: new Date().toISOString(),
    status: 'deployed',
  };

  const manifestPath = path.join(workspacePath, deployment.planPath);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({ plan, deployment }, null, 2));

  ledger.append(workspacePath, actor, 'create', deployment.planPath, 'swarm');

  return deployment;
}

// ---------------------------------------------------------------------------
// Swarm Status
// ---------------------------------------------------------------------------

/**
 * Get the current status of a swarm deployment.
 */
export function getSwarmStatus(
  workspacePath: string,
  spaceSlug: string,
): SwarmStatus {
  // Load deployment manifest
  const manifestPath = path.join(workspacePath, '.workgraph', `swarm-${spaceSlug}.json`);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No swarm deployment found for space "${spaceSlug}"`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const deployment: SwarmDeployment = manifest.deployment;

  // Check thread statuses
  const threads: SwarmStatus['threads'] = [];
  let claimed = 0;
  let done = 0;
  let blocked = 0;
  let open = 0;

  for (const threadPath of deployment.threadPaths) {
    const t = store.read(workspacePath, threadPath);
    if (!t) continue;
    const status = String(t.fields.status ?? 'open');
    const threadInfo = {
      path: threadPath,
      title: String(t.fields.title ?? ''),
      status,
      owner: t.fields.owner ? String(t.fields.owner) : undefined,
      priority: String(t.fields.priority ?? 'medium'),
    };
    threads.push(threadInfo);

    if (status === 'done') done++;
    else if (status === 'active') claimed++;
    else if (status === 'blocked') blocked++;
    else open++;
  }

  const total = deployment.threadPaths.length;
  const readyToClaim = open; // simplified — could check dependencies
  const percentComplete = total > 0 ? Math.round((done / total) * 100) : 0;

  // Update deployment status based on progress
  if (done === total) deployment.status = 'done';
  else if (claimed > 0 || done > 0) deployment.status = 'running';

  return {
    deployment,
    total,
    claimed,
    done,
    blocked,
    open,
    readyToClaim,
    percentComplete,
    threads,
  };
}

// ---------------------------------------------------------------------------
// Worker Protocol
// ---------------------------------------------------------------------------

/**
 * Worker claims the next available task in a swarm.
 * Returns the thread to work on, or null if nothing available.
 */
export function workerClaim(
  workspacePath: string,
  spaceSlug: string,
  agent: string,
): PrimitiveInstance | null {
  // Find ready threads in this space
  const ready = thread.listReadyThreadsInSpace(workspacePath, `spaces/${spaceSlug}`);
  if (ready.length === 0) return null;

  // Sort by priority
  const priorityOrder: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  ready.sort((a, b) => {
    const aPri = priorityOrder[String(a.fields.priority)] ?? 2;
    const bPri = priorityOrder[String(b.fields.priority)] ?? 2;
    return aPri - bPri;
  });

  // Claim the highest priority ready thread
  const target = ready[0];
  return thread.claim(workspacePath, target.path, agent);
}

/**
 * Worker completes a task, writing result to the thread body.
 */
export function workerComplete(
  workspacePath: string,
  threadPath: string,
  agent: string,
  result: string,
): PrimitiveInstance {
  // Read current thread
  const t = store.read(workspacePath, threadPath);
  if (!t) throw new Error(`Thread not found: ${threadPath}`);

  // Append result to body
  const currentBody = t.body ?? '';
  const updatedBody = currentBody.replace(
    '_Agent writes result here._',
    result,
  );

  return thread.done(workspacePath, threadPath, agent, updatedBody, {
    evidence: [{ type: 'thread-ref', value: threadPath }],
  });
}

/**
 * Worker loop: claim → work → complete → repeat until no tasks left.
 * The workFn receives the thread and returns the result string.
 */
export async function workerLoop(
  workspacePath: string,
  spaceSlug: string,
  agent: string,
  workFn: (thread: PrimitiveInstance) => Promise<string>,
  options?: { maxTasks?: number; delayMs?: number },
): Promise<{ completed: number; errors: number }> {
  let completed = 0;
  let errors = 0;
  // Safety cap: default to the deployment task count so a malformed scheduler
  // cannot spin forever in long-lived worker loops.
  const inferredTaskCap = inferSwarmTaskCap(workspacePath, spaceSlug);
  const maxTasks = options?.maxTasks ?? inferredTaskCap ?? Infinity;
  const delayMs = options?.delayMs ?? 1000;

  while (completed + errors < maxTasks) {
    let claimed: PrimitiveInstance | null = null;
    try {
      claimed = workerClaim(workspacePath, spaceSlug, agent);
    } catch {
      // Claim contention can happen under parallel workers; treat as retryable.
      errors++;
      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      continue;
    }
    if (!claimed) break; // No more work

    try {
      const result = await workFn(claimed);
      workerComplete(workspacePath, claimed.path, agent, result);
      completed++;
    } catch (err) {
      errors++;
      // Log error but continue
      const errorMsg = err instanceof Error ? err.message : String(err);
      try {
        store.update(workspacePath, claimed.path, {
          status: 'blocked',
        }, `Error: ${errorMsg}`, agent);
      } catch {
        // Best effort
      }
    }

    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return { completed, errors };
}

function inferSwarmTaskCap(workspacePath: string, spaceSlug: string): number | null {
  try {
    return getSwarmStatus(workspacePath, spaceSlug).total;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Synthesizer
// ---------------------------------------------------------------------------

/**
 * Collect all completed task results from a swarm into a single document.
 */
export function synthesize(
  workspacePath: string,
  spaceSlug: string,
): { markdown: string; completedCount: number; totalCount: number } {
  const status = getSwarmStatus(workspacePath, spaceSlug);
  const sections: string[] = [];

  // Load the manifest for phase ordering
  const manifestPath = path.join(workspacePath, '.workgraph', `swarm-${spaceSlug}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const plan: SwarmPlan = manifest.plan;

  sections.push(`# ${plan.goal.title}\n`);
  sections.push(`${plan.goal.description}\n`);
  sections.push(`---\n`);

  // Collect results in thread order
  for (const threadInfo of status.threads) {
    const t = store.read(workspacePath, threadInfo.path);
    if (!t) continue;
    if (threadInfo.status !== 'done') {
      sections.push(`## [PENDING] ${threadInfo.title}\n\n_Not yet completed._\n`);
      continue;
    }
    // Use the full body as the result (agent replaces the placeholder)
    const body = t.body ?? '';
    const result = body.replace(/^#\s+.*\n/, '').trim(); // strip the title heading

    if (result && result !== '_Agent writes result here._') {
      sections.push(`## ${threadInfo.title}\n\n${result}\n`);
    } else {
      sections.push(`## ${threadInfo.title}\n\n_Completed but no output found._\n`);
    }
  }

  sections.push(`\n---\n`);
  sections.push(`*Generated from swarm "${plan.goal.title}" — ${status.done}/${status.total} tasks completed.*\n`);

  return {
    markdown: sections.join('\n'),
    completedCount: status.done,
    totalCount: status.total,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 80);
}
