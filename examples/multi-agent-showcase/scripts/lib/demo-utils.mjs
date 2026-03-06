#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

export function resolveRepoRoot(fromImportMetaUrl) {
  let current = path.resolve(path.dirname(fileURLToPath(fromImportMetaUrl)));
  for (let depth = 0; depth < 8; depth += 1) {
    const pkgPath = path.join(current, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg && pkg.name === '@versatly/workgraph') {
          return current;
        }
      } catch {
        // Keep traversing upward.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('Unable to resolve WorkGraph repository root from showcase script location.');
}

export function resolveWorkspace(args) {
  const parsed = parseArgs(args);
  if (parsed.workspace) {
    return {
      workspacePath: path.resolve(parsed.workspace),
      providedByUser: true,
      json: parsed.json,
      skipBuild: parsed.skipBuild,
    };
  }
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'workgraph-obj09-showcase-'));
  return {
    workspacePath,
    providedByUser: false,
    json: parsed.json,
    skipBuild: parsed.skipBuild,
  };
}

export async function runCliJson(repoRoot, args, options = {}) {
  const cliPath = path.join(repoRoot, 'bin', 'workgraph.js');
  const fullArgs = args.includes('--json') ? [...args] : [...args, '--json'];
  const env = {
    ...process.env,
    ...(options.env ?? {}),
  };
  const { stdout, stderr } = await execFileAsync('node', [cliPath, ...fullArgs], {
    cwd: repoRoot,
    env,
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = String(stdout ?? '').trim();
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`CLI output was not valid JSON (${fullArgs.join(' ')}): ${detail}\n${output}`);
  }
  if (!parsed || parsed.ok !== true) {
    const rendered = JSON.stringify(parsed, null, 2);
    const err = String(stderr ?? '').trim();
    throw new Error(`CLI command failed (${fullArgs.join(' ')}): ${rendered}${err ? `\n${err}` : ''}`);
  }
  return parsed;
}

export async function ensureBuild(repoRoot) {
  const distCli = path.join(repoRoot, 'dist', 'cli.js');
  const distIndex = path.join(repoRoot, 'dist', 'index.js');
  if (fs.existsSync(distCli) && fs.existsSync(distIndex)) {
    return;
  }
  await execFileAsync(resolvePnpmCommand(), ['run', 'build'], {
    cwd: repoRoot,
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
}

export async function loadSdk(repoRoot) {
  const sdkUrl = pathToFileURL(path.join(repoRoot, 'dist', 'index.js')).href;
  return import(sdkUrl);
}

export function logLine(message, jsonMode) {
  if (!jsonMode) {
    process.stderr.write(`${message}\n`);
  }
}

function parseArgs(args) {
  const parsed = {
    workspace: '',
    json: false,
    skipBuild: false,
  };
  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = String(args[idx] ?? '');
    if ((arg === '--workspace' || arg === '-w') && idx + 1 < args.length) {
      parsed.workspace = String(args[idx + 1]);
      idx += 1;
      continue;
    }
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
    if (arg === '--skip-build') {
      parsed.skipBuild = true;
    }
  }
  return parsed;
}

function resolvePnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}
