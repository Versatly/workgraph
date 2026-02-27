/**
 * Append-only event ledger.
 *
 * Format: one JSON object per line (.jsonl) in `.clawvault/ledger.jsonl`.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  LedgerChainState,
  LedgerEntry,
  LedgerIndex,
  LedgerOp,
} from './types.js';

const LEDGER_FILE = '.clawvault/ledger.jsonl';
const LEDGER_INDEX_FILE = '.clawvault/ledger-index.json';
const LEDGER_CHAIN_FILE = '.clawvault/ledger-chain.json';
const LEDGER_INDEX_VERSION = 1;
const LEDGER_CHAIN_VERSION = 1;
const LEDGER_GENESIS_HASH = 'GENESIS';

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

export function ledgerPath(workspacePath: string): string {
  return path.join(workspacePath, LEDGER_FILE);
}

export function ledgerIndexPath(workspacePath: string): string {
  return path.join(workspacePath, LEDGER_INDEX_FILE);
}

export function ledgerChainStatePath(workspacePath: string): string {
  return path.join(workspacePath, LEDGER_CHAIN_FILE);
}

export function append(
  workspacePath: string,
  actor: string,
  op: LedgerOp,
  target: string,
  type?: string,
  data?: Record<string, unknown>,
): LedgerEntry {
  const chainState = ensureChainState(workspacePath);
  const baseEntry: LedgerEntry = {
    ts: new Date().toISOString(),
    actor,
    op,
    target,
    ...(type ? { type } : {}),
    ...(data && Object.keys(data).length > 0 ? { data } : {}),
    prevHash: chainState.lastHash,
  };
  const entry: LedgerEntry = {
    ...baseEntry,
    hash: computeEntryHash(baseEntry),
  };

  const lPath = ledgerPath(workspacePath);
  const dir = path.dirname(lPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(lPath, JSON.stringify(entry) + '\n', 'utf-8');
  updateIndexWithEntry(workspacePath, entry);
  updateChainStateWithEntry(workspacePath, entry);
  return entry;
}

export function readAll(workspacePath: string): LedgerEntry[] {
  const lPath = ledgerPath(workspacePath);
  if (!fs.existsSync(lPath)) return [];

  const lines = fs.readFileSync(lPath, 'utf-8').split('\n').filter(Boolean);
  return lines.map(line => JSON.parse(line) as LedgerEntry);
}

export function readSince(workspacePath: string, since: string): LedgerEntry[] {
  return readAll(workspacePath).filter(e => e.ts >= since);
}

export function loadIndex(workspacePath: string): LedgerIndex | null {
  const idxPath = ledgerIndexPath(workspacePath);
  if (!fs.existsSync(idxPath)) return null;
  try {
    const raw = fs.readFileSync(idxPath, 'utf-8');
    return JSON.parse(raw) as LedgerIndex;
  } catch {
    return null;
  }
}

export function loadChainState(workspacePath: string): LedgerChainState | null {
  const chainPath = ledgerChainStatePath(workspacePath);
  if (!fs.existsSync(chainPath)) return null;
  try {
    const raw = fs.readFileSync(chainPath, 'utf-8');
    return JSON.parse(raw) as LedgerChainState;
  } catch {
    return null;
  }
}

export function rebuildIndex(workspacePath: string): LedgerIndex {
  const index = seedIndex();
  const entries = readAll(workspacePath);
  for (const entry of entries) {
    applyClaimMutation(index, entry);
    index.lastEntryTs = entry.ts;
  }
  saveIndex(workspacePath, index);
  return index;
}

export function rebuildHashChainState(workspacePath: string): LedgerChainState {
  const entries = readAll(workspacePath);
  let rollingHash = LEDGER_GENESIS_HASH;

  for (const entry of entries) {
    const normalized = normalizeEntryForHash(entry, rollingHash);
    rollingHash = computeEntryHash(normalized);
  }

  const chainState: LedgerChainState = {
    version: LEDGER_CHAIN_VERSION,
    algorithm: 'sha256',
    lastHash: rollingHash,
    count: entries.length,
    updatedAt: new Date().toISOString(),
  };
  saveChainState(workspacePath, chainState);
  return chainState;
}

export function claimsFromIndex(workspacePath: string): Map<string, string> {
  try {
    const index = loadIndex(workspacePath);
    if (index?.version === LEDGER_INDEX_VERSION) {
      return new Map(Object.entries(index.claims));
    }
    const rebuilt = rebuildIndex(workspacePath);
    return new Map(Object.entries(rebuilt.claims));
  } catch {
    return claimsFromLedger(workspacePath);
  }
}

export interface LedgerQueryOptions {
  actor?: string;
  op?: LedgerOp;
  target?: string;
  targetIncludes?: string;
  type?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export function query(workspacePath: string, options: LedgerQueryOptions = {}): LedgerEntry[] {
  let entries = readAll(workspacePath);
  if (options.actor) entries = entries.filter((entry) => entry.actor === options.actor);
  if (options.op) entries = entries.filter((entry) => entry.op === options.op);
  if (options.target) entries = entries.filter((entry) => entry.target === options.target);
  if (options.targetIncludes) entries = entries.filter((entry) => entry.target.includes(options.targetIncludes!));
  if (options.type) entries = entries.filter((entry) => entry.type === options.type);
  if (options.since) entries = entries.filter((entry) => entry.ts >= options.since!);
  if (options.until) entries = entries.filter((entry) => entry.ts <= options.until!);
  if (options.offset && options.offset > 0) entries = entries.slice(options.offset);
  if (options.limit && options.limit >= 0) entries = entries.slice(0, options.limit);
  return entries;
}

export interface LedgerBlameActorSummary {
  actor: string;
  count: number;
  ops: Record<string, number>;
  lastTs: string;
}

export interface LedgerBlameResult {
  target: string;
  totalEntries: number;
  actors: LedgerBlameActorSummary[];
  latest: LedgerEntry | null;
}

export function blame(workspacePath: string, target: string): LedgerBlameResult {
  const history = historyOf(workspacePath, target);
  const byActor = new Map<string, LedgerBlameActorSummary>();

  for (const entry of history) {
    const existing = byActor.get(entry.actor) ?? {
      actor: entry.actor,
      count: 0,
      ops: {},
      lastTs: entry.ts,
    };
    existing.count += 1;
    existing.ops[entry.op] = (existing.ops[entry.op] ?? 0) + 1;
    if (entry.ts > existing.lastTs) existing.lastTs = entry.ts;
    byActor.set(entry.actor, existing);
  }

  return {
    target,
    totalEntries: history.length,
    actors: [...byActor.values()].sort((a, b) => b.count - a.count || a.actor.localeCompare(b.actor)),
    latest: history.length > 0 ? history[history.length - 1] : null,
  };
}

export interface LedgerVerifyOptions {
  strict?: boolean;
}

export interface LedgerVerifyResult {
  ok: boolean;
  entries: number;
  lastHash: string;
  issues: string[];
  warnings: string[];
  chainState: LedgerChainState | null;
}

export function verifyHashChain(workspacePath: string, options: LedgerVerifyOptions = {}): LedgerVerifyResult {
  const entries = readAll(workspacePath);
  const warnings: string[] = [];
  const issues: string[] = [];
  let rollingHash = LEDGER_GENESIS_HASH;

  for (let idx = 0; idx < entries.length; idx++) {
    const entry = entries[idx];
    const entryNumber = idx + 1;
    if (entry.prevHash === undefined) {
      const message = `Entry #${entryNumber} missing prevHash`;
      if (options.strict) issues.push(message); else warnings.push(message);
    } else if (entry.prevHash !== rollingHash) {
      issues.push(`Entry #${entryNumber} prevHash mismatch`);
    }

    const normalized = normalizeEntryForHash(entry, rollingHash);
    const expectedHash = computeEntryHash(normalized);
    if (entry.hash === undefined) {
      const message = `Entry #${entryNumber} missing hash`;
      if (options.strict) issues.push(message); else warnings.push(message);
      rollingHash = expectedHash;
      continue;
    }

    if (entry.hash !== expectedHash) {
      issues.push(`Entry #${entryNumber} hash mismatch`);
    }
    rollingHash = entry.hash;
  }

  const chainState = loadChainState(workspacePath);
  if (chainState) {
    if (chainState.count !== entries.length) {
      issues.push(`Chain state count mismatch: state=${chainState.count} actual=${entries.length}`);
    }
    if (chainState.lastHash !== rollingHash) {
      issues.push('Chain state lastHash mismatch');
    }
  } else if (entries.length > 0) {
    warnings.push('Ledger chain state file missing');
  }

  return {
    ok: issues.length === 0 && (!options.strict || warnings.length === 0),
    entries: entries.length,
    lastHash: rollingHash,
    issues,
    warnings,
    chainState,
  };
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** Get the current owner of a target (last claim without a subsequent release/done). */
export function currentOwner(workspacePath: string, target: string): string | null {
  return allClaims(workspacePath).get(target) ?? null;
}

