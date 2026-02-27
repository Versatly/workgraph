/**
 * Primitive registry manifest + Obsidian Bases generation.
 */

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { loadRegistry } from './registry.js';

export interface PrimitiveRegistryManifestField {
  name: string;
  type: string;
  required?: boolean;
  description?: string;
}

export interface PrimitiveRegistryManifestPrimitive {
  name: string;
  directory: string;
  canonical: boolean;
  builtIn: boolean;
  fields: PrimitiveRegistryManifestField[];
}

export interface PrimitiveRegistryManifest {
  version: number;
  generatedAt: string;
  primitives: PrimitiveRegistryManifestPrimitive[];
}

export interface GenerateBasesOptions {
  includeNonCanonical?: boolean;
  outputDirectory?: string;
}

export interface GenerateBasesResult {
  outputDirectory: string;
  generated: string[];
}

const REGISTRY_MANIFEST_FILE = '.clawvault/primitive-registry.yaml';
const DEFAULT_BASES_DIR = '.clawvault/bases';

export function primitiveRegistryManifestPath(workspacePath: string): string {
  return path.join(workspacePath, REGISTRY_MANIFEST_FILE);
}

export function readPrimitiveRegistryManifest(workspacePath: string): PrimitiveRegistryManifest {
  const manifestPath = primitiveRegistryManifestPath(workspacePath);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Primitive registry manifest not found: ${manifestPath}`);
  }
  const raw = fs.readFileSync(manifestPath, 'utf-8');
  return YAML.parse(raw) as PrimitiveRegistryManifest;
}

export function syncPrimitiveRegistryManifest(workspacePath: string): PrimitiveRegistryManifest {
  const registry = loadRegistry(workspacePath);
  const manifest: PrimitiveRegistryManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    primitives: Object.values(registry.types)
      .map((primitive) => ({
        name: primitive.name,
        directory: primitive.directory,
        canonical: primitive.builtIn,
        builtIn: primitive.builtIn,
        fields: Object.entries(primitive.fields).map(([name, field]) => ({
          name,
          type: field.type,
          ...(field.required ? { required: true } : {}),
          ...(field.description ? { description: field.description } : {}),
        })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };

  const manifestPath = primitiveRegistryManifestPath(workspacePath);
  ensureDirectory(path.dirname(manifestPath));
  fs.writeFileSync(manifestPath, YAML.stringify(manifest), 'utf-8');
  return manifest;
}

export function generateBasesFromPrimitiveRegistry(
  workspacePath: string,
  options: GenerateBasesOptions = {},
): GenerateBasesResult {
  const manifest = readPrimitiveRegistryManifest(workspacePath);
  const includeNonCanonical = options.includeNonCanonical === true;
  const outputDirectory = path.join(workspacePath, options.outputDirectory ?? DEFAULT_BASES_DIR);
  ensureDirectory(outputDirectory);

  const generated: string[] = [];
  const primitives = manifest.primitives.filter((primitive) =>
    includeNonCanonical ? true : primitive.canonical
  );

  for (const primitive of primitives) {
    const relBasePath = `${primitive.name}.base`;
    const absBasePath = path.join(outputDirectory, relBasePath);
    const content = renderBaseFile(primitive);
    fs.writeFileSync(absBasePath, content, 'utf-8');
    generated.push(path.relative(workspacePath, absBasePath).replace(/\\/g, '/'));
  }

  return {
    outputDirectory: path.relative(workspacePath, outputDirectory).replace(/\\/g, '/'),
    generated: generated.sort(),
  };
}

function renderBaseFile(primitive: PrimitiveRegistryManifestPrimitive): string {
  const columnFields = primitive.fields
    .map((field) => field.name)
    .filter((name, idx, arr) => arr.indexOf(name) === idx);

  const baseDoc = {
    id: primitive.name,
    title: `${titleCase(primitive.name)} Base`,
    source: {
      type: 'folder',
      path: primitive.directory,
      extension: 'md',
    },
    views: [
      {
        id: 'table',
        type: 'table',
        name: 'All',
        columns: ['file.name', ...columnFields],
      },
    ],
  };

  return YAML.stringify(baseDoc);
}

function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function titleCase(value: string): string {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((segment) => segment[0].toUpperCase() + segment.slice(1))
    .join(' ');
}
