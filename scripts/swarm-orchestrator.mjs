#!/usr/bin/env node
/**
 * Swarm Orchestrator — Takes a goal, decomposes with an LLM,
 * deploys threads, spawns Docker workers, merges results.
 *
 * Usage:
 *   node swarm-orchestrator.mjs --goal "Write a book about OS kernels" \
 *     --workspace ~/my-vault --max-workers 10 --model claude
 *
 * Flow:
 *   1. Goal → LLM planner → SwarmPlan JSON
 *   2. SwarmPlan → deployPlan() → threads in workspace
 *   3. Spawn N Docker containers, each running worker.mjs
 *   4. Workers claim threads, execute with LLM, write results back
 *   5. Orchestrator monitors progress, synthesizes when done
 */

import { execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    goal: { type: 'string' },
    description: { type: 'string', default: '' },
    workspace: { type: 'string', default: process.cwd() },
    'max-workers': { type: 'string', default: '10' },
    'max-tasks': { type: 'string', default: '200' },
    model: { type: 'string', default: 'claude' },
    output: { type: 'string', default: 'output.md' },
    'dry-run': { type: 'boolean', default: false },
    actor: { type: 'string', default: 'swarm-orchestrator' },
  },
});

if (!args.goal) {
  console.error('Usage: swarm-orchestrator.mjs --goal "Your goal" [options]');
  process.exit(1);
}

const WORKSPACE = path.resolve(args.workspace);
const MAX_WORKERS = parseInt(args['max-workers'], 10);
const MAX_TASKS = parseInt(args['max-tasks'], 10);
const WG = `node ${path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'workgraph.js')}`;

console.log(`\n🐝 SWARM ORCHESTRATOR`);
console.log(`Goal: ${args.goal}`);
console.log(`Workspace: ${WORKSPACE}`);
console.log(`Max workers: ${MAX_WORKERS}`);
console.log(`Max tasks: ${MAX_TASKS}`);
console.log(`Model: ${args.model}\n`);

// ============================================================================
// Step 1: Decompose goal into tasks using LLM
// ============================================================================

console.log('📋 Step 1: Decomposing goal into tasks...');

const plannerPrompt = `You are a task decomposition expert. Given a goal, break it into a structured plan with many specific, actionable tasks.

GOAL: ${args.goal}
${args.description ? `DESCRIPTION: ${args.description}` : ''}

Output a JSON object with this exact structure:
{
  "goal": {
    "title": "Short title",
    "description": "Full description",
    "maxTasks": ${MAX_TASKS}
  },
  "tasks": [
    {
      "title": "Specific task name",
      "description": "Detailed instructions for an agent to complete this task independently. Include what to research, what to write, expected length, format, etc.",
      "priority": "high|medium|low",
      "dependsOn": ["Other task title if dependent"],
      "tags": ["category"]
    }
  ],
  "phases": [
    {
      "name": "Phase name",
      "description": "What this phase accomplishes",
      "taskIndices": [0, 1, 2],
      "parallel": true
    }
  ]
}

Rules:
- Create ${MAX_TASKS} or fewer tasks
- Each task must be completable independently by a single agent in 5-15 minutes
- Tasks that produce text should specify expected word count (500-2000 words each)
- Use dependencies sparingly — maximize parallelism
- Group into 3-5 phases
- Be EXTREMELY specific in task descriptions — the agent has no other context

Output ONLY valid JSON, no markdown fences.`;

let plan;
try {
  // Use claude CLI for decomposition
  const planJson = execSync(
    `claude -p "${plannerPrompt.replace(/"/g, '\\"')}" --output-format json 2>/dev/null`,
    { maxBuffer: 10 * 1024 * 1024, timeout: 120000 }
  ).toString().trim();

  // Extract JSON from response
  const jsonMatch = planJson.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in LLM response');
  plan = JSON.parse(jsonMatch[0]);
  console.log(`   Created ${plan.tasks.length} tasks in ${plan.phases?.length ?? 0} phases`);
} catch (err) {
  console.error(`   Failed to decompose: ${err.message}`);
  process.exit(1);
}

// Save plan
const planPath = path.join(WORKSPACE, '.workgraph', 'swarm-plan.json');
fs.mkdirSync(path.dirname(planPath), { recursive: true });
fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
console.log(`   Plan saved to ${planPath}`);

