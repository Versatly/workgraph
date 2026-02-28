import { ShellWorkerAdapter } from './adapter-shell-worker.js';
import type {
  DispatchAdapter,
  DispatchAdapterCreateInput,
  DispatchAdapterExecutionInput,
  DispatchAdapterExecutionResult,
  DispatchAdapterLogEntry,
  DispatchAdapterRunStatus,
} from './runtime-adapter-contracts.js';

/**
 * Claude Code adapter backed by the shell worker transport.
 *
 * This keeps runtime orchestration in-kernel while allowing concrete execution
 * through a production command template configured per environment.
 */
export class ClaudeCodeAdapter implements DispatchAdapter {
  name = 'claude-code';
  private readonly shellWorker = new ShellWorkerAdapter();

  async create(input: DispatchAdapterCreateInput): Promise<DispatchAdapterRunStatus> {
    return this.shellWorker.create(input);
  }

  async status(runId: string): Promise<DispatchAdapterRunStatus> {
    return this.shellWorker.status(runId);
  }

  async followup(runId: string, actor: string, input: string): Promise<DispatchAdapterRunStatus> {
    return this.shellWorker.followup(runId, actor, input);
  }

  async stop(runId: string, actor: string): Promise<DispatchAdapterRunStatus> {
    return this.shellWorker.stop(runId, actor);
  }

  async logs(runId: string): Promise<DispatchAdapterLogEntry[]> {
    return this.shellWorker.logs(runId);
  }

  async execute(input: DispatchAdapterExecutionInput): Promise<DispatchAdapterExecutionResult> {
    const template = readString(input.context?.claude_command_template)
      ?? process.env.WORKGRAPH_CLAUDE_COMMAND_TEMPLATE;

    if (!template) {
      return {
        status: 'failed',
        error: [
          'claude-code adapter requires a command template.',
          'Set context.claude_command_template or WORKGRAPH_CLAUDE_COMMAND_TEMPLATE.',
          'Template tokens: {workspace}, {run_id}, {actor}, {objective}, {prompt}, {prompt_shell}.',
          'Example: claude -p {prompt_shell}',
        ].join(' '),
        logs: [
          {
            ts: new Date().toISOString(),
            level: 'error',
            message: 'Missing Claude command template.',
          },
        ],
      };
    }

    const prompt = buildPrompt(input);
    const command = applyTemplate(template, {
      workspace: input.workspacePath,
      run_id: input.runId,
      actor: input.actor,
      objective: input.objective,
      prompt,
      prompt_shell: quoteForShell(prompt),
    });

    const context = {
      ...input.context,
      shell_command: command,
      shell_cwd: readString(input.context?.shell_cwd) ?? input.workspacePath,
      shell_timeout_ms: input.context?.shell_timeout_ms ?? process.env.WORKGRAPH_CLAUDE_TIMEOUT_MS,
    };

    const result = await this.shellWorker.execute({
      ...input,
      context,
    });
    const logs = [
      {
        ts: new Date().toISOString(),
        level: 'info' as const,
        message: 'claude-code adapter dispatched shell execution from command template.',
      },
      ...(result.logs ?? []),
    ];
    return {
      ...result,
      logs,
      metrics: {
        ...(result.metrics ?? {}),
        adapter: 'claude-code',
      },
    };
  }
}

function buildPrompt(input: DispatchAdapterExecutionInput): string {
  const extraInstructions = readString(input.context?.claude_instructions);
  const sections = [
    `Workgraph run id: ${input.runId}`,
    `Actor: ${input.actor}`,
    `Objective: ${input.objective}`,
    `Workspace: ${input.workspacePath}`,
  ];
  if (extraInstructions) {
    sections.push(`Instructions: ${extraInstructions}`);
  }
  return sections.join('\n');
}

function applyTemplate(template: string, values: Record<string, string>): string {
  let rendered = template;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{${key}}`, value);
  }
  return rendered;
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
