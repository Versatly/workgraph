import path from 'node:path';
import { Command } from 'commander';
import * as workgraph from '@versatly/workgraph-kernel';
import {
  addWorkspaceOption,
  csv,
  normalizePrimitivePath,
  parseSetPairs,
  resolveWorkspacePath,
  runCommand,
} from '../core.js';

function mergeSetPairs(values: string[]): Record<string, unknown> {
  return values.reduce<Record<string, unknown>>((acc, entry) => {
    Object.assign(acc, parseSetPairs([entry]));
    return acc;
  }, {});
}

function collectSetPairs(value: string, existing: string[]): string[] {
  existing.push(value);
  return existing;
}

function serializePersonInput(
  name: string,
  opts: Record<string, unknown> & {
    preferredName?: string;
    email?: string;
    phone?: string;
    phoneSecondary?: string;
    role?: string;
    jobTitle?: string;
    organization?: string;
    relationshipContext?: string;
    location?: string;
    timezone?: string;
    communicationPreference?: string;
    slackHandle?: string;
    whatsappHandle?: string;
    telegramHandle?: string;
    website?: string;
    socialLinks?: string;
    address?: string;
    notes?: string;
    client?: string;
    projects?: string;
    tags?: string;
    set?: string[];
  },
) {
  return {
    name,
    ...(opts.preferredName ? { preferred_name: opts.preferredName } : {}),
    ...(opts.email ? { email: opts.email } : {}),
    ...(opts.phone ? { phone: opts.phone } : {}),
    ...(opts.phoneSecondary ? { phone_secondary: opts.phoneSecondary } : {}),
    ...(opts.role ? { role: opts.role } : {}),
    ...(opts.jobTitle ? { job_title: opts.jobTitle } : {}),
    ...(opts.organization ? { organization: opts.organization } : {}),
    ...(opts.relationshipContext ? { relationship_context: opts.relationshipContext } : {}),
    ...(opts.location ? { location: opts.location } : {}),
    ...(opts.timezone ? { timezone: opts.timezone } : {}),
    ...(opts.communicationPreference ? { communication_preference: opts.communicationPreference } : {}),
    ...(opts.slackHandle ? { slack_handle: opts.slackHandle } : {}),
    ...(opts.whatsappHandle ? { whatsapp_handle: opts.whatsappHandle } : {}),
    ...(opts.telegramHandle ? { telegram_handle: opts.telegramHandle } : {}),
    ...(opts.website ? { website: opts.website } : {}),
    ...(opts.socialLinks ? { social_links: csv(opts.socialLinks) } : {}),
    ...(opts.address ? { address: opts.address } : {}),
    ...(opts.notes ? { notes: opts.notes } : {}),
    ...(opts.client ? { client: opts.client } : {}),
    ...(opts.projects ? { project_refs: csv(opts.projects) } : {}),
    ...(opts.tags ? { tags: csv(opts.tags) } : {}),
    ...mergeSetPairs(opts.set ?? []),
  };
}

