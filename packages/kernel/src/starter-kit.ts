import { randomBytes } from 'node:crypto';
import * as registry from './registry.js';
import * as store from './store.js';
import {
  ensureServerConfig,
  loadServerConfig,
  type EnsureServerConfigResult,
} from './server-config.js';
import type { FieldDefinition, PrimitiveInstance } from './types.js';

const ROLE_TYPE = 'role';
const TRUST_TOKEN_TYPE = 'trust-token';
const BOOTSTRAP_TRUST_TOKEN_PATH = 'trust-tokens/bootstrap-first-agent.md';
const STARTER_ACTOR = 'system';

interface PrimitiveSeedSpec {
  typeName: string;
  path: string;
  fields: Record<string, unknown>;
  body: string;
}

export interface StarterKitSeedSummary {
  created: string[];
  existing: string[];
}

export interface StarterKitSeedResult {
  roles: StarterKitSeedSummary;
  policies: StarterKitSeedSummary;
  gates: StarterKitSeedSummary;
  spaces: StarterKitSeedSummary;
  orgs: StarterKitSeedSummary;
  trustTokens: StarterKitSeedSummary;
  bootstrapTrustToken: string;
  bootstrapTrustTokenPath: string;
  serverConfig: EnsureServerConfigResult;
}

export function seedStarterKit(workspacePath: string): StarterKitSeedResult {
  ensureStarterTypeDefinitions(workspacePath);

  const roleSeeds = seedGroup(workspacePath, buildRoleSeeds());
  const policySeeds = seedGroup(workspacePath, buildPolicySeeds());
  const gateSeeds = seedGroup(workspacePath, buildGateSeeds());
  const spaceSeeds = seedGroup(workspacePath, buildSpaceSeeds());
  const orgSeeds = seedGroup(workspacePath, buildOrgSeeds());
  const configuredBootstrapPath = loadServerConfig(workspacePath)?.registration.bootstrapTokenPath
    ?? BOOTSTRAP_TRUST_TOKEN_PATH;
  const tokenSeed = seedBootstrapTrustToken(workspacePath, configuredBootstrapPath);
  const serverConfig = ensureServerConfig(workspacePath, {
    bootstrapTokenPath: tokenSeed.instance.path,
  });

  return {
    roles: roleSeeds,
    policies: policySeeds,
    gates: gateSeeds,
    spaces: spaceSeeds,
    orgs: orgSeeds,
    trustTokens: {
      created: tokenSeed.created ? [tokenSeed.instance.path] : [],
      existing: tokenSeed.created ? [] : [tokenSeed.instance.path],
    },
    bootstrapTrustToken: String(tokenSeed.instance.fields.token),
    bootstrapTrustTokenPath: tokenSeed.instance.path,
    serverConfig,
  };
}

function ensureStarterTypeDefinitions(workspacePath: string): void {
  ensureType(workspacePath, ROLE_TYPE, {
    description: 'Workspace role profile used for registration + policy defaults.',
    directory: 'roles',
    fields: {
      description: { type: 'string', required: true },
      capabilities: { type: 'list', default: [] },
      can_register_agents: { type: 'boolean', default: false },
      default_for_bootstrap: { type: 'boolean', default: false },
    },
  });

  ensureType(workspacePath, TRUST_TOKEN_TYPE, {
    description: 'Bootstrap trust token used to register agents.',
    directory: 'trust-tokens',
    fields: {
      token: { type: 'string', required: true },
      status: { type: 'string', default: 'active', enum: ['active', 'used', 'revoked'] },
      max_uses: { type: 'number', default: 1 },
      used_count: { type: 'number', default: 0 },
      used_by: { type: 'list', default: [] },
      default_role: { type: 'string', default: 'admin' },
      expires_at: { type: 'date' },
    },
  });
}

function ensureType(
  workspacePath: string,
  typeName: string,
  definition: {
    description: string;
    directory: string;
    fields: Record<string, FieldDefinition>;
  },
): void {
  const existing = registry.getType(workspacePath, typeName);
  if (existing) return;
  registry.defineType(
    workspacePath,
    typeName,
    definition.description,
    definition.fields,
    STARTER_ACTOR,
    definition.directory,
  );
}

