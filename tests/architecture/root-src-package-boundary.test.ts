import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT_SRC_DIR = resolve(process.cwd(), 'src');

describe('package-first boundaries', () => {
  it('removes root src entirely for package-first layout', () => {
    expect(
      existsSync(ROOT_SRC_DIR),
      'Root src/ should not exist. Add or update package-local entrypoints/tests instead.',
    ).toBe(false);
  });
});
