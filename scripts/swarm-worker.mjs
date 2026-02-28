#!/usr/bin/env node
/**
 * Swarm Worker — Claims and completes tasks from a swarm space.
 * Designed to run inside a Docker container or as a standalone process.
 *
 * Usage:
 *   node swarm-worker.mjs --workspace /vault --space swarm-slug --actor worker-1
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    workspace: { type: 'string', default: process.cwd() },
    space: { type: 'string' },
    actor: { type: 'string', default: `worker-${process.pid}` },
    model: { type: 'string', default: 'claude' },
    'max-tasks': { type: 'string', default: '50' },
    timeout: { type: 'string', default: '600' },
  },
});

if (!args.space) {
  console.error('--space required');
  process.exit(1);
}

const WORKSPACE = path.resolve(args.workspace);
const WG = `node ${path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'workgraph.js')}`;
const MAX_TASKS = parseInt(args['max-tasks'], 10);
const TIMEOUT_MS = parseInt(args.timeout, 10) * 1000;

let completed = 0;
let errors = 0;

while (completed + errors < MAX_TASKS) {
  // Claim next task
  let claimed;
  try {
    const claimJson = execSync(
      `${WG} swarm claim ${args.space} --workspace ${WORKSPACE} --actor ${args.actor} --json`,
      { timeout: 10000 }
    ).toString();
    claimed = JSON.parse(claimJson);
    if (!claimed.claimed) {
      console.log('NO_MORE_TASKS');
      break;
    }
  } catch (err) {
    console.log('NO_MORE_TASKS');
    break;
  }

  console.log(`CLAIMED: ${claimed.path} — ${claimed.title}`);

  // Read the thread to get the task description
  let taskBody;
  try {
    const threadFile = path.join(WORKSPACE, claimed.path);
    taskBody = fs.readFileSync(threadFile, 'utf-8');
  } catch {
    console.log(`ERROR: Could not read ${claimed.path}`);
    errors++;
    continue;
  }

  // Extract task description (everything between frontmatter and ## Output)
  const bodyMatch = taskBody.match(/---\n[\s\S]*?---\n([\s\S]*?)(?=## Output|$)/);
  const taskDescription = bodyMatch ? bodyMatch[1].trim() : taskBody;

  // Execute task with LLM
  const taskPrompt = `You are a focused worker agent. Complete this task thoroughly and return ONLY the result content (no meta-commentary).

TASK: ${claimed.title}

INSTRUCTIONS:
${taskDescription}

Write your complete result now. Be thorough, detailed, and high-quality.`;

  let result;
  try {
    result = execSync(
      `claude -p "${taskPrompt.replace(/"/g, '\\"').replace(/\n/g, '\\n')}" 2>/dev/null`,
      { maxBuffer: 10 * 1024 * 1024, timeout: TIMEOUT_MS }
    ).toString().trim();
  } catch (err) {
    console.log(`ERROR: LLM failed for ${claimed.path}: ${err.message}`);
    errors++;
    continue;
  }

  // Write result back
  try {
    // Save result to temp file then use CLI
    const tmpFile = path.join(WORKSPACE, '.workgraph', `tmp-${args.actor}-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, result);
    execSync(
      `${WG} swarm complete ${claimed.path} --workspace ${WORKSPACE} --actor ${args.actor} --result @${tmpFile} --json`,
      { timeout: 10000 }
    );
    fs.unlinkSync(tmpFile);
    completed++;
    console.log(`COMPLETED: ${claimed.path} (${result.length} chars)`);
  } catch (err) {
    console.log(`ERROR: Could not complete ${claimed.path}: ${err.message}`);
    errors++;
  }
}

console.log(`DONE: completed=${completed} errors=${errors}`);
process.exit(0);
