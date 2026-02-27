#!/usr/bin/env node

/**
 * Configures an Obsidian vault for the WorkGraph demo:
 * - installs Kanban + Terminal community plugins
 * - writes graph color groups and workspace layout
 * - extracts Obsidian AppImage fallback to /tmp/squashfs-root when needed
 *
 * Usage:
 *   node scripts/setup-obsidian-demo.mjs /tmp/workgraph-obsidian-demo
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const vaultPath = path.resolve(process.argv[2] ?? '/tmp/workgraph-obsidian-demo');

const plugins = {
  'obsidian-kanban': {
    files: {
      'main.js': 'https://github.com/mgmeyers/obsidian-kanban/releases/download/2.0.51/main.js',
      'manifest.json': 'https://github.com/mgmeyers/obsidian-kanban/releases/download/2.0.51/manifest.json',
      'styles.css': 'https://github.com/mgmeyers/obsidian-kanban/releases/download/2.0.51/styles.css',
    },
  },
  terminal: {
    files: {
      'main.js': 'https://github.com/polyipseity/obsidian-terminal/releases/download/3.21.0/main.js',
      'manifest.json': 'https://github.com/polyipseity/obsidian-terminal/releases/download/3.21.0/manifest.json',
      'styles.css': 'https://github.com/polyipseity/obsidian-terminal/releases/download/3.21.0/styles.css',
    },
  },
};

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureObsidianAppImageExtracted() {
  if (fs.existsSync('/tmp/squashfs-root/AppRun')) {
    return;
  }
  const result = spawnSync('/usr/local/bin/obsidian', ['--appimage-extract'], {
    cwd: '/tmp',
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error('Failed to extract Obsidian AppImage fallback.');
  }
}

function writeObsidianConfig(targetVaultPath) {
  const obsidianDir = path.join(targetVaultPath, '.obsidian');
  ensureDir(obsidianDir);
  const graphConfig = {
    'collapse-filter': false,
    showTags: true,
    showAttachments: true,
    showOrphans: true,
    colorGroups: [
      { query: 'path:context-nodes', color: { a: 1, rgb: 16733525 } },
      { query: 'path:workflow-cells', color: { a: 1, rgb: 65535 } },
      { query: 'path:threads', color: { a: 1, rgb: 5635925 } },
      { query: 'path:skills OR path:ops', color: { a: 1, rgb: 16766720 } },
      { query: 'path:spaces', color: { a: 1, rgb: 10066329 } },
    ],
  };
  const workspaceConfig = {
    main: {
      type: 'split',
      direction: 'vertical',
      children: [
        {
          type: 'tabs',
          currentTab: 0,
          children: [
            {
              type: 'leaf',
              state: { type: 'markdown', state: { file: 'ops/Command Center.md' } },
            },
          ],
        },
        {
          type: 'tabs',
          currentTab: 0,
          children: [
            {
              type: 'leaf',
              state: { type: 'markdown', state: { file: 'ops/Workgraph Board.md' } },
            },
          ],
        },
      ],
    },
  };
  fs.writeFileSync(path.join(obsidianDir, 'community-plugins.json'), JSON.stringify(Object.keys(plugins), null, 2) + '\n', 'utf-8');
  fs.writeFileSync(path.join(obsidianDir, 'core-plugins.json'), JSON.stringify(['file-explorer', 'search', 'graph', 'command-palette', 'editor-status', 'backlink', 'outline'], null, 2) + '\n', 'utf-8');
  fs.writeFileSync(path.join(obsidianDir, 'graph.json'), JSON.stringify(graphConfig, null, 2) + '\n', 'utf-8');
  fs.writeFileSync(path.join(obsidianDir, 'workspace.json'), JSON.stringify(workspaceConfig, null, 2) + '\n', 'utf-8');
}

async function installPlugins(targetVaultPath) {
  const pluginRoot = path.join(targetVaultPath, '.obsidian', 'plugins');
  ensureDir(pluginRoot);
  for (const [pluginId, pluginData] of Object.entries(plugins)) {
    const pluginDir = path.join(pluginRoot, pluginId);
    ensureDir(pluginDir);
    for (const [filename, url] of Object.entries(pluginData.files)) {
      const content = await download(url);
      fs.writeFileSync(path.join(pluginDir, filename), content);
    }
  }
}

async function main() {
  if (!fs.existsSync(vaultPath)) {
    throw new Error(`Vault path does not exist: ${vaultPath}`);
  }
  ensureObsidianAppImageExtracted();
  await installPlugins(vaultPath);
  writeObsidianConfig(vaultPath);
  console.log(vaultPath);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
