import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureCliBuiltForTests } from '../helpers/cli-build.js';

describe('OBJ-09 multi-agent showcase', () => {
  beforeAll(() => {
    ensureCliBuiltForTests();
  });

  it('runs end-to-end from a fresh workspace', () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-obj09-showcase-'));
    try {
      const result = spawnSync(
        'bash',
        [
          path.resolve('examples/multi-agent-showcase/run.sh'),
          '--workspace',
          workspacePath,
          '--skip-build',
          '--json',
        ],
        {
          encoding: 'utf-8',
          cwd: path.resolve('.'),
          env: process.env,
        },
      );
      expect(result.status).toBe(0);

      const output = String(result.stdout ?? '').trim();
      let parsed: {
        ok: boolean;
        checks: Record<string, boolean>;
        rollup: { threadCount: number; runCount: number; ledgerEntryCount: number };
      };
      try {
        parsed = JSON.parse(output) as typeof parsed;
      } catch {
        throw new Error(`Showcase output was not valid JSON:\n${output}`);
      }

      expect(parsed.ok).toBe(true);
      expect(parsed.checks.governance).toBe(true);
      expect(parsed.checks.selfAssemblyClaimedReviewerThread).toBe(true);
      expect(parsed.checks.planStepCoordinated).toBe(true);
      expect(parsed.checks.triggerRunEvidence).toBe(true);
      expect(parsed.checks.ledgerActivity).toBe(true);
      expect(parsed.rollup.threadCount).toBeGreaterThanOrEqual(4);
      expect(parsed.rollup.runCount).toBeGreaterThanOrEqual(1);
      expect(parsed.rollup.ledgerEntryCount).toBeGreaterThan(0);

      expect(fs.existsSync(path.join(workspacePath, '.workgraph', 'ledger.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(workspacePath, 'threads'))).toBe(true);
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
