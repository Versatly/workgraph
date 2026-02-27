/**
 * Workgraph type definitions.
 */

// ---------------------------------------------------------------------------
// Primitive type registry
// ---------------------------------------------------------------------------

export interface FieldDefinition {
  type: 'string' | 'number' | 'boolean' | 'list' | 'date' | 'ref' | 'any';
  required?: boolean;
  default?: unknown;
  description?: string;
}

export interface PrimitiveTypeDefinition {
  name: string;
  description: string;
  fields: Record<string, FieldDefinition>;
  /** Directory under workspace root where instances live (default: `<name>s/`). */
  directory: string;
  /** Whether this type was defined by an agent at runtime vs built-in. */
  builtIn: boolean;
  /** ISO timestamp of when this type was registered. */
  createdAt: string;
  /** Who registered it (agent name or "system"). */
  createdBy: string;
}

export interface Registry {
  version: number;
  types: Record<string, PrimitiveTypeDefinition>;
}

// ---------------------------------------------------------------------------
// Ledger events
// ---------------------------------------------------------------------------

export type LedgerOp =
  | 'create'
  | 'update'
  | 'delete'
  | 'claim'
  | 'release'
  | 'block'
  | 'unblock'
  | 'done'
  | 'cancel'
  | 'define'
  | 'decompose';

export interface LedgerEntry {
  ts: string;
  actor: string;
  op: LedgerOp;
  target: string;
  type?: string;
  data?: Record<string, unknown>;
  prevHash?: string;
  hash?: string;
}

export interface LedgerIndex {
  version: number;
  lastEntryTs: string;
  claims: Record<string, string>;
}

export interface LedgerChainState {
  version: number;
  algorithm: 'sha256';
  lastHash: string;
  count: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Thread status lifecycle
// ---------------------------------------------------------------------------

export type ThreadStatus =
  | 'open'
  | 'active'
  | 'blocked'
  | 'done'
  | 'cancelled';

export const THREAD_STATUS_TRANSITIONS: Record<ThreadStatus, ThreadStatus[]> = {
  open: ['active', 'cancelled'],
  active: ['blocked', 'done', 'cancelled', 'open'],
  blocked: ['active', 'cancelled'],
  done: [],
  cancelled: ['open'],
};

// ---------------------------------------------------------------------------
// Primitive instance
// ---------------------------------------------------------------------------

export interface PrimitiveInstance {
  /** File path relative to workspace root. */
  path: string;
  /** Primitive type name. */
  type: string;
  /** Frontmatter fields. */
  fields: Record<string, unknown>;
  /** Markdown body content. */
  body: string;
}

export interface WorkgraphWorkspaceConfig {
  name: string;
  version: string;
  mode: 'workgraph';
  createdAt: string;
  updatedAt: string;
}