/** Check if a target is currently claimed by any agent. */
export function isClaimed(workspacePath: string, target: string): boolean {
  return currentOwner(workspacePath, target) !== null;
}

/** Get all entries for a specific target. */
export function historyOf(workspacePath: string, target: string): LedgerEntry[] {
  return readAll(workspacePath).filter(e => e.target === target);
}

/** Get all entries by a specific actor. */
export function activityOf(workspacePath: string, actor: string): LedgerEntry[] {
  return readAll(workspacePath).filter(e => e.actor === actor);
}

/** Get all currently claimed targets and their owners. */
export function allClaims(workspacePath: string): Map<string, string> {
  return claimsFromIndex(workspacePath);
}

/** Get recent ledger entries (last N). */
export function recent(workspacePath: string, count: number = 20): LedgerEntry[] {
  const all = readAll(workspacePath);
  return all.slice(-count);
}

function updateIndexWithEntry(workspacePath: string, entry: LedgerEntry): void {
  const index = loadIndex(workspacePath) ?? seedIndex();
  applyClaimMutation(index, entry);
  index.lastEntryTs = entry.ts;
  saveIndex(workspacePath, index);
}

function updateChainStateWithEntry(workspacePath: string, entry: LedgerEntry): void {
  const state = ensureChainState(workspacePath);
  const chainState: LedgerChainState = {
    version: LEDGER_CHAIN_VERSION,
    algorithm: 'sha256',
    lastHash: entry.hash ?? state.lastHash,
    count: state.count + 1,
    updatedAt: new Date().toISOString(),
  };
  saveChainState(workspacePath, chainState);
}

