#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(scriptDir, 'scripts', 'run-showcase.mjs');

execFileSync('node', [scriptPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
