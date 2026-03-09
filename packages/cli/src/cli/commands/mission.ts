import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import * as workgraph from '@versatly/workgraph-kernel';
import {
  addWorkspaceOption,
  csv,
  resolveWorkspacePath,
  runCommand,
} from '../core.js';

export function registerMissionCommands(program: Command, defaultActor: string): void {
  const missionCmd = program
    .command('mission')
    .description('Mission primitive lifecycle and orchestration');

  addWorkspaceOption(
    missionCmd
      .command('create <title>')
      .description('Create a mission in planning state')
      .requiredOption('--goal <goal>', 'Mission goal statement')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--mid <mid>', 'Mission identifier slug override')
      .option('--description <text>', 'Mission summary/description')
      .option('--priority <level>', 'urgent|high|medium|low', 'medium')
      .option('--owner <name>', 'Mission owner')
      .option('--project <ref>', 'Project ref (projects/<slug>.md)')
      .option('--space <ref>', 'Space ref (spaces/<slug>.md)')
      .option('--constraints <items>', 'Comma-separated mission constraints')
      .option('--tags <items>', 'Comma-separated tags')
      .option('--json', 'Emit structured JSON output'),
  ).action((title, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          mission: workgraph.mission.createMission(workspacePath, title, opts.goal, opts.actor, {
            mid: opts.mid,
            description: opts.description,
            priority: normalizePriority(opts.priority),
            owner: opts.owner,
            project: opts.project,
            space: opts.space,
            constraints: csv(opts.constraints),
            tags: csv(opts.tags),
          }),
        };
      },
      (result) => [
        `Created mission: ${result.mission.path}`,
        `Status: ${String(result.mission.fields.status)}`,
      ],
    ),
  );

  addWorkspaceOption(
    missionCmd
      .command('plan <missionRef>')
      .description('Plan mission milestones/features and create feature threads')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--goal <goal>', 'Plan goal override')
      .option('--constraints <items>', 'Comma-separated constraints')
      .option('--estimated-runs <n>', 'Estimated number of runs')
      .option('--estimated-cost-usd <n>', 'Estimated USD cost')
      .option('--append', 'Append milestones instead of replacing')
      .option('--milestones <json>', 'Milestones JSON payload')
      .option('--milestones-file <path>', 'Milestones JSON file path')
      .option('--json', 'Emit structured JSON output'),
  ).action((missionRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const milestones = readMissionMilestonesInput(opts.milestones, opts.milestonesFile);
        return {
          mission: workgraph.mission.planMission(
            workspacePath,
            missionRef,
            {
              goal: opts.goal,
              constraints: csv(opts.constraints),
              estimated_runs: parseOptionalInt(opts.estimatedRuns),
              estimated_cost_usd: parseOptionalNumber(opts.estimatedCostUsd),
              replaceMilestones: !opts.append,
              milestones,
            },
            opts.actor,
          ),
        };
      },
      (result) => [
        `Planned mission: ${result.mission.path}`,
        `Milestones: ${Array.isArray(result.mission.fields.milestones) ? result.mission.fields.milestones.length : 0}`,
      ],
    ),
  );

  addWorkspaceOption(
    missionCmd
      .command('approve <missionRef>')
      .description('Approve planned mission')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--json', 'Emit structured JSON output'),
  ).action((missionRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return {
          mission: workgraph.mission.approveMission(workspacePath, missionRef, opts.actor),
        };
      },
      (result) => [`Approved mission: ${result.mission.path}`],
    ),
  );

  addWorkspaceOption(
    missionCmd
      .command('start <missionRef>')
      .description('Start mission execution and optionally run one orchestrator cycle')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--no-run-cycle', 'Do not run orchestrator cycle after start')
      .option('--json', 'Emit structured JSON output'),
  ).action((missionRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const started = workgraph.mission.startMission(workspacePath, missionRef, opts.actor);
        const cycle = opts.runCycle === false
          ? null
          : workgraph.missionOrchestrator.runMissionOrchestratorCycle(workspacePath, started.path, opts.actor);
        return { mission: started, cycle };
      },
      (result) => [
        `Started mission: ${result.mission.path}`,
        ...(result.cycle ? [`Cycle actions: ${result.cycle.actions.length}`] : []),
      ],
    ),
  );

  addWorkspaceOption(
    missionCmd
      .command('status <missionRef>')
      .description('Show mission primitive status and milestones')
      .option('--json', 'Emit structured JSON output'),
  ).action((missionRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const missionInstance = workgraph.mission.missionStatus(workspacePath, missionRef);
        const progress = workgraph.mission.missionProgress(workspacePath, missionInstance.path);
        return { mission: missionInstance, progress };
      },
      (result) => [
        `Mission: ${result.mission.path}`,
        `Status: ${String(result.mission.fields.status)}`,
        `Progress: ${result.progress.percentComplete}% (${result.progress.doneFeatures}/${result.progress.totalFeatures} features)`,
      ],
    ),
  );

  addWorkspaceOption(
    missionCmd
      .command('progress <missionRef>')
      .description('Show mission progress metrics only')
      .option('--json', 'Emit structured JSON output'),
  ).action((missionRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        return workgraph.mission.missionProgress(workspacePath, missionRef);
      },
      (result) => [
        `Mission ${result.mid}: ${result.status}`,
        `Milestones: ${result.passedMilestones}/${result.totalMilestones}`,
        `Features: ${result.doneFeatures}/${result.totalFeatures}`,
      ],
    ),
  );

  addWorkspaceOption(
    missionCmd
      .command('intervene <missionRef>')
      .description('Intervene in mission execution (status/priority/skip/append milestones)')
      .requiredOption('--reason <reason>', 'Intervention reason')
      .option('-a, --actor <name>', 'Actor', defaultActor)
      .option('--set-priority <priority>', 'urgent|high|medium|low')
      .option('--set-status <status>', 'planning|approved|active|validating|completed|failed')
      .option('--skip-feature <milestoneId:threadPath>', 'Skip one feature in a milestone')
      .option('--append-milestones <json>', 'Milestones JSON to append')
      .option('--append-milestones-file <path>', 'Milestones JSON file to append')
      .option('--json', 'Emit structured JSON output'),
  ).action((missionRef, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const skipFeature = parseSkipFeature(opts.skipFeature);
        const appendMilestones = readMissionMilestonesInput(opts.appendMilestones, opts.appendMilestonesFile, false);
        return {
          mission: workgraph.mission.interveneMission(workspacePath, missionRef, {
            reason: String(opts.reason),
            setPriority: opts.setPriority ? normalizePriority(opts.setPriority) : undefined,
            setStatus: opts.setStatus ? normalizeMissionStatus(opts.setStatus) : undefined,
            skipFeature: skipFeature ?? undefined,
            appendMilestones: appendMilestones.length > 0 ? appendMilestones : undefined,
          }, opts.actor),
        };
      },
      (result) => [`Intervened mission: ${result.mission.path}`],
    ),
  );

  addWorkspaceOption(
    missionCmd
      .command('list')
      .description('List missions')
      .option('--status <status>', 'Filter by mission status')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const missions = workgraph.mission.listMissions(workspacePath)
          .filter((entry) => !opts.status || String(entry.fields.status) === String(opts.status));
        return { missions };
      },
      (result) => {
        if (result.missions.length === 0) return ['No missions found.'];
        return result.missions.map((entry) =>
          `[${String(entry.fields.status)}] ${String(entry.fields.title)} -> ${entry.path}`,
        );
      },
    ),
  );
}

