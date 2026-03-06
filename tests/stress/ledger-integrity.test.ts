import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ledger as ledgerModule,
} from '@versatly/workgraph-kernel';

const ledger = ledgerModule;

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-stress-ledger-integrity-'));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('stress: ledger burst integrity and crash recovery', () => {
  it('sustains 1000 parallel appends and recovers from truncated crash tail', { timeout: 30_000 }, async () => {
    const totalEntries = 1_000;

    await Promise.all(
      Array.from({ length: totalEntries }, (_value, idx) =>
        Promise.resolve().then(() =>
          ledger.append(
            workspacePath,
            `agent-${idx % 20}`,
            'update',
            `threads/ledger-burst-${idx}.md`,
            'thread',
            { sequence: idx },
          )),
      ),
    );

    const entries = ledger.readAll(workspacePath);
    expect(entries).toHaveLength(totalEntries);

    const uniqueTargets = new Set(entries.map((entry) => entry.target));
    expect(uniqueTargets.size).toBe(totalEntries);
    const uniqueHashes = new Set(entries.map((entry) => String(entry.hash ?? '')));
    expect(uniqueHashes.size).toBe(totalEntries);

    const chainBeforeCrash = ledger.verifyHashChain(workspacePath, { strict: true });
    expect(chainBeforeCrash.ok).toBe(true);
    expect(chainBeforeCrash.issues).toEqual([]);

    const ledgerPath = path.join(workspacePath, '.workgraph', 'ledger.jsonl');
    const rawLedger = fs.readFileSync(ledgerPath, 'utf-8');
    const truncatedCrashImage = rawLedger.slice(0, Math.max(0, rawLedger.length - 15));
    fs.writeFileSync(ledgerPath, truncatedCrashImage, 'utf-8');

    expect(() => ledger.readAll(workspacePath)).toThrow();

    const recoveredLines = recoverTruncatedLedgerTail(workspacePath);
    expect(recoveredLines).toBeGreaterThan(0);
    expect(recoveredLines).toBeLessThan(totalEntries);

    const rebuiltIndex = ledger.rebuildIndex(workspacePath);
    const rebuiltChain = ledger.rebuildHashChainState(workspacePath);
    expect(rebuiltIndex.version).toBeGreaterThan(0);
    expect(rebuiltChain.count).toBe(recoveredLines);

    const recoveredEntries = ledger.readAll(workspacePath);
    expect(recoveredEntries).toHaveLength(recoveredLines);
    expect(new Set(recoveredEntries.map((entry) => entry.target)).size).toBe(recoveredLines);

    const verifyRecovered = ledger.verifyHashChain(workspacePath, { strict: true });
    expect(verifyRecovered.ok).toBe(true);
    expect(verifyRecovered.issues).toEqual([]);
  });
});

function recoverTruncatedLedgerTail(workspacePath: string): number {
  const ledgerPath = path.join(workspacePath, '.workgraph', 'ledger.jsonl');
  const lines = fs.readFileSync(ledgerPath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const recovered: string[] = [];
  for (const line of lines) {
    try {
      JSON.parse(line);
      recovered.push(line);
    } catch {
      break;
    }
  }

  const nextContent = recovered.length === 0
    ? ''
    : `${recovered.join('\n')}\n`;
  fs.writeFileSync(ledgerPath, nextContent, 'utf-8');
  return recovered.length;
}
