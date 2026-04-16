import type {
  FieldDefinition,
  PrimitiveQueryFilters,
  WorkgraphLensId,
} from './types.js';

export const CORE_CONTEXT_GRAPH_CONTRACT_VERSION = '2.0.0';

const CORE_CONTEXT_PRIMITIVE_ORDER = [
  'agent',
  'checkpoint',
  'conversation',
  'decision',
  'fact',
  'org',
  'plan-step',
  'policy',
  'space',
  'thread',
] as const;

export type CoreContextPrimitiveName = (typeof CORE_CONTEXT_PRIMITIVE_ORDER)[number];

export interface CoreContextPrimitiveContract {
  name: CoreContextPrimitiveName;
  directory: string;
  requiredFields: string[];
}

export interface CoreContextRelationshipContract {
  id: string;
  from: CoreContextPrimitiveName;
  field: string;
  cardinality: 'one' | 'many';
  expectedFieldTypes: Array<FieldDefinition['type']>;
  to: CoreContextPrimitiveName[];
  expectedRefTypes?: CoreContextPrimitiveName[];
}

export interface CoreContextLensContract {
  id: WorkgraphLensId;
  primitives: CoreContextPrimitiveName[];
}

export interface CoreContextQueryContract {
  filterKeys: Array<keyof PrimitiveQueryFilters>;
}

export interface CoreContextGraphContract {
  version: string;
  primitives: CoreContextPrimitiveContract[];
  relationships: CoreContextRelationshipContract[];
  query: CoreContextQueryContract;
  lenses: CoreContextLensContract[];
}

export const CORE_CONTEXT_QUERY_FILTER_KEYS = [
  'type',
  'status',
  'owner',
  'tag',
  'text',
  'pathIncludes',
  'updatedAfter',
  'updatedBefore',
  'createdAfter',
  'createdBefore',
  'limit',
  'offset',
] as const satisfies ReadonlyArray<keyof PrimitiveQueryFilters>;

export const CORE_CONTEXT_LENS_CONTRACT: ReadonlyArray<CoreContextLensContract> = [
  {
    id: 'my-work',
    primitives: ['thread', 'conversation', 'plan-step', 'checkpoint'],
  },
  {
    id: 'team-risk',
    primitives: ['thread', 'conversation', 'plan-step', 'checkpoint'],
  },
  {
    id: 'customer-health',
    primitives: ['org', 'thread', 'conversation', 'fact', 'decision'],
  },
  {
    id: 'exec-brief',
    primitives: ['org', 'thread', 'conversation', 'decision', 'checkpoint'],
  },
];

const CORE_CONTEXT_PRIMITIVES: Readonly<Record<CoreContextPrimitiveName, Omit<CoreContextPrimitiveContract, 'name'>>> = {
  agent: {
    directory: 'agents',
    requiredFields: ['name'],
  },
  checkpoint: {
    directory: 'checkpoints',
    requiredFields: ['title', 'actor', 'summary', 'created', 'updated'],
  },
  conversation: {
    directory: 'conversations',
    requiredFields: ['title', 'status', 'created', 'updated'],
  },
  decision: {
    directory: 'decisions',
    requiredFields: ['title', 'date'],
  },
  fact: {
    directory: 'facts',
    requiredFields: ['subject', 'predicate', 'object', 'created', 'updated'],
  },
  org: {
    directory: 'orgs',
    requiredFields: ['title', 'created', 'updated'],
  },
  'plan-step': {
    directory: 'plan-steps',
    requiredFields: ['title', 'status', 'progress', 'created', 'updated'],
  },
  policy: {
    directory: 'policies',
    requiredFields: ['title', 'created', 'updated'],
  },
  space: {
    directory: 'spaces',
    requiredFields: ['title', 'created', 'updated'],
  },
  thread: {
    directory: 'threads',
    requiredFields: ['title', 'goal', 'status', 'created', 'updated'],
  },
};

const CORE_CONTEXT_RELATIONSHIPS: ReadonlyArray<CoreContextRelationshipContract> = [
  {
    id: 'conversation.thread_refs',
    from: 'conversation',
    field: 'thread_refs',
    cardinality: 'many',
    expectedFieldTypes: ['list'],
    to: ['thread'],
  },
  {
    id: 'conversation.plan_step_refs',
    from: 'conversation',
    field: 'plan_step_refs',
    cardinality: 'many',
    expectedFieldTypes: ['list'],
    to: ['plan-step'],
  },
  {
    id: 'plan-step.conversation_ref',
    from: 'plan-step',
    field: 'conversation_ref',
    cardinality: 'one',
    expectedFieldTypes: ['ref'],
    expectedRefTypes: ['conversation'],
    to: ['conversation'],
  },
  {
    id: 'plan-step.thread_ref',
    from: 'plan-step',
    field: 'thread_ref',
    cardinality: 'one',
    expectedFieldTypes: ['ref'],
    expectedRefTypes: ['thread'],
    to: ['thread'],
  },
  {
    id: 'plan-step.depends_on',
    from: 'plan-step',
    field: 'depends_on',
    cardinality: 'many',
    expectedFieldTypes: ['list'],
    to: ['plan-step'],
  },
  {
    id: 'thread.parent',
    from: 'thread',
    field: 'parent',
    cardinality: 'one',
    expectedFieldTypes: ['ref'],
    expectedRefTypes: ['thread'],
    to: ['thread'],
  },
  {
    id: 'thread.space',
    from: 'thread',
    field: 'space',
    cardinality: 'one',
    expectedFieldTypes: ['ref'],
    expectedRefTypes: ['space'],
    to: ['space'],
  },
  {
    id: 'thread.deps',
    from: 'thread',
    field: 'deps',
    cardinality: 'many',
    expectedFieldTypes: ['list'],
    to: ['thread'],
  },
  {
    id: 'thread.context_refs',
    from: 'thread',
    field: 'context_refs',
    cardinality: 'many',
    expectedFieldTypes: ['list'],
    to: ['thread', 'space', 'conversation', 'plan-step', 'decision', 'fact', 'policy', 'checkpoint', 'org'],
  },
  {
    id: 'decision.supersedes',
    from: 'decision',
    field: 'supersedes',
    cardinality: 'one',
    expectedFieldTypes: ['ref'],
    expectedRefTypes: ['decision'],
    to: ['decision'],
  },
  {
    id: 'fact.source',
    from: 'fact',
    field: 'source',
    cardinality: 'one',
    expectedFieldTypes: ['ref'],
    to: ['thread', 'conversation', 'plan-step', 'decision', 'checkpoint', 'org'],
  },
];

export const CORE_CONTEXT_GRAPH_CONTRACT: CoreContextGraphContract = {
  version: CORE_CONTEXT_GRAPH_CONTRACT_VERSION,
  primitives: CORE_CONTEXT_PRIMITIVE_ORDER.map((name) => ({
    name,
    ...CORE_CONTEXT_PRIMITIVES[name],
  })),
  relationships: [...CORE_CONTEXT_RELATIONSHIPS],
  query: {
    filterKeys: [...CORE_CONTEXT_QUERY_FILTER_KEYS],
  },
  lenses: [...CORE_CONTEXT_LENS_CONTRACT],
};