function saveIndex(workspacePath: string, index: LedgerIndex): void {
  const idxPath = ledgerIndexPath(workspacePath);
  const dir = path.dirname(idxPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(idxPath, JSON.stringify(index, null, 2) + '\n', 'utf-8');
}

function saveChainState(workspacePath: string, state: LedgerChainState): void {
  const chainPath = ledgerChainStatePath(workspacePath);
  const dir = path.dirname(chainPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(chainPath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

function seedIndex(): LedgerIndex {
  return {
    version: LEDGER_INDEX_VERSION,
    lastEntryTs: '',
    claims: {},
  };
}

function applyClaimMutation(index: LedgerIndex, entry: LedgerEntry): void {
  if (entry.op === 'claim') {
    index.claims[entry.target] = entry.actor;
    return;
  }
  if (entry.op === 'release' || entry.op === 'done' || entry.op === 'cancel') {
    delete index.claims[entry.target];
  }
}

function claimsFromLedger(workspacePath: string): Map<string, string> {
  const claims = new Map<string, string>();
  const entries = readAll(workspacePath);
  for (const entry of entries) {
    if (entry.op === 'claim') claims.set(entry.target, entry.actor);
    if (entry.op === 'release' || entry.op === 'done' || entry.op === 'cancel') {
      claims.delete(entry.target);
    }
  }
  return claims;
}

function ensureChainState(workspacePath: string): LedgerChainState {
  const existing = loadChainState(workspacePath);
  if (existing?.version === LEDGER_CHAIN_VERSION) return existing;
  return rebuildHashChainState(workspacePath);
}

function normalizeEntryForHash(entry: LedgerEntry, fallbackPrevHash: string): LedgerEntry {
  return {
    ts: entry.ts,
    actor: entry.actor,
    op: entry.op,
    target: entry.target,
    ...(entry.type ? { type: entry.type } : {}),
    ...(entry.data ? { data: entry.data } : {}),
    prevHash: entry.prevHash ?? fallbackPrevHash,
  };
}

function computeEntryHash(entry: LedgerEntry): string {
  const payload = stableStringify({
    ts: entry.ts,
    actor: entry.actor,
    op: entry.op,
    target: entry.target,
    ...(entry.type ? { type: entry.type } : {}),
    ...(entry.data ? { data: entry.data } : {}),
    prevHash: entry.prevHash ?? LEDGER_GENESIS_HASH,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}
