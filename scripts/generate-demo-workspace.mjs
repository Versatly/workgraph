#!/usr/bin/env node

/**
 * Generates a large Obsidian-ready workgraph demo vault.
 *
 * Usage:
 *   node scripts/generate-demo-workspace.mjs /tmp/workgraph-obsidian-demo
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const targetArg = process.argv[2] ?? '/tmp/workgraph-obsidian-demo';
const targetPath = path.resolve(targetArg);
const cliPath = path.resolve('bin/workgraph.js');

function run(args) {
  const result = spawnSync('node', [cliPath, ...args], {
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: workgraph ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function writeObsidianConfig(vaultPath) {
  const obsidianPath = path.join(vaultPath, '.obsidian');
  fs.mkdirSync(obsidianPath, { recursive: true });
  const graph = {
    'collapse-filter': false,
    showTags: true,
    showAttachments: true,
    showOrphans: true,
    colorGroups: [
      { query: 'path:context-nodes', color: { a: 1, rgb: 16733525 } },
      { query: 'path:workflow-cells', color: { a: 1, rgb: 65535 } },
      { query: 'path:threads', color: { a: 1, rgb: 5635925 } },
      { query: 'path:skills OR path:ops', color: { a: 1, rgb: 16766720 } },
      { query: 'path:spaces', color: { a: 1, rgb: 10066329 } },
    ],
  };
  fs.writeFileSync(path.join(obsidianPath, 'graph.json'), JSON.stringify(graph, null, 2) + '\n', 'utf-8');
}

if (fs.existsSync(targetPath)) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

run(['init', targetPath, '--name', 'WorkGraph Obsidian Demo', '--json']);
run(['onboard', '-w', targetPath, '--actor', 'agent-architect', '--spaces', 'platform,delivery,research', '--json']);
run([
  'primitive', 'define', 'context-node',
  '-w', targetPath,
  '--description', 'Malleable context primitive',
  '--fields', 'cluster:string',
  '--fields', 'link_primary:ref',
  '--fields', 'energy:number',
  '--actor', 'agent-architect',
  '--json',
]);
run([
  'primitive', 'define', 'workflow-cell',
  '-w', targetPath,
  '--description', 'Composable workflow primitive',
  '--fields', 'lane:string',
  '--fields', 'upstream:ref',
  '--fields', 'state:string',
  '--actor', 'agent-architect',
  '--json',
]);

for (let i = 1; i <= 120; i += 1) {
  const args = [
    'primitive', 'create', 'context-node', `Context Node ${i}`,
    '-w', targetPath,
    '--actor', 'agent-architect',
    '--set', `cluster=cluster-${((i - 1) % 10) + 1}`,
    '--set', `energy=${(i * 7) % 100}`,
    '--body', `# Context Node ${i}\n\nLinks: [[threads/review-workspace-policy-gates.md]] [[skills/workgraph-manual.md]]${i > 1 ? ` [[context-nodes/context-node-${i - 1}.md]]` : ''}`,
    '--json',
  ];
  if (i > 1) {
    args.splice(args.indexOf('--body'), 0, '--set', `link_primary=context-nodes/context-node-${i - 1}.md`);
  }
  run(args);
}

for (let i = 1; i <= 60; i += 1) {
  const args = [
    'primitive', 'create', 'workflow-cell', `Workflow Cell ${i}`,
    '-w', targetPath,
    '--actor', 'agent-architect',
    '--set', `lane=lane-${((i - 1) % 6) + 1}`,
    '--set', 'state=ready',
    '--body', `# Workflow Cell ${i}\n\nContext link [[context-nodes/context-node-${((i - 1) % 120) + 1}.md]]${i > 1 ? ` [[workflow-cells/workflow-cell-${i - 1}.md]]` : ''}`,
    '--json',
  ];
  if (i > 1) {
    args.splice(args.indexOf('--body'), 0, '--set', `upstream=workflow-cells/workflow-cell-${i - 1}.md`);
  }
  run(args);
}

for (let i = 1; i <= 70; i += 1) {
  run([
    'thread', 'create', `Delivery Thread ${i}`,
    '-w', targetPath,
    '--goal', `Implement delivery slice ${i} with context [[context-nodes/context-node-${((i - 1) % 120) + 1}.md]]`,
    '--priority', 'high',
    '--actor', `agent-delivery-${((i - 1) % 6) + 1}`,
    '--space', 'spaces/delivery.md',
    '--context', `context-nodes/context-node-${((i - 1) % 120) + 1}.md`,
    '--tags', `delivery,iteration-${i}`,
    '--json',
  ]);
}

for (let i = 1; i <= 40; i += 1) {
  run([
    'thread', 'claim', `threads/delivery-thread-${i}.md`,
    '-w', targetPath,
    '--actor', `agent-delivery-${((i - 1) % 6) + 1}`,
    '--json',
  ]);
}

for (let i = 1; i <= 20; i += 1) {
  run([
    'thread', 'done', `threads/delivery-thread-${i}.md`,
    '-w', targetPath,
    '--actor', `agent-delivery-${((i - 1) % 6) + 1}`,
    '--output', `Completed delivery slice ${i} with linked context [[context-nodes/context-node-${i}.md]]`,
    '--json',
  ]);
}

for (let i = 21; i <= 40; i += 1) {
  run([
    'thread', 'block', `threads/delivery-thread-${i}.md`,
    '-w', targetPath,
    '--actor', `agent-delivery-${((i - 1) % 6) + 1}`,
    '--blocked-by', `threads/delivery-thread-${i - 20}.md`,
    '--reason', 'Waiting for downstream validation',
    '--json',
  ]);
}

run([
  'skill', 'write', 'workgraph-manual',
  '-w', targetPath,
  '--actor', 'agent-architect',
  '--status', 'active',
  '--skill-version', '2.4.0',
  '--tags', 'ops,graph',
  '--body', '# WorkGraph Manual\n\nOperational links:\n- [[ops/Workgraph Board.md]]\n- [[ops/Command Center.md]]\n- [[context-nodes/context-node-1.md]]\n- [[workflow-cells/workflow-cell-1.md]]',
  '--json',
]);

run(['board', 'generate', '-w', targetPath, '--output', 'ops/Workgraph Board.md', '--include-cancelled', '--json']);
run(['command-center', '-w', targetPath, '--output', 'ops/Command Center.md', '--actor', 'agent-architect', '--json']);
run(['graph', 'index', '-w', targetPath, '--json']);
run(['graph', 'hygiene', '-w', targetPath, '--json']);

writeObsidianConfig(targetPath);
console.log(targetPath);
