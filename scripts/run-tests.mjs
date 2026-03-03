import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const TEST_EXIT_GRACE_MS = parsePositiveInt(
  process.env.WORKGRAPH_TEST_EXIT_GRACE_MS,
  15_000,
);
const TEST_IDLE_TIMEOUT_MS = parsePositiveInt(
  process.env.WORKGRAPH_TEST_IDLE_TIMEOUT_MS,
  90_000,
);
const TEST_STARTUP_TIMEOUT_MS = parsePositiveInt(
  process.env.WORKGRAPH_TEST_STARTUP_TIMEOUT_MS,
  120_000,
);
const TEST_MAX_RUNTIME_MS = parsePositiveInt(
  process.env.WORKGRAPH_TEST_MAX_RUNTIME_MS,
  20 * 60 * 1000,
);
const REPO_ROOT = process.cwd();
const EXTRA_ARGS = process.argv.slice(2);
const VITEST_INVOCATION_ARGS = ['vitest', 'run', '--config', 'vitest.config.ts', ...EXTRA_ARGS];
const TEST_RESULT_LINE_PATTERN = /^\s*([✓❯×xX])\s+(.+?\.(?:test|spec)\.ts)\s+\(/;

const expectedTestFiles = EXTRA_ARGS.length === 0
  ? collectExpectedTestFiles(REPO_ROOT)
  : null;
const seenTestFiles = new Set();

let sawFailureOutput = false;
let allFilesReportedAt = null;
let sawAnyFileResult = false;
let completed = false;
const startedAt = Date.now();
let lastOutputAt = Date.now();

if (expectedTestFiles) {
  console.log(`[test-runner] expected test files: ${expectedTestFiles.size}`);
} else {
  console.log('[test-runner] filtered run: using idle-timeout exit hygiene mode.');
}

const child = spawnVitest(VITEST_INVOCATION_ARGS);
const unbindStdout = bindLineStream(child.stdout, process.stdout, handleOutputLine);
const unbindStderr = bindLineStream(child.stderr, process.stderr, handleOutputLine);

const monitorTimer = setInterval(() => {
  if (completed) return;

  const now = Date.now();
  if (now - startedAt > TEST_MAX_RUNTIME_MS) {
    finishWithForcedExit(
      1,
      `[test-runner] timeout: test run exceeded ${TEST_MAX_RUNTIME_MS}ms.`,
    );
    return;
  }

  if (!sawAnyFileResult && now - startedAt > TEST_STARTUP_TIMEOUT_MS) {
    finishWithForcedExit(
      1,
      `[test-runner] startup timeout: no test file results observed after ${TEST_STARTUP_TIMEOUT_MS}ms.`,
    );
    return;
  }

  if (allFilesReportedAt !== null && now - allFilesReportedAt > TEST_EXIT_GRACE_MS) {
    const idleForMs = now - lastOutputAt;
    if (!sawFailureOutput && expectedTestFiles && seenTestFiles.size === expectedTestFiles.size) {
      finishWithForcedExit(
        0,
        `[test-runner] all ${seenTestFiles.size}/${expectedTestFiles.size} test files reported; vitest did not exit after ${TEST_EXIT_GRACE_MS}ms grace (idle ${idleForMs}ms). Terminating lingering process tree.`,
      );
      return;
    }
    finishWithForcedExit(
      1,
      `[test-runner] vitest hang detected after test execution with failures or missing file reports (${seenTestFiles.size}/${expectedTestFiles?.size ?? 'n/a'}).`,
    );
    return;
  }

  const idleForMs = now - lastOutputAt;
  if (idleForMs > TEST_IDLE_TIMEOUT_MS && sawAnyFileResult) {
    const expectedSatisfied = expectedTestFiles
      ? seenTestFiles.size === expectedTestFiles.size
      : true;
    if (!sawFailureOutput && expectedSatisfied) {
      finishWithForcedExit(
        0,
        `[test-runner] no output for ${idleForMs}ms after test results; terminating lingering process tree.`,
      );
      return;
    }
    finishWithForcedExit(
      1,
      `[test-runner] no output for ${idleForMs}ms and results were incomplete or failing (${seenTestFiles.size}/${expectedTestFiles?.size ?? 'n/a'}).`,
    );
  }
}, 1_000);

child.on('error', (error) => {
  if (completed) return;
  completed = true;
  cleanup();
  console.error(`[test-runner] failed to start vitest: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (completed) return;
  completed = true;
  cleanup();
  if (signal) {
    console.error(`[test-runner] vitest exited via signal: ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

function handleOutputLine(rawLine) {
  lastOutputAt = Date.now();
  const line = rawLine.trimEnd();
  if (line.includes(' FAIL ') || line.includes('Failed Suites') || line.includes('| 4 failed')) {
    sawFailureOutput = true;
  }

  const match = TEST_RESULT_LINE_PATTERN.exec(line);
  if (!match) return;
  sawAnyFileResult = true;
  const symbol = match[1] ?? '';
  const filePath = normalizePath(match[2] ?? '');
  if (symbol !== '✓') {
    sawFailureOutput = true;
  }
  if (expectedTestFiles && expectedTestFiles.has(filePath)) {
    seenTestFiles.add(filePath);
    if (seenTestFiles.size === expectedTestFiles.size && allFilesReportedAt === null) {
      allFilesReportedAt = Date.now();
      console.log(
        `[test-runner] observed all ${seenTestFiles.size} test file results; awaiting clean vitest shutdown...`,
      );
    }
  }
}

function finishWithForcedExit(exitCode, reason) {
  if (completed) return;
  completed = true;
  cleanup();
  console.error(reason);
  if (expectedTestFiles && seenTestFiles.size !== expectedTestFiles.size) {
    const missing = [...expectedTestFiles]
      .filter((testFile) => !seenTestFiles.has(testFile))
      .slice(0, 10);
    if (missing.length > 0) {
      console.error(`[test-runner] missing test file reports (first ${missing.length}):`);
      for (const item of missing) console.error(`  - ${item}`);
    }
  }
  terminateProcessTree(child.pid);
  process.exit(exitCode);
}

function cleanup() {
  clearInterval(monitorTimer);
  unbindStdout();
  unbindStderr();
}

function spawnVitest(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return spawn(process.execPath, [npmExecPath, ...args], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  if (process.platform === 'win32') {
    const command = ['pnpm', ...args]
      .map((segment) => escapeForCmd(segment))
      .join(' ');
    return spawn('cmd.exe', ['/d', '/s', '/c', command], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  return spawn('pnpm', args, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function terminateProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // best-effort cleanup
  }
}

function bindLineStream(stream, sink, onLine) {
  let buffer = '';
  const handleChunk = (chunk) => {
    const text = String(chunk);
    sink.write(text);
    buffer += text;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      onLine(line);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
    }
  };
  const handleEnd = () => {
    if (buffer.length > 0) {
      onLine(buffer);
      buffer = '';
    }
  };

  stream.on('data', handleChunk);
  stream.on('end', handleEnd);
  return () => {
    stream.off('data', handleChunk);
    stream.off('end', handleEnd);
  };
}

function collectExpectedTestFiles(rootPath) {
  const collected = new Set();

  const packagesPath = path.join(rootPath, 'packages');
  if (fs.existsSync(packagesPath)) {
    for (const entry of fs.readdirSync(packagesPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageDir = path.join(packagesPath, entry.name);
      addTestFilesFromDirectory(rootPath, path.join(packageDir, 'src'), collected);
      addTestFilesFromDirectory(rootPath, path.join(packageDir, 'tests'), collected);
    }
  }

  addTestFilesFromDirectory(rootPath, path.join(rootPath, 'tests'), collected);
  return collected;
}

function addTestFilesFromDirectory(rootPath, directoryPath, targetSet) {
  if (!fs.existsSync(directoryPath)) return;

  const stack = [directoryPath];
  while (stack.length > 0) {
    const currentPath = stack.pop();
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.test.ts') && !entry.name.endsWith('.spec.ts')) continue;
      const relativePath = path.relative(rootPath, entryPath);
      targetSet.add(normalizePath(relativePath));
    }
  }
}

function normalizePath(filePath) {
  return filePath.replaceAll('\\', '/').replace(/^\.\//, '');
}

function parsePositiveInt(rawValue, fallbackValue) {
  if (!rawValue) return fallbackValue;
  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallbackValue;
  return parsed;
}

function escapeForCmd(value) {
  if (!/[ \t"]/u.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}