function readMissionMilestonesInput(
  rawJson: string | undefined,
  jsonFile: string | undefined,
  required: boolean = true,
): workgraph.mission.MissionMilestonePlanInput[] {
  if (!rawJson && !jsonFile) {
    if (required) {
      throw new Error('Mission milestones input is required. Use --milestones or --milestones-file.');
    }
    return [];
  }
  const parsed = rawJson
    ? JSON.parse(rawJson)
    : JSON.parse(fs.readFileSync(path.resolve(String(jsonFile)), 'utf-8'));
  if (!Array.isArray(parsed)) {
    throw new Error('Milestones input must be a JSON array.');
  }
  return parsed as workgraph.mission.MissionMilestonePlanInput[];
}

function normalizePriority(value: string): 'urgent' | 'high' | 'medium' | 'low' {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'urgent' || normalized === 'high' || normalized === 'medium' || normalized === 'low') {
    return normalized;
  }
  throw new Error(`Invalid mission priority "${value}". Expected urgent|high|medium|low.`);
}

function normalizeMissionStatus(value: string): workgraph.MissionStatus {
  const normalized = String(value).trim().toLowerCase();
  if (
    normalized === 'planning'
    || normalized === 'approved'
    || normalized === 'active'
    || normalized === 'validating'
    || normalized === 'completed'
    || normalized === 'failed'
  ) {
    return normalized;
  }
  throw new Error(`Invalid mission status "${value}". Expected planning|approved|active|validating|completed|failed.`);
}

function parseOptionalInt(value: unknown): number | undefined {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer value "${String(value)}".`);
  }
  return parsed;
}

function parseOptionalNumber(value: unknown): number | null | undefined {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number value "${String(value)}".`);
  }
  return parsed;
}

function parseSkipFeature(
  value: unknown,
): { milestoneId: string; threadPath: string } | null {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const separator = raw.indexOf(':');
  if (separator <= 0 || separator >= raw.length - 1) {
    throw new Error('Invalid --skip-feature value. Expected "<milestoneId>:<threadPath>".');
  }
  return {
    milestoneId: raw.slice(0, separator).trim(),
    threadPath: raw.slice(separator + 1).trim(),
  };
}
