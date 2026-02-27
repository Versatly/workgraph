/**
 * Agent-first onboarding flow for new workgraph workspaces.
 */

import * as board from './board.js';
import * as commandCenter from './command-center.js';
import * as orientation from './orientation.js';
import * as store from './store.js';

export interface OnboardOptions {
  actor: string;
  spaces?: string[];
  createDemoThreads?: boolean;
}

export interface OnboardResult {
  actor: string;
  spacesCreated: string[];
  threadsCreated: string[];
  boardPath: string;
  commandCenterPath: string;
  checkpointPath: string;
}

export function onboardWorkspace(workspacePath: string, options: OnboardOptions): OnboardResult {
  const spaces = options.spaces && options.spaces.length > 0
    ? options.spaces
    : ['platform', 'product', 'operations'];

  const spacesCreated: string[] = [];
  for (const space of spaces) {
    const title = titleCase(space);
    const created = store.create(
      workspacePath,
      'space',
      {
        title,
        description: `${title} workspace lane`,
        members: [options.actor],
        tags: ['onboarded'],
      },
      `# ${title}\n\nAuto-created during onboarding.\n`,
      options.actor,
    );
    spacesCreated.push(created.path);
  }

  const threadsCreated: string[] = [];
  if (options.createDemoThreads !== false) {
    const templates = [
      { title: 'Review workspace policy gates', goal: 'Validate sensitive transitions are governed.', space: spacesCreated[0] },
      { title: 'Configure board sync cadence', goal: 'Set board update expectations for all agents.', space: spacesCreated[1] ?? spacesCreated[0] },
      { title: 'Establish daily checkpoint routine', goal: 'Agents leave actionable hand-off notes.', space: spacesCreated[2] ?? spacesCreated[0] },
    ];

    for (const template of templates) {
      const created = store.create(
        workspacePath,
        'thread',
        {
          title: template.title,
          goal: template.goal,
          status: 'open',
          priority: 'medium',
          space: template.space,
          context_refs: [template.space],
          tags: ['onboarding'],
        },
        `## Goal\n\n${template.goal}\n`,
        options.actor,
      );
      threadsCreated.push(created.path);
    }
  }

  const boardResult = board.generateKanbanBoard(workspacePath, { outputPath: 'ops/Onboarding Board.md' });
  const commandCenterResult = commandCenter.generateCommandCenter(workspacePath, {
    outputPath: 'ops/Onboarding Command Center.md',
    actor: options.actor,
  });
  const checkpointResult = orientation.checkpoint(
    workspacePath,
    options.actor,
    'Onboarding completed and workspace views initialized.',
    {
      next: ['Claim your next ready thread via `workgraph thread next --claim`'],
      blocked: [],
      tags: ['onboarding'],
    },
  );

  return {
    actor: options.actor,
    spacesCreated,
    threadsCreated,
    boardPath: boardResult.outputPath,
    commandCenterPath: commandCenterResult.outputPath,
    checkpointPath: checkpointResult.path,
  };
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]/g)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}
