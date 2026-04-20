import { Command } from 'commander';
import * as workgraph from '@versatly/workgraph-kernel';
import {
  addWorkspaceOption,
  collectFieldSpecs,
  mergeSetPairs,
  normalizeWorkspacePath,
  parseFieldDefinitions,
  readNonEmptyString,
  renderPrimitiveSummary,
  resolveWorkspacePath,
  runCommand,
} from '../core.js';

export function registerPrimitiveTypeCommands(program: Command, defaultActor: string): void {
  const primitiveTypeCmd = program
    .command('primitive-type')
    .description('Manage primitive type schemas');

  addWorkspaceOption(
    primitiveTypeCmd
      .command('define <name>')
      .description('Define a new primitive type')
      .requiredOption('--description <text>', 'Type description')
      .option('-a, --actor <actor>', 'Actor', defaultActor)
      .option('--directory <dir>', 'Storage directory')
      .option('--field <name:type>', 'Repeatable field definition', collectFieldSpecs, [])
      .option('--json', 'Emit structured JSON output'),
  ).action((name, opts) =>
    runCommand(
      opts,
      () => workgraph.registry.defineType(
        resolveWorkspacePath(opts),
        name,
        opts.description,
        parseFieldDefinitions(opts.field),
        opts.actor,
        opts.directory,
      ),
      (result) => [
        `Defined primitive type: ${result.name}`,
        `Directory: ${result.directory}`,
      ],
    ),
  );

  addWorkspaceOption(
    primitiveTypeCmd
      .command('list')
      .description('List registered primitive types')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => ({ types: workgraph.registry.listTypes(resolveWorkspacePath(opts)) }),
      (result) => result.types.map((type) => `${type.name} -> ${type.directory}`),
    ),
  );

  addWorkspaceOption(
    primitiveTypeCmd
      .command('show <typeName>')
      .description('Show one primitive type schema')
      .option('--json', 'Emit structured JSON output'),
  ).action((typeName, opts) =>
    runCommand(
      opts,
      () => {
        const type = workgraph.registry.getType(resolveWorkspacePath(opts), typeName);
        if (!type) throw new Error(`Primitive type not found: ${typeName}`);
        return type;
      },
      (result) => [
        `Primitive type: ${result.name}`,
        `Directory: ${result.directory}`,
        `Retained: ${result.retained ? 'yes' : 'no'}`,
      ],
    ),
  );
}

export function registerPrimitiveInstanceCommands(program: Command, defaultActor: string): void {
  const primitiveCmd = program
    .command('primitive')
    .description('Manage primitive instances');

  addWorkspaceOption(
    primitiveCmd
      .command('create <type>')
      .description('Create a primitive instance')
      .requiredOption('--set <key=value>', 'Repeatable field assignment', collectSetPairs, [])
      .option('-a, --actor <actor>', 'Actor', defaultActor)
      .option('--body <markdown>', 'Markdown body')
      .option('--path <path>', 'Optional explicit workspace-relative path')
      .option('--json', 'Emit structured JSON output'),
  ).action((type, opts) =>
    runCommand(
      opts,
      () => workgraph.store.create(
        resolveWorkspacePath(opts),
        type,
        mergeSetPairs(opts.set),
        opts.body ?? '',
        opts.actor,
        opts.path ? { pathOverride: normalizeWorkspacePath(opts.path) } : undefined,
      ),
      (result) => [
        `Created ${result.type}: ${result.path}`,
      ],
    ),
  );

  addWorkspaceOption(
    primitiveCmd
      .command('show <primitivePath>')
      .description('Show one primitive instance')
      .option('--json', 'Emit structured JSON output'),
  ).action((primitivePath, opts) =>
    runCommand(
      opts,
      () => {
        const instance = workgraph.store.read(resolveWorkspacePath(opts), normalizeWorkspacePath(primitivePath));
        if (!instance) throw new Error(`Primitive not found: ${primitivePath}`);
        return instance;
      },
      (result) => [
        `${result.type}: ${result.path}`,
        ...renderPrimitiveSummary(result),
      ],
    ),
  );

  addWorkspaceOption(
    primitiveCmd
      .command('list')
      .description('List primitive instances')
      .requiredOption('--type <type>', 'Primitive type')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => ({ instances: workgraph.store.list(resolveWorkspacePath(opts), opts.type) }),
      (result) => result.instances.length > 0
        ? result.instances.map((instance) => `${instance.type} ${instance.path}`)
        : ['No primitive instances found.'],
    ),
  );

  addWorkspaceOption(
    primitiveCmd
      .command('update <primitivePath>')
      .description('Update a primitive instance')
      .option('-a, --actor <actor>', 'Actor', defaultActor)
      .option('--body <markdown>', 'Replace markdown body')
      .option('--set <key=value>', 'Repeatable field assignment', collectSetPairs, [])
      .option('--etag <etag>', 'Expected etag for optimistic concurrency')
      .option('--json', 'Emit structured JSON output'),
  ).action((primitivePath, opts) =>
    runCommand(
      opts,
      () => workgraph.store.update(
        resolveWorkspacePath(opts),
        normalizeWorkspacePath(primitivePath),
        mergeSetPairs(opts.set),
        readNonEmptyString(opts.body) ?? opts.body,
        opts.actor,
        {
          expectedEtag: readNonEmptyString(opts.etag),
        },
      ),
      (result) => [
        `Updated ${result.type}: ${result.path}`,
      ],
    ),
  );

  addWorkspaceOption(
    primitiveCmd
      .command('archive <primitivePath>')
      .description('Archive a primitive instance')
      .option('-a, --actor <actor>', 'Actor', defaultActor)
      .option('--json', 'Emit structured JSON output'),
  ).action((primitivePath, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const normalizedPath = normalizeWorkspacePath(primitivePath);
        const instance = workgraph.store.read(workspacePath, normalizedPath);
        if (!instance) throw new Error(`Primitive not found: ${primitivePath}`);
        workgraph.store.remove(workspacePath, normalizedPath, opts.actor);
        return {
          archived: {
            path: normalizedPath,
            type: instance.type,
          },
        };
      },
      (result) => [`Archived ${result.archived.type}: ${result.archived.path}`],
    ),
  );
}

function collectSetPairs(value: string, existing: string[]): string[] {
  existing.push(value);
  return existing;
}
