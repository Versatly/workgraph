import path from 'node:path';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { query as queryModule, store as storeModule } from '@versatly/workgraph-kernel';
import { checkWriteGate, resolveActor } from '../auth.js';
import { errorResult, okResult } from '../result.js';
import { type WorkgraphMcpServerOptions } from '../types.js';

const query = queryModule;
const store = storeModule;

export function registerPersonTools(server: McpServer, options: WorkgraphMcpServerOptions): void {
  server.registerTool(
    'workgraph_person_list',
    {
      title: 'Person List',
      description: 'List person primitive instances, optionally filtered by tag or text.',
      inputSchema: {
        tag: z.string().optional(),
        text: z.string().optional(),
        limit: z.number().int().min(0).max(1000).optional(),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        const people = query.queryPrimitives(options.workspacePath, {
          type: 'person',
          tag: args.tag,
          text: args.text,
          limit: args.limit,
        });
        return okResult(
          {
            people: people.map(serializePerson),
            count: people.length,
          },
          `Person list returned ${people.length} item(s).`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_person_get',
    {
      title: 'Person Get',
      description: 'Read one person primitive by path.',
      inputSchema: {
        path: z.string().min(1),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        const personPath = normalizePrimitivePath(args.path);
        const person = store.read(options.workspacePath, personPath);
        if (!person || person.type !== 'person') {
          return errorResult(`Person not found: ${personPath}`);
        }
        return okResult({ person: serializePerson(person) }, `Person ${personPath}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_person_create',
    {
      title: 'Person Create',
      description: 'Create a native person primitive instance.',
      inputSchema: {
        actor: z.string().optional(),
        name: z.string().min(1),
        body: z.string().optional(),
        fields: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const gate = checkWriteGate(options, actor, ['mcp:write'], {
          action: 'mcp.person.create',
          target: 'people',
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const created = store.create(
          options.workspacePath,
          'person',
          {
            name: args.name,
            ...(args.fields ?? {}),
          },
          args.body ?? '',
          actor,
        );
        return okResult({ person: serializePerson(created) }, `Created person ${created.path}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_person_update',
    {
      title: 'Person Update',
      description: 'Update a native person primitive instance.',
      inputSchema: {
        path: z.string().min(1),
        actor: z.string().optional(),
        fieldUpdates: z.record(z.string(), z.unknown()).optional(),
        body: z.string().optional(),
        expectedEtag: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const personPath = normalizePrimitivePath(args.path);
        const gate = checkWriteGate(options, actor, ['mcp:write'], {
          action: 'mcp.person.update',
          target: personPath,
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const existing = store.read(options.workspacePath, personPath);
        if (!existing || existing.type !== 'person') {
          return errorResult(`Person not found: ${personPath}`);
        }
        const updated = store.update(
          options.workspacePath,
          personPath,
          args.fieldUpdates ?? {},
          args.body,
          actor,
          {
            expectedEtag: args.expectedEtag,
          },
        );
        return okResult({ person: serializePerson(updated) }, `Updated person ${updated.path}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_person_delete',
    {
      title: 'Person Delete',
      description: 'Archive a native person primitive instance.',
      inputSchema: {
        path: z.string().min(1),
        actor: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const personPath = normalizePrimitivePath(args.path);
        const gate = checkWriteGate(options, actor, ['mcp:write'], {
          action: 'mcp.person.delete',
          target: personPath,
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const person = store.read(options.workspacePath, personPath);
        if (!person || person.type !== 'person') {
          return errorResult(`Person not found: ${personPath}`);
        }
        store.remove(options.workspacePath, personPath, actor);
        return okResult(
          {
            deleted: {
              path: personPath,
              archivePath: `.workgraph/archive/${path.basename(personPath)}`,
            },
          },
          `Archived person ${personPath}.`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

function serializePerson(person: { path: string; type: string; fields: Record<string, unknown>; body: string }) {
  return {
    path: person.path,
    type: person.type,
    name: readNonEmptyString(person.fields.name) ?? person.path,
    preferred_name: readNonEmptyString(person.fields.preferred_name) ?? null,
    email: readNonEmptyString(person.fields.email) ?? null,
    organization: readNonEmptyString(person.fields.organization) ?? null,
    fields: person.fields,
    body: person.body,
  };
}

function normalizePrimitivePath(value: string): string {
  const trimmed = String(value ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!trimmed) {
    throw new Error('Primitive path is required.');
  }
  return trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