if (args['dry-run']) {
  console.log('\n🔍 DRY RUN — plan generated but not deployed');
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

// ============================================================================
// Step 2: Deploy plan into workspace
// ============================================================================

console.log('\n📦 Step 2: Deploying plan as threads...');

try {
  const result = execSync(
    `${WG} swarm deploy ${planPath} --workspace ${WORKSPACE} --actor ${args.actor} --json`,
    { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }
  ).toString();
  const deployment = JSON.parse(result);
  console.log(`   Space: ${deployment.spaceSlug}`);
  console.log(`   Threads: ${deployment.threadPaths.length}`);
  var spaceSlug = deployment.spaceSlug;
} catch (err) {
  console.error(`   Deploy failed: ${err.message}`);
  process.exit(1);
}

// ============================================================================
// Step 3: Spawn workers
// ============================================================================

console.log(`\n🤖 Step 3: Spawning ${MAX_WORKERS} workers...`);

const workerScript = path.join(path.dirname(new URL(import.meta.url).pathname), 'swarm-worker.mjs');
const workers = [];

for (let i = 0; i < MAX_WORKERS; i++) {
  const workerName = `worker-${i + 1}`;
  console.log(`   Starting ${workerName}...`);

  const proc = spawn('node', [
    workerScript,
    '--workspace', WORKSPACE,
    '--space', spaceSlug,
    '--actor', workerName,
    '--model', args.model,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  workers.push({ name: workerName, proc, completed: 0, errors: 0 });

  proc.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (line.includes('COMPLETED:')) workers[i].completed++;
      if (line.includes('ERROR:')) workers[i].errors++;
      console.log(`   [${workerName}] ${line}`);
    }
  });

  proc.stderr.on('data', (data) => {
    console.error(`   [${workerName}] ERR: ${data.toString().trim()}`);
  });
}

// ============================================================================
// Step 4: Monitor progress
// ============================================================================

console.log('\n📊 Step 4: Monitoring progress...');

const startTime = Date.now();
const checkInterval = setInterval(() => {
  try {
    const statusJson = execSync(
      `${WG} swarm status ${spaceSlug} --workspace ${WORKSPACE} --json`,
      { timeout: 10000 }
    ).toString();
    const status = JSON.parse(statusJson);

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const bar = progressBar(status.percentComplete);
    console.log(`   [${elapsed}s] ${bar} ${status.done}/${status.total} (${status.percentComplete}%) | Claimed: ${status.claimed} | Open: ${status.open}`);

    if (status.done + status.blocked >= status.total) {
      clearInterval(checkInterval);
      finalize(spaceSlug);
    }
  } catch {
    // status check failed, retry next interval
  }
}, 10000);

// Also wait for all workers to exit
Promise.all(workers.map(w => new Promise(resolve => w.proc.on('exit', resolve))))
  .then(() => {
    clearInterval(checkInterval);
    finalize(spaceSlug);
  });

// ============================================================================
// Step 5: Synthesize results
// ============================================================================

let finalized = false;
function finalize(slug) {
  if (finalized) return;
  finalized = true;

  console.log('\n📝 Step 5: Synthesizing results...');

  try {
    const outputPath = path.resolve(args.output);
    execSync(
      `${WG} swarm synthesize ${slug} --workspace ${WORKSPACE} --output ${outputPath}`,
      { timeout: 30000 }
    );
    console.log(`   Output written to: ${outputPath}`);

    // Print summary
    const totalCompleted = workers.reduce((s, w) => s + w.completed, 0);
    const totalErrors = workers.reduce((s, w) => s + w.errors, 0);
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    console.log(`\n✅ SWARM COMPLETE`);
    console.log(`   Tasks completed: ${totalCompleted}`);
    console.log(`   Errors: ${totalErrors}`);
    console.log(`   Workers: ${MAX_WORKERS}`);
    console.log(`   Time: ${elapsed}s`);
    console.log(`   Output: ${outputPath}`);
  } catch (err) {
    console.error(`   Synthesis failed: ${err.message}`);
  }

  process.exit(0);
}

function progressBar(pct) {
  const filled = Math.round(pct / 5);
  return '█'.repeat(filled) + '░'.repeat(20 - filled);
}
