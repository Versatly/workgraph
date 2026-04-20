import path from 'node:path';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  registry as registryModule,
  store as storeModule,
  type PrimitiveInstance,
  type PrimitiveTypeDefinition,
} from '@versatly/workgraph-kernel';
import { checkWriteGate, resolveActor } from '../auth.js';
import { errorResult, okResult } from '../result.js';
import { type WorkgraphMcpServerOptions } from '../types.js';

const registry = registryModule;
const store = storeModule;

const concurrentConflictModeSchema = z.enum(['warn', 'error']);

export function registerPrimitiveTools(server: McpServer, options: WorkgraphMcpServerOptions): void {
  server.registerTool(
    'workgraph_primitive_types',
    {
      title: 'Primitive Types',
      description: 'List available primitive types in the workspace registry.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const types = registry.listTypes(options.workspacePath).map((typeDef) => serializePrimitiveType(typeDef));
        return okResult({ types, count: types.length }, `Primitive type list returned ${types.length} item(s).`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_primitive_get',
    {
      title: 'Primitive Get',
      description: 'Read one primitive instance by workspace-relative path.',
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
        const primitivePath = normalizePrimitivePath(args.path);
        const primitive = store.read(options.workspacePath, primitivePath);
        if (!primitive) {
          return errorResult(`Primitive not found: ${primitivePath}`);
        }
        return okResult({ primitive: serializePrimitive(primitive) }, `Primitive ${primitivePath}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_primitive_create',
    {
      title: 'Primitive Create',
      description: 'Create a primitive instance in the shared workspace.',
      inputSchema: {
        type: z.string().min(1),
        actor: z.string().optional(),
        fields: z.record(z.string(), z.unknown()),
        body: z.string().optional(),
        path: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const createPath = normalizeOptionalPrimitivePath(args.path);
        const gate = checkWriteGate(options, actor, ['mcp:write'], {
          action: 'mcp.primitive.create',
          target: createPath ?? `${args.type}s`,
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const created = store.create(
          options.workspacePath,
          args.type,
          args.fields,
          args.body ?? '',
          actor,
          createPath ? { pathOverride: createPath } : undefined,
        );
        return okResult({ primitive: serializePrimitive(created) }, `Created ${created.type} ${created.path}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_primitive_update',
    {
      title: 'Primitive Update',
      description: 'Update a primitive instance by path.',
      inputSchema: {
        path: z.string().min(1),
        actor: z.string().optional(),
        fieldUpdates: z.record(z.string(), z.unknown()).optional(),
        body: z.string().optional(),
        expectedEtag: z.string().optional(),
        concurrentConflictMode: concurrentConflictModeSchema.optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        const actor = resolveActor(options.workspacePath, args.actor, options.defaultActor);
        const primitivePath = normalizePrimitivePath(args.path);
        const gate = checkWriteGate(options, actor, ['mcp:write'], {
          action: 'mcp.primitive.update',
          target: primitivePath,
        });
        if (!gate.allowed) return errorResult(gate.reason);
        const updated = store.update(
          options.workspacePath,
          primitivePath,
          args.fieldUpdates ?? {},
          args.body,
          actor,
          {
            expectedEtag: args.expectedEtag,
            concurrentConflictMode: args.concurrentConflictMode,
          },
        );
        return okResult({ primitive: serializePrimitive(updated) }, `Updated ${updated.type} ${updated.path}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'workgraph_primitive_delete',
    {
      title: 'Primitive Delete',
      description: 'Archive a primitive instance by path.',
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
        const primitivePath = normalizePrimitivePath(args.path);
        const existing = store.read(options.workspacePath, primitivePath);
        if (!existing) {
          return errorResult(`Primitive not found: ${primitivePath}`);
        }
        const gate = checkWriteGate(options, actor, ['mcp:write'], {
          action: 'mcp.primitive.delete',
          target: primitivePath,
        });
        if (!gate.allowed) return errorResult(gate.reason);
        store.remove(options.workspacePath, primitivePath, actor);
        return okResult(
          {
            deleted: {
              path: primitivePath,
              type: existing.type,
              archivedPath: `.workgraph/archive/${path.basename(primitivePath)}`,
            },
          },
          `Archived ${existing.type} ${primitivePath}.`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

function serializePrimitiveType(typeDef: PrimitiveTypeDefinition) {
  return {
    name: typeDef.name,
    description: typeDef.description,
    directory: typeDef.directory,
    builtIn: typeDef.builtIn,
    retained: typeDef.retained,
    canonical: typeDef.retained,
    createdAt: typeDef.createdAt,
    createdBy: typeDef.createdBy,
    fieldCount: Object.keys(typeDef.fields).length,
  };
}

function serializePrimitive(primitive: PrimitiveInstance) {
  return {
    path: primitive.path,
    type: primitive.type,
    title: readNonEmptyString(primitive.fields.title) ?? readNonEmptyString(primitive.fields.name) ?? primitive.path,
    fields: primitive.fields,
    body: primitive.body,
  };
}

function normalizePrimitivePath(value: string): string {
  const trimmed = String(value ?? '').trim().replace(/\\/g, '/');
  if (!trimmed) {
    throw new Error('Primitive path is required.');
  }
  const withoutPrefix = trimmed.replace(/^\.\//, '');
  const normalized = path.posix.normalize(withoutPrefix);
  if (
    normalized.length === 0 ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized === '..' ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Invalid primitive path "${value}".`);
  }
  return normalized.endsWith('.md') ? normalized : `${normalized}.md`;
}

function normalizeOptionalPrimitivePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? normalizePrimitivePath(trimmed) : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
