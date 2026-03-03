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
  | 'authorize'
  | 'claim'
  | 'heartbeat'
  | 'release'
  | 'block'
  | 'unblock'
  | 'done'
  | 'reopen'
  | 'cancel'
  | 'rejected'
  | 'define'
  | 'decompose'
  | 'handoff';

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

export type ThreadEvidenceType = 'url' | 'attachment' | 'thread-ref' | 'reply-ref';

export interface ThreadEvidenceItem {
  type: ThreadEvidenceType;
  value: string;
  valid: boolean;
  reason?: string;
}

export type EvidencePolicy = 'strict' | 'relaxed' | 'none';

export interface ThreadEvidenceValidationResult {
  policy: EvidencePolicy;
  evidence: ThreadEvidenceItem[];
  validEvidence: ThreadEvidenceItem[];
  invalidEvidence: ThreadEvidenceItem[];
  ok: boolean;
}

export type ThreadEvidenceInput = string | {
  type?: ThreadEvidenceType;
  value: string;
};

export interface ThreadDoneOptions {
  evidence?: ThreadEvidenceInput[];
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
  done: ['open'],
  cancelled: ['open'],
};

// ---------------------------------------------------------------------------
// Conversation + plan-step lifecycle
// ---------------------------------------------------------------------------

export type ConversationStatus =
  | 'open'
  | 'active'
  | 'blocked'
  | 'done'
  | 'cancelled';

export const CONVERSATION_STATUS_TRANSITIONS: Record<ConversationStatus, ConversationStatus[]> = {
  open: ['active', 'blocked', 'cancelled', 'done'],
  active: ['blocked', 'done', 'cancelled', 'open'],
  blocked: ['active', 'cancelled', 'open'],
  done: ['open'],
  cancelled: ['open'],
};

export type PlanStepStatus =
  | 'open'
  | 'active'
  | 'blocked'
  | 'done'
  | 'cancelled';

export const PLAN_STEP_STATUS_TRANSITIONS: Record<PlanStepStatus, PlanStepStatus[]> = {
  open: ['active', 'blocked', 'cancelled', 'done'],
  active: ['blocked', 'done', 'cancelled', 'open'],
  blocked: ['active', 'cancelled', 'open'],
  done: ['open'],
  cancelled: ['open'],
};

export interface ConversationStateSummary {
  conversationPath: string;
  status: ConversationStatus;
  progress: number;
  messageCount: number;
  threadRefs: string[];
  stepRefs: string[];
  steps: {
    total: number;
    open: number;
    active: number;
    blocked: number;
    done: number;
    cancelled: number;
  };
  threads: {
    total: number;
    open: number;
    active: number;
    blocked: number;
    done: number;
    cancelled: number;
    missing: number;
  };
  updatedAt: string;
}

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

export interface ReconcileIssue {
  code: string;
  message: string;
  target?: string;
  details?: Record<string, unknown>;
}

export interface ReconcileReport {
  violations: ReconcileIssue[];
  warnings: ReconcileIssue[];
  ok: boolean;
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

export type WorkgraphLensId =
  | 'my-work'
  | 'team-risk'
  | 'customer-health'
  | 'exec-brief';

export interface WorkgraphLensDescriptor {
  id: WorkgraphLensId;
  description: string;
}

export interface WorkgraphLensOptions {
  actor?: string;
  lookbackHours?: number;
  staleHours?: number;
  limit?: number;
}

export interface WorkgraphLensItem {
  title: string;
  path?: string;
  status?: string;
  priority?: string;
  owner?: string;
  detail?: string;
  ageHours?: number;
}

export interface WorkgraphLensSection {
  id: string;
  title: string;
  items: WorkgraphLensItem[];
}

export interface WorkgraphLensResult {
  lens: WorkgraphLensId;
  generatedAt: string;
  actor?: string;
  options: {
    lookbackHours: number;
    staleHours: number;
    limit: number;
  };
  metrics: Record<string, number>;
  sections: WorkgraphLensSection[];
  markdown: string;
}

export interface WorkgraphMaterializeLensOptions extends WorkgraphLensOptions {
  outputPath: string;
}

export interface WorkgraphMaterializedLensResult extends WorkgraphLensResult {
  outputPath: string;
  created: boolean;
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
  leaseExpires?: string;
  leaseDurationMinutes?: number;
  heartbeats?: string[];
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