function buildRoleSeeds(): PrimitiveSeedSpec[] {
  return [
    {
      typeName: ROLE_TYPE,
      path: 'roles/admin.md',
      fields: {
        title: 'Admin',
        description: 'Full workspace governance, registration, and policy authority.',
        capabilities: ['promote:sensitive', 'policy:manage', 'dispatch:run', 'gate:manage', 'agent:register'],
        can_register_agents: true,
        default_for_bootstrap: true,
        tags: ['starter-kit', 'role'],
      },
      body: [
        '# Admin Role',
        '',
        'Use this role for trusted maintainers who can manage policy, registration, and escalations.',
        '',
        '## Editable defaults',
        '',
        '- Update `capabilities` in frontmatter to fit your team.',
        '- Add onboarding conventions or runbooks below.',
        '',
      ].join('\n'),
    },
    {
      typeName: ROLE_TYPE,
      path: 'roles/ops.md',
      fields: {
        title: 'Ops',
        description: 'Operations-focused role for incident response and runtime coordination.',
        capabilities: ['dispatch:run', 'thread:manage', 'incident:respond', 'agent:register'],
        can_register_agents: true,
        tags: ['starter-kit', 'role'],
      },
      body: [
        '# Ops Role',
        '',
        'Use this role for reliability, incident response, and production operations.',
        '',
        '## Editable defaults',
        '',
        '- Tune escalation responsibilities.',
        '- Add service-specific operational checklists.',
        '',
      ].join('\n'),
    },
    {
      typeName: ROLE_TYPE,
      path: 'roles/contributor.md',
      fields: {
        title: 'Contributor',
        description: 'Default builder role for day-to-day delivery work.',
        capabilities: ['thread:create', 'thread:update', 'thread:complete'],
        tags: ['starter-kit', 'role'],
      },
      body: [
        '# Contributor Role',
        '',
        'Use this role for most implementation agents or team members.',
        '',
        '## Editable defaults',
        '',
        '- Add capability constraints as needed.',
        '- Define contributor expectations and review boundaries.',
        '',
      ].join('\n'),
    },
    {
      typeName: ROLE_TYPE,
      path: 'roles/viewer.md',
      fields: {
        title: 'Viewer',
        description: 'Read-only observer role for visibility without mutation authority.',
        capabilities: ['thread:read', 'ledger:read', 'status:read'],
        tags: ['starter-kit', 'role'],
      },
      body: [
        '# Viewer Role',
        '',
        'Use this role for stakeholders who need visibility but should not mutate state.',
        '',
        '## Editable defaults',
        '',
        '- Add reporting/query capabilities only.',
        '',
      ].join('\n'),
    },
  ];
}

function buildPolicySeeds(): PrimitiveSeedSpec[] {
  return [
    {
      typeName: 'policy',
      path: 'policies/registration-approval.md',
      fields: {
        title: 'Registration Approval',
        status: 'active',
        scope: 'workspace',
        approvers: ['roles/admin.md'],
        tags: ['starter-kit', 'onboarding'],
      },
      body: [
        '# Registration Approval Policy',
        '',
        'Defines who can approve and manage new agent registrations.',
        '',
        '## Defaults',
        '',
        '- Initial approvers: [[roles/admin.md]]',
        '- Bootstrap registrations should be audited in ledger history.',
        '',
        'Edit this policy to match your governance model.',
        '',
      ].join('\n'),
    },
    {
      typeName: 'policy',
      path: 'policies/thread-lifecycle.md',
      fields: {
        title: 'Thread Lifecycle',
        status: 'active',
        scope: 'thread',
        approvers: ['roles/admin.md', 'roles/ops.md'],
        tags: ['starter-kit', 'threads'],
      },
      body: [
        '# Thread Lifecycle Policy',
        '',
        'Defines ownership, transitions, and quality expectations for thread state changes.',
        '',
        '## Defaults',
        '',
        '- Sensitive lifecycle transitions should be reviewed by [[roles/admin.md]] or [[roles/ops.md]].',
        '- Thread completion should satisfy the completion gate.',
        '',
      ].join('\n'),
    },
    {
      typeName: 'policy',
      path: 'policies/escalation.md',
      fields: {
        title: 'Escalation',
        status: 'active',
        scope: 'incident',
        approvers: ['roles/ops.md', 'roles/admin.md'],
        tags: ['starter-kit', 'incident'],
      },
      body: [
        '# Escalation Policy',
        '',
        'Defines escalation expectations when blocked work or incidents require intervention.',
        '',
        '## Defaults',
        '',
        '- Operational escalation: [[roles/ops.md]]',
        '- Final escalation authority: [[roles/admin.md]]',
        '',
      ].join('\n'),
    },
  ];
}

function buildGateSeeds(): PrimitiveSeedSpec[] {
  return [
    {
      typeName: 'policy-gate',
      path: 'policy-gates/completion.md',
      fields: {
        title: 'Completion Gate',
        status: 'active',
        required_facts: [],
        required_approvals: [],
        min_age_seconds: 0,
        requiredDescendants: true,
        evidencePolicy: 'relaxed',
        tags: ['starter-kit', 'gate'],
      },
      body: [
        '# Completion Gate',
        '',
        'Default quality gate evaluated before claiming/completing gated threads.',
        '',
        '## Defaults',
        '',
        '- Requires descendants to be done/cancelled (`requiredDescendants: true`).',
        '- Uses relaxed evidence policy for fast onboarding.',
        '',
        'Tighten these rules as your team matures.',
        '',
      ].join('\n'),
    },
  ];
}

