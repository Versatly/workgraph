/**
 * Reactive scheduler that watches ledger events and auto-dispatches work.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as ledger from './ledger.js';
import * as dispatch from './dispatch.js';
import * as thread from './thread.js';
import * as store from './store.js';
import type { DispatchRun, LedgerEntry } from './types.js';

const REACTIVE_SCHEDULER_STATE_FILE = '.workgraph/reactive-scheduler-state.json';
const REACTIVE_SCHEDULER_STATE_VERSION = 1;
const DEFAULT_POLL_MS = 1000;
const DEFAULT_MAX_DISPATCHES_PER_CYCLE = 1;

export interface ReactiveSchedulerOptions {
  actor: string;
  adapter?: string;
  agents?: string[];
  space?: string;
  pollMs?: number;
  maxSteps?: number;
  stepDelayMs?: number;
  maxDispatchesPerCycle?: number;
  runOnStart?: boolean;
}

export interface ReactiveSchedulerState {
  version: number;
  cursor: number;
  dispatches: number;
  updatedAt: string;
  lastThreadCompletion?: string;
}

export interface ReactiveSchedulerDispatchResult {
  triggerThreadPath: string;
  runId: string;
  status: string;
}

export interface ReactiveSchedulerCycleResult {
  cycleAt: string;
  previousCursor: number;
  nextCursor: number;
  scannedEntries: number;
  completionEvents: number;
  dispatches: ReactiveSchedulerDispatchResult[];
}

export interface ReactiveSchedulerHandle {
  statePath: string;
  getLastCycle: () => ReactiveSchedulerCycleResult | null;
  stop: () => Promise<void>;
}

export async function runReactiveSchedulerCycle(
  workspacePath: string,
  options: ReactiveSchedulerOptions,
): Promise<ReactiveSchedulerCycleResult> {
  const cycleAt = new Date().toISOString();
  const state = loadSchedulerState(workspacePath);
  const allEntries = ledger.readAll(workspacePath);
  const normalizedCursor = normalizeCursor(state.cursor, allEntries.length);
  const delta = allEntries.slice(normalizedCursor);
  const completionEntries = delta.filter((entry) => isThreadCompletion(entry) && matchesSpace(workspacePath, entry, options.space));
  const dispatches: ReactiveSchedulerDispatchResult[] = [];
  const maxDispatches = clampInt(options.maxDispatchesPerCycle, DEFAULT_MAX_DISPATCHES_PER_CYCLE, 1, 100);

  for (const entry of completionEntries) {
    if (dispatches.length >= maxDispatches) break;
    const readyThreads = options.space
      ? thread.listReadyThreadsInSpace(workspacePath, options.space)
      : thread.listReadyThreads(workspacePath);
    const readyCandidates = readyThreads.filter((candidate) => candidate.path !== entry.target);
    if (readyCandidates.length === 0) continue;

    const run = await dispatch.createAndExecuteRun(
      workspacePath,
      {
        actor: options.actor,
        adapter: options.adapter ?? 'cursor-cloud',
        objective: `Reactive scheduler: continue work after ${entry.target}`,
        context: {
          trigger: 'thread-complete',
          trigger_thread_path: entry.target,
          trigger_entry_ts: entry.ts,
          reactive_scheduler: true,
        },
      },
      {
        agents: options.agents,
        maxSteps: options.maxSteps,
        stepDelayMs: options.stepDelayMs,
        space: options.space,
        createCheckpoint: true,
      },
    );
    dispatches.push({
      triggerThreadPath: entry.target,
      runId: run.id,
      status: run.status,
    });
  }

  const nextState: ReactiveSchedulerState = {
    version: REACTIVE_SCHEDULER_STATE_VERSION,
    cursor: allEntries.length,
    dispatches: state.dispatches + dispatches.length,
    updatedAt: cycleAt,
    ...(completionEntries.length > 0
      ? { lastThreadCompletion: completionEntries[completionEntries.length - 1]!.target }
      : state.lastThreadCompletion ? { lastThreadCompletion: state.lastThreadCompletion } : {}),
  };
  saveSchedulerState(workspacePath, nextState);

  return {
    cycleAt,
    previousCursor: normalizedCursor,
    nextCursor: nextState.cursor,
    scannedEntries: delta.length,
    completionEvents: completionEntries.length,
    dispatches,
  };
}

export function readReactiveSchedulerState(workspacePath: string): ReactiveSchedulerState {
  return loadSchedulerState(workspacePath);
}

export function reactiveSchedulerStatePath(workspacePath: string): string {
  return path.join(workspacePath, REACTIVE_SCHEDULER_STATE_FILE);
}

export function startReactiveScheduler(
  workspacePath: string,
  options: ReactiveSchedulerOptions,
): ReactiveSchedulerHandle {
  const pollMs = clampInt(options.pollMs, DEFAULT_POLL_MS, 50, 60_000);
  const runOnStart = options.runOnStart !== false;
  const statePath = reactiveSchedulerStatePath(workspacePath);
  const ledgerFilePath = ledger.ledgerPath(workspacePath);
  const ledgerDir = path.dirname(ledgerFilePath);
  if (!fs.existsSync(ledgerDir)) fs.mkdirSync(ledgerDir, { recursive: true });
  let lastCycle: ReactiveSchedulerCycleResult | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const triggerCycle = (): void => {
    if (stopped) return;
    if (inFlight) return;
    inFlight = runReactiveSchedulerCycle(workspacePath, options)
      .then((cycle) => {
        lastCycle = cycle;
      })
      .finally(() => {
        inFlight = null;
      });
  };

  const intervalHandle = setInterval(triggerCycle, pollMs);
  intervalHandle.unref();

  const watchTarget = fs.existsSync(ledgerFilePath) ? ledgerFilePath : ledgerDir;
  const watcher = fs.watch(watchTarget, (_eventType, filename) => {
    if (watchTarget === ledgerDir) {
      const changed = typeof filename === 'string' ? filename : '';
      if (changed && changed !== path.basename(ledgerFilePath)) return;
    }
    triggerCycle();
  });

  if (runOnStart) triggerCycle();

  return {
    statePath,
    getLastCycle: () => lastCycle,
    stop: async () => {
      stopped = true;
      clearInterval(intervalHandle);
      watcher.close();
      if (inFlight) {
        await inFlight;
      }
    },
  };
}

function isThreadCompletion(entry: LedgerEntry): boolean {
  return entry.op === 'done' && entry.type === 'thread';
}

function matchesSpace(workspacePath: string, entry: LedgerEntry, space: string | undefined): boolean {
  if (!space) return true;
  const targetThread = store.read(workspacePath, entry.target);
  if (!targetThread) return false;
  const expected = normalizeSpaceRef(space);
  const actual = normalizeSpaceRef(targetThread.fields.space);
  return actual === expected;
}

function normalizeSpaceRef(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return raw.endsWith('.md') ? raw : `${raw}.md`;
}

function normalizeCursor(cursor: number, maxEntries: number): number {
  if (!Number.isInteger(cursor) || cursor < 0) return 0;
  if (cursor > maxEntries) return 0;
  return cursor;
}

function loadSchedulerState(workspacePath: string): ReactiveSchedulerState {
  const statePath = reactiveSchedulerStatePath(workspacePath);
  if (!fs.existsSync(statePath)) {
    return {
      version: REACTIVE_SCHEDULER_STATE_VERSION,
      cursor: 0,
      dispatches: 0,
      updatedAt: new Date(0).toISOString(),
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Partial<ReactiveSchedulerState>;
    return {
      version: REACTIVE_SCHEDULER_STATE_VERSION,
      cursor: Number.isInteger(parsed.cursor) ? Number(parsed.cursor) : 0,
      dispatches: Number.isInteger(parsed.dispatches) ? Number(parsed.dispatches) : 0,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      ...(typeof parsed.lastThreadCompletion === 'string' && parsed.lastThreadCompletion
        ? { lastThreadCompletion: parsed.lastThreadCompletion }
        : {}),
    };
  } catch {
    return {
      version: REACTIVE_SCHEDULER_STATE_VERSION,
      cursor: 0,
      dispatches: 0,
      updatedAt: new Date(0).toISOString(),
    };
  }
}

function saveSchedulerState(workspacePath: string, state: ReactiveSchedulerState): void {
  const statePath = reactiveSchedulerStatePath(workspacePath);
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const raw = Number.isFinite(value) ? Math.trunc(Number(value)) : fallback;
  return Math.min(max, Math.max(min, raw));
}
