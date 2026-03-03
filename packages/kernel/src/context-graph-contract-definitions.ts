import type {
  FieldDefinition,
  PrimitiveQueryFilters,
  WorkgraphLensId,
} from './types.js';

export const CORE_CONTEXT_GRAPH_CONTRACT_VERSION = '1.0.0';

const CORE_CONTEXT_PRIMITIVE_ORDER = [
  'agent',
  'checkpoint',
  'client',
  'decision',
  'fact',
  'incident',
  'lesson',
  'onboarding',
  'person',
  'policy',
  'project',
  'run',
  'skill',
  'space',
  'thread',
  'trigger',
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
    primitives: ['thread'],
  },
  {
    id: 'team-risk',
    primitives: ['thread', 'incident', 'run'],
  },
  {
    id: 'customer-health',
    primitives: ['thread', 'incident', 'client'],
  },
  {
    id: 'exec-brief',
    primitives: ['thread', 'decision', 'run'],
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
  client: {
    directory: 'clients',
    requiredFields: ['name', 'created', 'updated'],
  },
  decision: {
    directory: 'decisions',
    requiredFields: ['title', 'date'],
  },
  fact: {
    directory: 'facts',
    requiredFields: ['subject', 'predicate', 'object', 'created', 'updated'],
  },
  incident: {
    directory: 'incidents',
    requiredFields: ['title', 'created', 'updated'],
  },
  lesson: {
    directory: 'lessons',
    requiredFields: ['title', 'date'],
  },
  onboarding: {
    directory: 'onboarding',
    requiredFields: ['title', 'actor', 'created', 'updated'],
  },
  person: {
    directory: 'people',
    requiredFields: ['name', 'created', 'updated'],
  },
  policy: {
    directory: 'policies',
    requiredFields: ['title', 'created', 'updated'],
  },
  project: {
    directory: 'projects',
    requiredFields: ['title', 'created', 'updated'],
  },
  run: {
    directory: 'runs',
    requiredFields: ['title', 'objective', 'runtime', 'status', 'run_id', 'created', 'updated'],
  },
  skill: {
    directory: 'skills',
    requiredFields: ['title', 'status', 'created', 'updated'],
  },
  space: {
    directory: 'spaces',
    requiredFields: ['title', 'created', 'updated'],
  },
  thread: {
    directory: 'threads',
    requiredFields: ['title', 'goal', 'status', 'created', 'updated'],
  },
  trigger: {
    directory: 'triggers',
    requiredFields: ['title', 'action', 'created', 'updated'],
  },
};

const CORE_CONTEXT_RELATIONSHIPS: ReadonlyArray<CoreContextRelationshipContract> = [
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
    to: ['thread', 'space', 'project', 'client', 'decision', 'lesson', 'fact', 'incident', 'policy', 'skill', 'checkpoint', 'onboarding', 'run', 'trigger'],
  },
  {
    id: 'project.client',
    from: 'project',
    field: 'client',
    cardinality: 'one',
    expectedFieldTypes: ['ref'],
    expectedRefTypes: ['client'],
    to: ['client'],
  },
  {
    id: 'project.member_refs',
    from: 'project',
    field: 'member_refs',
    cardinality: 'many',
    expectedFieldTypes: ['list'],
    to: ['person', 'agent'],
  },
  {
    id: 'project.thread_refs',
    from: 'project',
    field: 'thread_refs',
    cardinality: 'many',
    expectedFieldTypes: ['list'],
    to: ['thread'],
  },
  {
    id: 'person.client',
    from: 'person',
    field: 'client',
    cardinality: 'one',
    expectedFieldTypes: ['ref'],
    expectedRefTypes: ['client'],
    to: ['client'],
  },
  {
    id: 'client.contact_ref',
    from: 'client',
    field: 'contact_ref',
    cardinality: 'one',
    expectedFieldTypes: ['ref'],
    expectedRefTypes: ['person'],
    to: ['person'],
  },
  {
    id: 'client.project_refs',
    from: 'client',
    field: 'project_refs',
    cardinality: 'many',
    expectedFieldTypes: ['list'],
    to: ['project'],
  },
  {
    id: 'decision.context_refs',
    from: 'decision',
    field: 'context_refs',
    cardinality: 'many',
    expectedFieldTypes: ['list'],
    to: ['thread', 'project', 'client', 'fact', 'lesson', 'incident', 'policy'],
  },
  {
    id: 'lesson.context_refs',
    from: 'lesson',
    field: 'context_refs',
    cardinality: 'many',
    expectedFieldTypes: ['list'],
    to: ['thread', 'project', 'client', 'decision', 'fact', 'incident'],
  },
  {
    id: 'skill.proposal_thread',
    from: 'skill',
    field: 'proposal_thread',
    cardinality: 'one',
    expectedFieldTypes: ['ref'],
    to: ['thread'],
  },
  {
    id: 'skill.depends_on',
    from: 'skill',
    field: 'depends_on',
    cardinality: 'many',
    expectedFieldTypes: ['list'],
    to: ['skill'],
  },
  {
    id: 'onboarding.thread_refs',
    from: 'onboarding',
    field: 'thread_refs',
    cardinality: 'many',
    expectedFieldTypes: ['list'],
    to: ['thread'],
  },
  {
    id: 'onboarding.spaces',
    from: 'onboarding',
    field: 'spaces',
    cardinality: 'many',
    expectedFieldTypes: ['list'],
    to: ['space'],
  },
];

export const CORE_CONTEXT_GRAPH_CONTRACT: Readonly<CoreContextGraphContract> = {
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
