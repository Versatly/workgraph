import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-cli-person-'));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('CLI person commands', () => {
  it('supports native person CRUD and primitive-type discovery through the built CLI', async () => {
    await runCli('init', workspacePath, '--no-readme', '--no-bases', '--json');

    const types = await runCli('primitive-type', 'list', '-w', workspacePath, '--json');
    expect(types.data.types.some((entry: { name: string; retained: boolean }) => entry.name === 'person' && entry.retained)).toBe(true);

    const created = await runCli(
      'person', 'create', 'Ada Lovelace',
      '-w', workspacePath,
      '--email', 'ada@example.com',
      '--job-title', 'Technical advisor',
      '--organization', 'Analytical Engine Society',
      '--tags', 'vip,advisor',
      '--body', 'Primary stakeholder profile.',
      '--json',
    );
    expect(created.data.path).toBe('people/ada-lovelace.md');
    expect(created.data.fields.email).toBe('ada@example.com');
    expect(created.data.fields.job_title).toBe('Technical advisor');

    const listed = await runCli('person', 'list', '-w', workspacePath, '--json');
    expect(listed.data.count).toBe(1);
    expect(listed.data.people[0].path).toBe('people/ada-lovelace.md');

    const shown = await runCli('primitive', 'show', 'people/ada-lovelace.md', '-w', workspacePath, '--json');
    expect(shown.data.type).toBe('person');
    expect(shown.data.fields.organization).toBe('Analytical Engine Society');

    const updated = await runCli(
      'person', 'update', 'people/ada-lovelace.md',
      '-w', workspacePath,
      '--timezone', 'Europe/London',
      '--slack-handle', '@ada',
      '--json',
    );
    expect(updated.data.fields.timezone).toBe('Europe/London');
    expect(updated.data.fields.slack_handle).toBe('@ada');

    const archived = await runCli('person', 'archive', 'people/ada-lovelace.md', '-w', workspacePath, '--json');
    expect(archived.data.archived.path).toBe('people/ada-lovelace.md');
    expect(fs.existsSync(path.join(workspacePath, 'people/ada-lovelace.md'))).toBe(false);
    expect(fs.existsSync(path.join(workspacePath, '.workgraph/archive/ada-lovelace.md'))).toBe(true);
  });
});

async function runCli(...args: string[]) {
  const { stdout } = await execFileAsync('node', [path.join('/workspace', 'dist/cli.js'), ...args], {
    cwd: '/workspace',
    env: {
      ...process.env,
      WORKGRAPH_JSON: '1',
    },
  });
  return JSON.parse(stdout) as {
    ok: boolean;
    data: any;
  };
}
