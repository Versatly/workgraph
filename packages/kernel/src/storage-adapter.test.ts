import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalStorageAdapter } from './storage-adapter.js';

let tempRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-storage-adapter-'));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('LocalStorageAdapter', () => {
  it('resolves relative paths against an optional rootPath', () => {
    const adapter = new LocalStorageAdapter({ rootPath: tempRoot });
    const resolved = adapter.resolve('nested/file.txt');

    expect(resolved).toBe(path.join(tempRoot, 'nested/file.txt'));
  });

  it('supports mkdir/write/read/stat/exists operations', () => {
    const adapter = new LocalStorageAdapter({ rootPath: tempRoot });
    adapter.mkdir('docs', { recursive: true });
    adapter.writeFile('docs/readme.md', '# Storage Adapter\n');

    expect(adapter.exists('docs/readme.md')).toBe(true);
    expect(adapter.readFile('docs/readme.md')).toContain('Storage Adapter');
    expect(adapter.stat('docs').isDirectory()).toBe(true);
    expect(adapter.stat('docs/readme.md').isFile()).toBe(true);
    expect(adapter.readdir('docs')).toContain('readme.md');
  });

  it('supports cp and rm operations', () => {
    const adapter = new LocalStorageAdapter({ rootPath: tempRoot });
    adapter.mkdir('source', { recursive: true });
    adapter.writeFile('source/file.md', 'content\n');
    adapter.cp('source', 'target', { recursive: true });

    expect(adapter.exists('target/file.md')).toBe(true);
    adapter.rm('target', { recursive: true, force: true });
    expect(adapter.exists('target')).toBe(false);
  });
});
