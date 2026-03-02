import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import * as workgraph from '../index.js';

export type JsonCapableOptions = {
  json?: boolean;
  workspace?: string;
  vault?: string;
  sharedVault?: string;
  dryRun?: boolean;
  __dryRunWorkspace?: string;
  __dryRunWorkspaceRoot?: string;
  __dryRunOriginal?: string;
};

export function addWorkspaceOption<T extends Command>(command: T): T {
  return command
    .option('-w, --workspace <path>', 'Workgraph workspace path')
    .option('--vault <path>', 'Alias for --workspace')
    .option('--shared-vault <path>', 'Shared vault path (e.g. mounted via Tailscale)')
    .option('--dry-run', 'Execute against a temporary workspace copy and discard changes');
}

export function resolveWorkspacePath(opts: JsonCapableOptions): string {
  const originalWorkspacePath = resolveWorkspacePathBase(opts);
  if (!opts.dryRun) return originalWorkspacePath;
  if (opts.__dryRunWorkspace) return opts.__dryRunWorkspace;

  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workgraph-dry-run-'));
  const sandboxWorkspace = path.join(sandboxRoot, 'workspace');
  if (fs.existsSync(originalWorkspacePath)) {
    fs.cpSync(originalWorkspacePath, sandboxWorkspace, {
      recursive: true,
      force: true,
    });
  } else {
    fs.mkdirSync(sandboxWorkspace, { recursive: true });
  }

  opts.__dryRunWorkspaceRoot = sandboxRoot;
  opts.__dryRunWorkspace = sandboxWorkspace;
  opts.__dryRunOriginal = originalWorkspacePath;
  return sandboxWorkspace;
}

export function resolveWorkspacePathBase(opts: JsonCapableOptions): string {
  const explicit = opts.workspace || opts.vault || opts.sharedVault;
  if (explicit) return path.resolve(explicit);
  if (process.env.WORKGRAPH_SHARED_VAULT) return path.resolve(process.env.WORKGRAPH_SHARED_VAULT);
  if (process.env.WORKGRAPH_PATH) return path.resolve(process.env.WORKGRAPH_PATH);
  return process.cwd();
}

export function resolveInitTargetPath(targetPath: string | undefined, opts: JsonCapableOptions): string {
  const requestedPath = path.resolve(targetPath || resolveWorkspacePathBase(opts));
  if (!opts.dryRun) return requestedPath;
  if (opts.__dryRunWorkspace) return opts.__dryRunWorkspace;

  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workgraph-init-dry-run-'));
  const sandboxWorkspace = path.join(sandboxRoot, path.basename(requestedPath));
  if (fs.existsSync(requestedPath)) {
    fs.cpSync(requestedPath, sandboxWorkspace, {
      recursive: true,
      force: true,
    });
  }

  opts.__dryRunWorkspaceRoot = sandboxRoot;
  opts.__dryRunWorkspace = sandboxWorkspace;
  opts.__dryRunOriginal = requestedPath;
  return sandboxWorkspace;
}

export function parseSetPairs(pairs: string[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eqIdx = String(pair).indexOf('=');
    if (eqIdx === -1) continue;
    const key = String(pair).slice(0, eqIdx).trim();
    const raw = String(pair).slice(eqIdx + 1).trim();
    if (!key) continue;
    fields[key] = parseScalar(raw);
  }
  return fields;
}

export function csv(value?: string): string[] | undefined {
  if (!value) return undefined;
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

type IntegrationInstallCliOptions = JsonCapableOptions & {
  actor: string;
  owner?: string;
  title?: string;
  sourceUrl?: string;
  force?: boolean;
};

export function installNamedIntegration(
  workspacePath: string,
  integrationName: string,
  opts: IntegrationInstallCliOptions,
): Promise<workgraph.InstallSkillIntegrationResult> {
  return workgraph.integration.installIntegration(workspacePath, integrationName, {
    actor: opts.actor,
    owner: opts.owner,
    title: opts.title,
    sourceUrl: opts.sourceUrl,
    force: !!opts.force,
  });
}

export function renderInstalledIntegrationResult(result: workgraph.InstallSkillIntegrationResult): string[] {
  return [
    `${result.replacedExisting ? 'Updated' : 'Installed'} ${result.provider} integration skill: ${result.skill.path}`,
    `Source: ${result.sourceUrl}`,
    `Status: ${String(result.skill.fields.status)}`,
  ];
}

function parseScalar(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (value === '') return '';
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => parseScalar(item.trim()));
  }
  if (value.includes(',')) {
    return value.split(',').map((item) => parseScalar(item.trim()));
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function parsePositiveIntOption(value: unknown, name: string): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${name} value "${String(value)}". Expected a positive integer.`);
  }
  return parsed;
}

export function parsePortOption(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid --port value "${String(value)}". Expected 0..65535.`);
  }
  return parsed;
}

export function parsePositiveNumberOption(value: unknown, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${optionName}. Expected a positive number.`);
  }
  return parsed;
}

export function parseNonNegativeIntOption(value: unknown, name: string): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid --${name} value "${String(value)}". Expected a non-negative integer.`);
  }
  return parsed;
}

export function parsePositiveIntegerOption(value: unknown, optionName: string): number {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${optionName}. Expected a positive integer.`);
  }
  return parsed;
}

export function wantsJson(opts: JsonCapableOptions): boolean {
  if (opts.json) return true;
  if (process.env.WORKGRAPH_JSON === '1') return true;
  return false;
}

export async function runCommand<T>(
  opts: JsonCapableOptions,
  action: () => T | Promise<T>,
  renderText: (result: T) => string[],
): Promise<void> {
  try {
    const result = await action();
    const dryRunMetadata = opts.dryRun
      ? {
          dryRun: true,
          targetWorkspace: opts.__dryRunOriginal ?? resolveWorkspacePathBase(opts),
          sandboxWorkspace: opts.__dryRunWorkspace,
        }
      : {};
    if (wantsJson(opts)) {
      console.log(JSON.stringify({ ok: true, ...dryRunMetadata, data: result }, null, 2));
      return;
    }
    if (opts.dryRun) {
      console.log(
        [
          '[dry-run] Executed against sandbox workspace and discarded changes.',
          `Target: ${opts.__dryRunOriginal ?? resolveWorkspacePathBase(opts)}`,
          `Sandbox: ${opts.__dryRunWorkspace ?? 'n/a'}`,
        ].join(' '),
      );
    }
    const lines = renderText(result);
    for (const line of lines) console.log(line);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (wantsJson(opts)) {
      console.error(JSON.stringify({ ok: false, dryRun: !!opts.dryRun, error: message }, null, 2));
    } else {
      console.error(`Error: ${message}`);
    }
    cleanupDryRunSandbox(opts);
    process.exit(1);
  } finally {
    cleanupDryRunSandbox(opts);
  }
}

function cleanupDryRunSandbox(opts: JsonCapableOptions): void {
  if (!opts.dryRun || !opts.__dryRunWorkspaceRoot) return;
  if (fs.existsSync(opts.__dryRunWorkspaceRoot)) {
    fs.rmSync(opts.__dryRunWorkspaceRoot, { recursive: true, force: true });
  }
  delete opts.__dryRunWorkspaceRoot;
  delete opts.__dryRunWorkspace;
  delete opts.__dryRunOriginal;
}
