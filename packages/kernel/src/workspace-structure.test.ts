import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const PACKAGES_ROOT = path.join(REPO_ROOT, 'packages');
const PACKAGE_NAME_PREFIX = '@versatly/workgraph-';

describe('workspace structure integrity', () => {
  it('ensures every packages/* directory is a valid workspace package', () => {
    const packageDirs = fs.readdirSync(PACKAGES_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    expect(packageDirs.length).toBeGreaterThan(0);

    for (const dirName of packageDirs) {
      const packageRoot = path.join(PACKAGES_ROOT, dirName);
      const packageJsonPath = path.join(packageRoot, 'package.json');
      const tsconfigPath = path.join(packageRoot, 'tsconfig.json');

      expect(
        fs.existsSync(packageJsonPath),
        `Missing package.json in packages/${dirName}`,
      ).toBe(true);
      expect(
        fs.existsSync(tsconfigPath),
        `Missing tsconfig.json in packages/${dirName}`,
      ).toBe(true);

      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
        name?: string;
        scripts?: Record<string, string>;
      };
      const packageName = String(packageJson.name ?? '');
      expect(
        packageName.startsWith(PACKAGE_NAME_PREFIX),
        `Unexpected package name for packages/${dirName}: ${packageName}`,
      ).toBe(true);
      expect(
        packageJson.scripts?.typecheck,
        `Missing typecheck script in packages/${dirName}`,
      ).toBeDefined();
      expect(
        packageJson.scripts?.typecheck?.includes('tsc --noEmit'),
        `Typecheck script must run tsc --noEmit in packages/${dirName}`,
      ).toBe(true);
    }
  });
});