export function registerPeopleCommands(program: Command, defaultActor: string): void {
  const peopleCmd = program
    .command('person')
    .description('Manage native person primitive instances');

  addWorkspaceOption(
    peopleCmd
      .command('list')
      .description('List person primitive instances')
      .option('--tag <tag>', 'Filter by tag')
      .option('--text <text>', 'Filter by text')
      .option('--json', 'Emit structured JSON output'),
  ).action((opts) =>
    runCommand(
      opts,
      () => {
        const people = workgraph.query.queryPrimitives(resolveWorkspacePath(opts), {
          type: 'person',
          tag: opts.tag,
          text: opts.text,
        });
        return { people, count: people.length };
      },
      (result) => result.people.length > 0
        ? [
            ...result.people.map((entry) =>
              `${String(entry.fields.name)}${entry.fields.email ? ` <${String(entry.fields.email)}>` : ''} -> ${entry.path}`),
            `${result.count} person(s)`,
          ]
        : ['No people found.'],
    ),
  );

  addWorkspaceOption(
    peopleCmd
      .command('show <personPath>')
      .description('Show one person primitive')
      .option('--json', 'Emit structured JSON output'),
  ).action((personPath, opts) =>
    runCommand(
      opts,
      () => {
        const person = workgraph.store.read(resolveWorkspacePath(opts), normalizePrimitivePath(personPath));
        if (!person || person.type !== 'person') {
          throw new Error(`Person not found: ${personPath}`);
        }
        return { person };
      },
      (result) => [
        `Person: ${String(result.person.fields.name)}`,
        `Path: ${result.person.path}`,
        `Email: ${String(result.person.fields.email ?? 'none')}`,
        `Organization: ${String(result.person.fields.organization ?? 'none')}`,
      ],
    ),
  );

  addWorkspaceOption(
    peopleCmd
      .command('create <name>')
      .description('Create a native person primitive instance')
      .option('-a, --actor <actor>', 'Actor', defaultActor)
      .option('--body <markdown>', 'Markdown body')
      .option('--preferred-name <text>', 'Preferred name')
      .option('--email <text>', 'Primary email')
      .option('--phone <text>', 'Primary phone')
      .option('--phone-secondary <text>', 'Secondary phone')
      .option('--role <text>', 'Relationship or operating role')
      .option('--job-title <text>', 'Professional title')
      .option('--organization <text>', 'Organization name')
      .option('--relationship-context <text>', 'Relationship context')
      .option('--location <text>', 'Location')
      .option('--timezone <text>', 'Timezone')
      .option('--communication-preference <value>', 'email|phone|slack|whatsapp|telegram')
      .option('--slack-handle <text>', 'Slack handle')
      .option('--whatsapp-handle <text>', 'WhatsApp handle')
      .option('--telegram-handle <text>', 'Telegram handle')
      .option('--website <url>', 'Website URL')
      .option('--social-links <links>', 'Comma-separated social profile URLs')
      .option('--address <text>', 'Postal address')
      .option('--notes <text>', 'Short notes field')
      .option('--client <ref>', 'Primary client ref')
      .option('--projects <refs>', 'Comma-separated project refs')
      .option('--tags <tags>', 'Comma-separated tags')
      .option('--set <key=value>', 'Repeatable field assignment', collectSetPairs, [])
      .option('--json', 'Emit structured JSON output'),
  ).action((name, opts) =>
    runCommand(
      opts,
      () => workgraph.store.create(
        resolveWorkspacePath(opts),
        'person',
        serializePersonInput(name, opts),
        opts.body ?? '',
        opts.actor,
      ),
      (result) => [`Created person: ${result.path}`],
    ),
  );

  addWorkspaceOption(
    peopleCmd
      .command('update <personPath>')
      .description('Update a native person primitive instance')
      .option('-a, --actor <actor>', 'Actor', defaultActor)
      .option('--body <markdown>', 'Replace markdown body')
      .option('--preferred-name <text>', 'Preferred name')
      .option('--email <text>', 'Primary email')
      .option('--phone <text>', 'Primary phone')
      .option('--phone-secondary <text>', 'Secondary phone')
      .option('--role <text>', 'Relationship or operating role')
      .option('--job-title <text>', 'Professional title')
      .option('--organization <text>', 'Organization name')
      .option('--relationship-context <text>', 'Relationship context')
      .option('--location <text>', 'Location')
      .option('--timezone <text>', 'Timezone')
      .option('--communication-preference <value>', 'email|phone|slack|whatsapp|telegram')
      .option('--slack-handle <text>', 'Slack handle')
      .option('--whatsapp-handle <text>', 'WhatsApp handle')
      .option('--telegram-handle <text>', 'Telegram handle')
      .option('--website <url>', 'Website URL')
      .option('--social-links <links>', 'Comma-separated social profile URLs')
      .option('--address <text>', 'Postal address')
      .option('--notes <text>', 'Short notes field')
      .option('--client <ref>', 'Primary client ref')
      .option('--projects <refs>', 'Comma-separated project refs')
      .option('--tags <tags>', 'Comma-separated tags')
      .option('--etag <etag>', 'Expected etag for optimistic concurrency')
      .option('--set <key=value>', 'Repeatable field assignment', collectSetPairs, [])
      .option('--json', 'Emit structured JSON output'),
  ).action((personPath, opts) =>
    runCommand(
      opts,
      () => {
        const workspacePath = resolveWorkspacePath(opts);
        const normalizedPath = normalizePrimitivePath(personPath);
        const existing = workgraph.store.read(workspacePath, normalizedPath);
        if (!existing || existing.type !== 'person') {
          throw new Error(`Person not found: ${personPath}`);
        }
        return workgraph.store.update(
          workspacePath,
          normalizedPath,
          serializePersonInput(String(existing.fields.name ?? ''), opts),
          opts.body,
          opts.actor,
          {
            expectedEtag: opts.etag,
          },
        );
      },
      (result) => [`Updated person: ${result.path}`],
    ),
  );

  addWorkspaceOption(
    peopleCmd
      .command('archive <personPath>')
      .description('Archive a native person primitive instance')
      .option('-a, --actor <actor>', 'Actor', defaultActor)
      .option('--json', 'Emit structured JSON output'),
  ).action((personPath, opts) =>
    runCommand(
      opts,
      () => {
        const normalized = normalizePrimitivePath(personPath);
        const person = workgraph.store.read(resolveWorkspacePath(opts), normalized);
        if (!person || person.type !== 'person') {
          throw new Error(`Person not found: ${personPath}`);
        }
        workgraph.store.remove(resolveWorkspacePath(opts), normalized, opts.actor);
        return {
          archived: {
            path: normalized,
            archivePath: `.workgraph/archive/${path.basename(normalized)}`,
          },
        };
      },
      (result) => [`Archived person: ${result.archived.path}`],
    ),
  );
}
