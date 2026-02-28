/**
 * Claude Code / OpenClaw Dispatch Adapter
 * 
 * Bridges WorkGraph dispatch runs to OpenClaw sessions_spawn or
 * local Claude Code CLI execution.
 * 
 * When a trigger fires or a dispatch run is created, this adapter:
 * 1. Takes the objective + context from the run
 * 2. Spawns a Claude Code session (or OpenClaw sub-agent)
 * 3. Monitors completion
 * 4. Reports results back to the run
 */

import type { 
  DispatchAdapter, 
  DispatchAdapterCreateInput, 
  DispatchAdapterRunStatus 
} from '../../runtime-adapter-core/src/contracts.js';
import { execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface ClaudeCodeAdapterConfig {
  /** Working directory for Claude Code sessions */
  workdir?: string;
  /** Model to use (default: claude-sonnet-4-20250514) */
  model?: string;
  /** Max turns before stopping */
  maxTurns?: number;
  /** Whether to use OpenClaw sessions_spawn instead of direct CLI */
  useOpenClaw?: boolean;
  /** Path to store adapter state */
  statePath?: string;
}

interface AdapterRun {
  id: string;
  externalId?: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  objective: string;
  startedAt?: string;
  completedAt?: string;
  output?: string;
  error?: string;
  pid?: number;
}

export class ClaudeCodeAdapter implements DispatchAdapter {
  name = 'claude-code';
  private config: ClaudeCodeAdapterConfig;
  private runs: Map<string, AdapterRun> = new Map();
  private statePath: string;

  constructor(config: ClaudeCodeAdapterConfig = {}) {
    this.config = {
      workdir: config.workdir || process.cwd(),
      model: config.model || 'claude-sonnet-4-20250514',
      maxTurns: config.maxTurns || 25,
      useOpenClaw: config.useOpenClaw ?? false,
      statePath: config.statePath || '.workgraph/adapter-claude-code-state.json',
    };
    this.statePath = this.config.statePath!;
    this.loadState();
  }

  async create(input: DispatchAdapterCreateInput): Promise<DispatchAdapterRunStatus> {
    const runId = `cc_${randomUUID().slice(0, 12)}`;
    const run: AdapterRun = {
      id: runId,
      status: 'queued',
      objective: input.objective,
    };
    this.runs.set(runId, run);
    this.saveState();

    // Immediately try to execute
    this.executeRun(runId, input).catch(err => {
      const r = this.runs.get(runId);
      if (r) {
        r.status = 'failed';
        r.error = err.message;
        r.completedAt = new Date().toISOString();
        this.saveState();
      }
    });

    return { runId, status: 'queued' };
  }

  async status(runId: string): Promise<DispatchAdapterRunStatus> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    return { runId, status: run.status };
  }

  async followup(runId: string, _actor: string, input: string): Promise<DispatchAdapterRunStatus> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    // For Claude Code, followup means sending additional context
    // This could pipe to stdin of a running process
    return { runId, status: run.status };
  }

  async stop(runId: string, _actor: string): Promise<DispatchAdapterRunStatus> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (run.pid) {
      try { process.kill(run.pid, 'SIGTERM'); } catch {}
    }
    run.status = 'cancelled';
    run.completedAt = new Date().toISOString();
    this.saveState();
    return { runId, status: 'cancelled' };
  }

  async logs(runId: string): Promise<Array<{ ts: string; level: 'info' | 'warn' | 'error'; message: string }>> {
    const run = this.runs.get(runId);
    if (!run) return [];
    const logs: Array<{ ts: string; level: 'info' | 'warn' | 'error'; message: string }> = [
      { ts: run.startedAt || new Date().toISOString(), level: 'info', message: `Objective: ${run.objective}` },
    ];
    if (run.output) logs.push({ ts: run.completedAt || new Date().toISOString(), level: 'info', message: run.output.slice(0, 2000) });
    if (run.error) logs.push({ ts: run.completedAt || new Date().toISOString(), level: 'error', message: run.error });
    return logs;
  }

  // ─── Internal execution ───

  private async executeRun(runId: string, input: DispatchAdapterCreateInput): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;

    run.status = 'running';
    run.startedAt = new Date().toISOString();
    this.saveState();

    const contextStr = input.context 
      ? Object.entries(input.context).map(([k, v]) => `${k}: ${v}`).join('\n')
      : '';

    const prompt = [
      `You are an autonomous agent executing a WorkGraph dispatch run.`,
      ``,
      `## Objective`,
      input.objective,
      contextStr ? `\n## Context\n${contextStr}` : '',
      ``,
      `## Rules`,
      `- Execute the objective completely`,
      `- Write results to files when appropriate`, 
      `- Be thorough — this is autonomous work, no human in the loop`,
      `- When done, summarize what you accomplished`,
    ].join('\n');

    try {
      if (this.config.useOpenClaw) {
        // OpenClaw sessions_spawn mode
        const result = await this.executeViaOpenClaw(prompt, input);
        run.output = result;
      } else {
        // Direct Claude Code CLI mode
        const result = await this.executeViaCLI(prompt);
        run.output = result;
      }
      run.status = 'succeeded';
    } catch (err: any) {
      run.status = 'failed';
      run.error = err.message;
    }

    run.completedAt = new Date().toISOString();
    this.saveState();
  }

  private async executeViaCLI(prompt: string): Promise<string> {
    // Use claude CLI in non-interactive mode
    const tempFile = `/tmp/wg-prompt-${Date.now()}.md`;
    fs.writeFileSync(tempFile, prompt);
    
    try {
      const result = execSync(
        `claude -p "${tempFile}" --model ${this.config.model} --max-turns ${this.config.maxTurns} --output-format text 2>&1`,
        {
          encoding: 'utf8',
          timeout: 300_000, // 5 min max
          cwd: this.config.workdir,
          env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli' },
        }
      );
      return result;
    } finally {
      try { fs.unlinkSync(tempFile); } catch {}
    }
  }

  private async executeViaOpenClaw(prompt: string, input: DispatchAdapterCreateInput): Promise<string> {
    // This would use OpenClaw's sessions_spawn API
    // For now, fall back to CLI
    return this.executeViaCLI(prompt);
  }

  // ─── State persistence ───

  private loadState(): void {
    try {
      if (fs.existsSync(this.statePath)) {
        const data = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
        this.runs = new Map(Object.entries(data.runs || {}));
      }
    } catch {}
  }

  private saveState(): void {
    try {
      const dir = path.dirname(this.statePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = { runs: Object.fromEntries(this.runs), updatedAt: new Date().toISOString() };
      fs.writeFileSync(this.statePath, JSON.stringify(data, null, 2));
    } catch {}
  }
}