function buildSpaceSeeds(): PrimitiveSeedSpec[] {
  return [
    {
      typeName: 'space',
      path: 'spaces/general.md',
      fields: {
        title: 'General',
        description: 'Default coordination lane for newly created threads.',
        members: [],
        thread_refs: [],
        tags: ['starter-kit', 'default'],
      },
      body: [
        '# General Space',
        '',
        'Default shared space for team coordination.',
        '',
        '## Suggested use',
        '',
        '- Start initial onboarding threads here.',
        '- Create additional spaces for domain lanes as needed.',
        '',
      ].join('\n'),
    },
  ];
}

function buildOrgSeeds(): PrimitiveSeedSpec[] {
  return [
    {
      typeName: 'org',
      path: 'orgs/company.md',
      fields: {
        title: 'Company',
        mission: 'Deliver reliable outcomes through coordinated, context-rich execution.',
        strategy: 'Scale agent-native workflows with explicit company context and decision memory.',
        structure: 'Cross-functional teams organized around product and customer outcomes.',
        external_links: [],
        tags: ['starter-kit', 'company-context'],
      },
      body: [
        '# Company Context',
        '',
        'This starter org primitive anchors company-wide context for teams, decisions, and patterns.',
        '',
        '## Suggested use',
        '',
        '- Keep mission and strategy current.',
        '- Link strategic notes, teams, and key relationships from this node.',
        '',
      ].join('\n'),
    },
  ];
}

function seedBootstrapTrustToken(workspacePath: string, tokenPath: string): {
  created: boolean;
  instance: PrimitiveInstance;
} {
  const normalizedTokenPath = normalizePrimitivePath(tokenPath);
  const existing = store.read(workspacePath, normalizedTokenPath);
  if (existing) {
    if (existing.type !== TRUST_TOKEN_TYPE) {
      throw new Error(
        `Starter-kit seed conflict at ${normalizedTokenPath}: expected ${TRUST_TOKEN_TYPE}, found ${existing.type}.`,
      );
    }
    const existingToken = String(existing.fields.token ?? '').trim();
    if (existingToken.length > 0) {
      return { created: false, instance: existing };
    }
    const repairedToken = generateBootstrapToken();
    const updated = store.update(
      workspacePath,
      existing.path,
      {
        token: repairedToken,
        status: existing.fields.status ?? 'active',
      },
      undefined,
      STARTER_ACTOR,
    );
    return { created: false, instance: updated };
  }

  const created = store.create(
    workspacePath,
    TRUST_TOKEN_TYPE,
    {
      title: 'Bootstrap First Agent Token',
      token: generateBootstrapToken(),
      status: 'active',
      max_uses: 1,
      used_count: 0,
      used_by: [],
      default_role: 'admin',
      tags: ['starter-kit', 'bootstrap'],
    },
    [
      '# Bootstrap Trust Token',
      '',
      'Use this token to register the first agent in a fresh workspace.',
      '',
      '## Notes',
      '',
      '- Token defaults to a single use.',
      '- Rotate or revoke this token after first registration.',
      '',
    ].join('\n'),
    STARTER_ACTOR,
    { pathOverride: normalizedTokenPath },
  );
  return { created: true, instance: created };
}

function seedGroup(workspacePath: string, specs: PrimitiveSeedSpec[]): StarterKitSeedSummary {
  const created: string[] = [];
  const existing: string[] = [];
  for (const spec of specs) {
    const seeded = seedPrimitiveIfMissing(workspacePath, spec);
    if (seeded.created) {
      created.push(seeded.instance.path);
    } else {
      existing.push(seeded.instance.path);
    }
  }
  return { created, existing };
}

function seedPrimitiveIfMissing(
  workspacePath: string,
  spec: PrimitiveSeedSpec,
): { created: boolean; instance: PrimitiveInstance } {
  const normalizedPath = normalizePrimitivePath(spec.path);
  const existing = store.read(workspacePath, normalizedPath);
  if (existing) {
    if (existing.type !== spec.typeName) {
      throw new Error(
        `Starter-kit seed conflict at ${normalizedPath}: expected ${spec.typeName}, found ${existing.type}.`,
      );
    }
    return { created: false, instance: existing };
  }

  const created = store.create(
    workspacePath,
    spec.typeName,
    spec.fields,
    spec.body,
    STARTER_ACTOR,
    { pathOverride: normalizedPath },
  );
  return { created: true, instance: created };
}

function normalizePrimitivePath(rawPath: string): string {
  const normalized = String(rawPath)
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  return normalized.endsWith('.md') ? normalized : `${normalized}.md`;
}

function generateBootstrapToken(): string {
  return `wg-bootstrap-${randomBytes(12).toString('hex')}`;
}
