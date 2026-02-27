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
  /** Allowed values when type is scalar/string-like. */
  enum?: Array<string | number | boolean>;
  /**
   * Optional semantic template used for additional validation.
   * - slug: lowercase kebab-case token
   * - semver: semantic version (x.y.z)
   * - email: simple email shape
   * - url: absolute http(s) URL
   * - iso-date: ISO-8601 date/time string
   */
  template?: 'slug' | 'semver' | 'email' | 'url' | 'iso-date';
  /**
   * Optional regex pattern constraint for string/ref/date fields.
   * Uses JavaScript regular expression syntax (without delimiters).
   */
  pattern?: string;
  /**
   * For ref fields, constrain references to one or more primitive types.
   * Example: refTypes: ['thread', 'space']
   */
  refTypes?: string[];
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

// ---------------------------------------------------------------------------
// Query and orientation contracts
// ---------------------------------------------------------------------------

export interface PrimitiveQueryFilters {
  type?: string;
  status?: string;
  owner?: string;
  tag?: string;
  text?: string;
  pathIncludes?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  createdAfter?: string;
  createdBefore?: string;
  limit?: number;
  offset?: number;
}

export interface WorkgraphStatusSnapshot {
  generatedAt: string;
  threads: {
    total: number;
    open: number;
    active: number;
    blocked: number;
    done: number;
    cancelled: number;
    ready: number;
  };
  claims: {
    active: number;
  };
  primitives: {
    total: number;
    byType: Record<string, number>;
  };
}

export interface WorkgraphBrief {
  generatedAt: string;
  actor: string;
  myClaims: PrimitiveInstance[];
  myOpenThreads: PrimitiveInstance[];
  blockedThreads: PrimitiveInstance[];
  nextReadyThreads: PrimitiveInstance[];
  recentActivity: LedgerEntry[];
}

// ---------------------------------------------------------------------------
// Policy and dispatch contracts
// ---------------------------------------------------------------------------

export interface PolicyParty {
  id: string;
  roles: string[];
  capabilities: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PolicyRegistry {
  version: number;
  parties: Record<string, PolicyParty>;
}

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface DispatchRun {
  id: string;
  createdAt: string;
  updatedAt: string;
  actor: string;
  adapter: string;
  objective: string;
  status: RunStatus;
  idempotencyKey?: string;
  context?: Record<string, unknown>;
  output?: string;
  error?: string;
  followups: Array<{
    ts: string;
    actor: string;
    input: string;
  }>;
  logs: Array<{
    ts: string;
    level: 'info' | 'warn' | 'error';
    message: string;
  }>;
}
