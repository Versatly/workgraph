import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  append,
  readAll,
  readSince,
  currentOwner,
  isClaimed,
  historyOf,
  activityOf,
  allClaims,
  recent,
  ledgerIndexPath,
  loadIndex,
  rebuildIndex,
  claimsFromIndex,
  query,
  blame,
  verifyHashChain,
  ledgerChainStatePath,
  rebuildHashChainState,
} from './ledger.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-ledger-'));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('ledger', () => {
  it('appends entries and reads them back', () => {
    append(workspacePath, 'agent-a', 'create', 'threads/auth.md', 'thread');
    append(workspacePath, 'agent-a', 'claim', 'threads/auth.md', 'thread');

    const entries = readAll(workspacePath);
    expect(entries).toHaveLength(2);
    expect(entries[0].op).toBe('create');
    expect(entries[1].op).toBe('claim');
    expect(entries[1].actor).toBe('agent-a');
  });

  it('returns empty array for non-existent ledger', () => {
    expect(readAll(workspacePath)).toEqual([]);
  });

  it('tracks current owner through claim/release cycle', () => {
    const target = 'threads/auth.md';

    expect(currentOwner(workspacePath, target)).toBeNull();

    append(workspacePath, 'agent-a', 'claim', target);
    expect(currentOwner(workspacePath, target)).toBe('agent-a');

    append(workspacePath, 'agent-a', 'release', target);
    expect(currentOwner(workspacePath, target)).toBeNull();

    append(workspacePath, 'agent-b', 'claim', target);
    expect(currentOwner(workspacePath, target)).toBe('agent-b');

    append(workspacePath, 'agent-b', 'done', target);
    expect(currentOwner(workspacePath, target)).toBeNull();
  });

  it('checks if a target is claimed', () => {
    const target = 'threads/auth.md';
    expect(isClaimed(workspacePath, target)).toBe(false);

    append(workspacePath, 'agent-a', 'claim', target);
    expect(isClaimed(workspacePath, target)).toBe(true);

    append(workspacePath, 'agent-a', 'release', target);
    expect(isClaimed(workspacePath, target)).toBe(false);
  });

  it('returns history of a specific target', () => {
    append(workspacePath, 'agent-a', 'create', 'threads/auth.md');
    append(workspacePath, 'agent-a', 'create', 'threads/db.md');
    append(workspacePath, 'agent-a', 'claim', 'threads/auth.md');

    const history = historyOf(workspacePath, 'threads/auth.md');
    expect(history).toHaveLength(2);
  });

  it('returns activity of a specific actor', () => {
    append(workspacePath, 'agent-a', 'create', 'threads/auth.md');
    append(workspacePath, 'agent-b', 'create', 'threads/db.md');
    append(workspacePath, 'agent-a', 'claim', 'threads/auth.md');

    const activity = activityOf(workspacePath, 'agent-a');
    expect(activity).toHaveLength(2);
  });

  it('returns all current claims', () => {
    append(workspacePath, 'agent-a', 'claim', 'threads/auth.md');
    append(workspacePath, 'agent-b', 'claim', 'threads/db.md');
    append(workspacePath, 'agent-a', 'done', 'threads/auth.md');

    const claims = allClaims(workspacePath);
    expect(claims.size).toBe(1);
    expect(claims.get('threads/db.md')).toBe('agent-b');
  });

  it('maintains an index file for active claims', () => {
    append(workspacePath, 'agent-a', 'claim', 'threads/auth.md');
    append(workspacePath, 'agent-b', 'claim', 'threads/db.md');
    append(workspacePath, 'agent-a', 'done', 'threads/auth.md');

    const idx = loadIndex(workspacePath);
    expect(fs.existsSync(ledgerIndexPath(workspacePath))).toBe(true);
    expect(idx?.claims).toEqual({
      'threads/db.md': 'agent-b',
    });
    expect(fs.existsSync(ledgerChainStatePath(workspacePath))).toBe(true);
  });

  it('rebuilds claim index from ledger entries', () => {
    append(workspacePath, 'agent-a', 'claim', 'threads/a.md');
    append(workspacePath, 'agent-b', 'claim', 'threads/b.md');
    append(workspacePath, 'agent-b', 'release', 'threads/b.md');

    fs.rmSync(ledgerIndexPath(workspacePath), { force: true });
    const rebuilt = rebuildIndex(workspacePath);

    expect(rebuilt.claims).toEqual({
      'threads/a.md': 'agent-a',
    });
    expect(claimsFromIndex(workspacePath).get('threads/a.md')).toBe('agent-a');
  });

  it('returns recent entries', () => {
    for (let i = 0; i < 30; i++) {
      append(workspacePath, 'agent', 'create', `threads/t${i}.md`);
    }
    const last10 = recent(workspacePath, 10);
    expect(last10).toHaveLength(10);
    expect(last10[0].target).toBe('threads/t20.md');
  });

  it('stores optional data payload', () => {
    append(workspacePath, 'agent-a', 'block', 'threads/auth.md', 'thread', {
      blocked_by: 'threads/db.md',
      reason: 'Need DB schema first',
    });

    const entries = readAll(workspacePath);
    expect(entries[0].data?.blocked_by).toBe('threads/db.md');
    expect(entries[0].data?.reason).toBe('Need DB schema first');
  });

  it('filters entries since a timestamp', () => {
    append(workspacePath, 'agent-a', 'create', 'threads/old.md');
    const cutoff = new Date().toISOString();
    append(workspacePath, 'agent-b', 'create', 'threads/new.md');

    const recentEntries = readSince(workspacePath, cutoff);
    expect(recentEntries.length).toBeGreaterThanOrEqual(1);
    expect(recentEntries.some(e => e.target === 'threads/new.md')).toBe(true);
  });

  it('queries entries by actor and operation', () => {
    append(workspacePath, 'agent-a', 'create', 'threads/a.md', 'thread');
    append(workspacePath, 'agent-b', 'create', 'threads/b.md', 'thread');
    append(workspacePath, 'agent-a', 'claim', 'threads/a.md', 'thread');
    const result = query(workspacePath, { actor: 'agent-a', op: 'create' });
    expect(result).toHaveLength(1);
    expect(result[0].target).toBe('threads/a.md');
  });

  it('provides blame summary for a target', () => {
    append(workspacePath, 'agent-a', 'create', 'threads/a.md', 'thread');
    append(workspacePath, 'agent-b', 'claim', 'threads/a.md', 'thread');
    append(workspacePath, 'agent-b', 'done', 'threads/a.md', 'thread');

    const result = blame(workspacePath, 'threads/a.md');
    expect(result.totalEntries).toBe(3);
    expect(result.latest?.op).toBe('done');
    expect(result.actors.find(actor => actor.actor === 'agent-b')?.count).toBe(2);
  });

  it('verifies hash-chain integrity and detects tampering', () => {
    append(workspacePath, 'agent-a', 'create', 'threads/a.md', 'thread');
    append(workspacePath, 'agent-a', 'claim', 'threads/a.md', 'thread');
    append(workspacePath, 'agent-a', 'done', 'threads/a.md', 'thread');

    const validResult = verifyHashChain(workspacePath, { strict: true });
    expect(validResult.ok).toBe(true);

    const entries = readAll(workspacePath);
    entries[1].actor = 'intruder';
    fs.writeFileSync(
      path.join(workspacePath, '.clawvault/ledger.jsonl'),
      entries.map(entry => JSON.stringify(entry)).join('\n') + '\n',
      'utf-8',
    );

    const tamperedResult = verifyHashChain(workspacePath, { strict: true });
    expect(tamperedResult.ok).toBe(false);
    expect(tamperedResult.issues.length).toBeGreaterThan(0);
  });

  it('rebuilds hash chain state for legacy ledgers', () => {
    append(workspacePath, 'agent-a', 'create', 'threads/legacy-a.md', 'thread');
    append(workspacePath, 'agent-a', 'create', 'threads/legacy-b.md', 'thread');
    fs.rmSync(ledgerChainStatePath(workspacePath), { force: true });

    const rebuilt = rebuildHashChainState(workspacePath);
    expect(rebuilt.count).toBe(2);
    expect(rebuilt.lastHash.length).toBeGreaterThan(10);
  });
});
