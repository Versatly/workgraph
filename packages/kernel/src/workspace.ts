/**
 * Workgraph workspace lifecycle (agent-first, no memory scaffolding).
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadRegistry, saveRegistry, listTypes } from './registry.js';
import { syncPrimitiveRegistryManifest, generateBasesFromPrimitiveRegistry } from './bases.js';
import { refreshWikiLinkGraphIndex } from './graph.js';
import { loadPolicyRegistry } from './policy.js';
import { seedStarterKit, type StarterKitSeedResult } from './starter-kit.js';
import type { WorkgraphWorkspaceConfig } from './types.js';

const WORKGRAPH_CONFIG_FILE = '.workgraph.json';

export interface InitWorkspaceOptions {
  name?: string;
  createTypeDirs?: boolean;
  createReadme?: boolean;
  createBases?: boolean;
}

export interface InitWorkspaceResult {
  workspacePath: string;
  configPath: string;
  config: WorkgraphWorkspaceConfig;
  alreadyInitialized: boolean;
  createdDirectories: string[];
  seededTypes: string[];
  generatedBases: string[];
  primitiveRegistryManifestPath: string;
  readmePath?: string;
  quickstartPath?: string;
  starterKit: StarterKitSeedResult;
  bootstrapTrustToken: string;
  bootstrapTrustTokenPath: string;
  serverConfigPath: string;
}

interface QuickstartTemplateInput {
  workspaceName: string;
  workspacePath: string;
  bootstrapTrustToken: string;
  bootstrapTrustTokenPath: string;
  serverHost: string;
  serverPort: number;
}

export function workspaceConfigPath(workspacePath: string): string {
  return path.join(workspacePath, WORKGRAPH_CONFIG_FILE);
}

export function isWorkgraphWorkspace(workspacePath: string): boolean {
  return fs.existsSync(workspaceConfigPath(workspacePath));
}

export function initWorkspace(targetPath: string, options: InitWorkspaceOptions = {}): InitWorkspaceResult {
  const resolvedPath = path.resolve(targetPath);
  const configPath = workspaceConfigPath(resolvedPath);
  const alreadyInitialized = fs.existsSync(configPath);

  const createdDirectories: string[] = [];
  ensureDir(resolvedPath, createdDirectories);
  ensureDir(path.join(resolvedPath, '.workgraph'), createdDirectories);

  const registry = loadRegistry(resolvedPath);
  saveRegistry(resolvedPath, registry);

  const starterKit = seedStarterKit(resolvedPath);
  syncPrimitiveRegistryManifest(resolvedPath);

  if (options.createTypeDirs !== false) {
    const types = listTypes(resolvedPath);
    for (const typeDef of types) {
      ensureDir(path.join(resolvedPath, typeDef.directory), createdDirectories);
    }
  }

  const config = ensureWorkspaceConfig(configPath, resolvedPath, options.name);

  const readmeEnabled = options.createReadme !== false;
  const readmePath = readmeEnabled
    ? writeReadmeIfMissing(resolvedPath, config.name)
    : undefined;
  const quickstartPath = readmeEnabled
    ? writeQuickstartIfMissing(resolvedPath, {
      workspaceName: config.name,
      workspacePath: resolvedPath,
      bootstrapTrustToken: starterKit.bootstrapTrustToken,
      bootstrapTrustTokenPath: starterKit.bootstrapTrustTokenPath,
      serverHost: starterKit.serverConfig.config.host,
      serverPort: starterKit.serverConfig.config.port,
    })
    : undefined;

  const bases = options.createBases === false
    ? { generated: [] }
    : generateBasesFromPrimitiveRegistry(resolvedPath);
  loadPolicyRegistry(resolvedPath);
  refreshWikiLinkGraphIndex(resolvedPath);

  return {
    workspacePath: resolvedPath,
    configPath,
    config,
    alreadyInitialized,
    createdDirectories,
    seededTypes: listTypes(resolvedPath).map((typeDef) => typeDef.name),
    generatedBases: bases.generated,
    primitiveRegistryManifestPath: '.workgraph/primitive-registry.yaml',
    readmePath,
    quickstartPath,
    starterKit,
    bootstrapTrustToken: starterKit.bootstrapTrustToken,
    bootstrapTrustTokenPath: starterKit.bootstrapTrustTokenPath,
    serverConfigPath: starterKit.serverConfig.path,
  };
}

function ensureWorkspaceConfig(
  configPath: string,
  workspacePath: string,
  requestedName?: string,
): WorkgraphWorkspaceConfig {
  const now = new Date().toISOString();
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Partial<WorkgraphWorkspaceConfig>;
      return {
        name: readNonEmptyString(parsed.name) ?? requestedName ?? path.basename(workspacePath),
        version: readNonEmptyString(parsed.version) ?? '1.0.0',
        mode: 'workgraph',
        createdAt: readNonEmptyString(parsed.createdAt) ?? now,
        updatedAt: readNonEmptyString(parsed.updatedAt) ?? now,
      };
    } catch {
      // Fall through and rewrite a valid workspace config.
    }
  }

  const created: WorkgraphWorkspaceConfig = {
    name: requestedName ?? path.basename(workspacePath),
    version: '1.0.0',
    mode: 'workgraph',
    createdAt: now,
    updatedAt: now,
  };
  fs.writeFileSync(configPath, JSON.stringify(created, null, 2) + '\n', 'utf-8');
  return created;
}

function ensureDir(dirPath: string, createdDirectories: string[]): void {
  if (fs.existsSync(dirPath)) return;
  fs.mkdirSync(dirPath, { recursive: true });
  createdDirectories.push(dirPath);
}

function writeReadmeIfMissing(workspacePath: string, name: string): string {
  const readmePath = path.join(workspacePath, 'README.md');
  if (fs.existsSync(readmePath)) return readmePath;
  const content = `# ${name}

Starter workgraph workspace seeded by \`workgraph init\`.

This workspace includes editable default primitives:

- Roles: \`roles/admin.md\`, \`roles/ops.md\`, \`roles/contributor.md\`, \`roles/viewer.md\`
- Policies: \`policies/registration-approval.md\`, \`policies/thread-lifecycle.md\`, \`policies/escalation.md\`
- Gate: \`policy-gates/completion.md\`
- Space: \`spaces/general.md\`
- Bootstrap trust token: \`trust-tokens/bootstrap-first-agent.md\`

## Next step

Open \`QUICKSTART.md\` for the first-run flow:

1. Start server
2. Register first agent
3. Create first thread
`;
  fs.writeFileSync(readmePath, content, 'utf-8');
  return readmePath;
}

function writeQuickstartIfMissing(workspacePath: string, input: QuickstartTemplateInput): string {
  const quickstartPath = path.join(workspacePath, 'QUICKSTART.md');
  if (fs.existsSync(quickstartPath)) return quickstartPath;

  const content = `# ${input.workspaceName} Quickstart

This workspace is ready to use. Follow these steps in order.

## 1) Start the server

\`\`\`bash
workgraph serve -w "${input.workspacePath}"
\`\`\`

Default server config is in \`.workgraph/server.json\` (host: ${input.serverHost}, port: ${input.serverPort}).

## 2) Register your first agent

Bootstrap trust token path: \`${input.bootstrapTrustTokenPath}\`  
Bootstrap trust token value: \`${input.bootstrapTrustToken}\`

Preferred (approval flow):

\`\`\`bash
workgraph agent request agent-1 -w "${input.workspacePath}" --role roles/admin.md
workgraph agent review agent-1 -w "${input.workspacePath}" --decision approved --actor admin-approver
\`\`\`

Bootstrap fallback (legacy/hybrid migration mode):

\`\`\`bash
workgraph agent register agent-1 -w "${input.workspacePath}" --token ${input.bootstrapTrustToken}
\`\`\`

After registration, edit role/policy primitives as needed:

- \`roles/admin.md\`, \`roles/ops.md\`, \`roles/contributor.md\`, \`roles/viewer.md\`
- \`policies/registration-approval.md\`
- \`policies/thread-lifecycle.md\`
- \`policies/escalation.md\`
- \`policy-gates/completion.md\`

## 3) Create your first thread

\`\`\`bash
workgraph thread create "First coordinated task" \\
  -w "${input.workspacePath}" \\
  --goal "Validate end-to-end flow in this new workspace" \\
  --actor agent-1
\`\`\`

Optional next steps:

- \`workgraph thread list -w "${input.workspacePath}"\`
- \`workgraph thread next --claim -w "${input.workspacePath}" --actor agent-1\`
- \`workgraph ledger show -w "${input.workspacePath}" --count 20\`
`;
  fs.writeFileSync(quickstartPath, content, 'utf-8');
  return quickstartPath;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
