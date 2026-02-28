import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as daemon from './autonomy-daemon.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-daemon-test-'));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('autonomy daemon process model', () => {
  it('reports default status paths and parses heartbeat', () => {
    const statusBefore = daemon.readAutonomyDaemonStatus(workspacePath);
    expect(statusBefore.running).toBe(false);
    expect(statusBefore.pid).toBeUndefined();
    expect(statusBefore.pidPath).toContain('.workgraph/daemon/autonomy.pid');

    const heartbeatPath = statusBefore.heartbeatPath;
    fs.writeFileSync(heartbeatPath, JSON.stringify({
      ts: new Date().toISOString(),
      cycle: 3,
      driftOk: true,
    }, null, 2), 'utf-8');

    const statusAfter = daemon.readAutonomyDaemonStatus(workspacePath);
    expect(statusAfter.heartbeat?.cycle).toBe(3);
    expect(statusAfter.heartbeat?.driftOk).toBe(true);
  });

  it('stops tracked pid processes using pid-file lifecycle', async () => {
    const status = daemon.readAutonomyDaemonStatus(workspacePath);
    const pidPath = status.pidPath;
    const heartbeatPath = status.heartbeatPath;
    fs.writeFileSync(heartbeatPath, JSON.stringify({ ts: new Date().toISOString() }) + '\n', 'utf-8');

    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
      stdio: 'ignore',
    });
    if (!child.pid) throw new Error('Failed to spawn child process for daemon test.');
    fs.writeFileSync(pidPath, `${child.pid}\n`, 'utf-8');

    const runningStatus = daemon.readAutonomyDaemonStatus(workspacePath, { cleanupStalePidFile: false });
    expect(runningStatus.running).toBe(true);
    expect(runningStatus.pid).toBe(child.pid);

    const stopResult = await daemon.stopAutonomyDaemon(workspacePath, {
      timeoutMs: 4000,
    });
    expect(stopResult.previouslyRunning).toBe(true);
    expect(stopResult.stopped).toBe(true);

    const finalStatus = daemon.readAutonomyDaemonStatus(workspacePath);
    expect(finalStatus.running).toBe(false);
  });
});
