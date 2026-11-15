import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));

import type { EcosystemChangelog, EcosystemChange } from '../src/core/ecosystem/changelog.js';
import {
  ECOSYSTEM_CHANGELOG_JSON_PATH,
  ECOSYSTEM_CHANGELOG_MARKDOWN_PATH,
  parseEcosystemChangelogSince,
  renderEcosystemChangelogDocument,
  renderEcosystemChangelogJson,
  renderEcosystemChangelogMarkdown,
} from '../src/core/ecosystem/changelog-document.js';
import { cmdEcosystem } from '../src/cli/ecosystem.js';

const AS_OF = '2026-10-28T12:00:00.000Z';
const SINCE_7D = '2026-10-21T12:00:00.000Z';
const RECENT_SINCE = '2026-10-14T12:00:00.000Z';

function change(overrides: Partial<EcosystemChange> & Pick<EcosystemChange, 'repository' | 'source'>): EcosystemChange {
  const { repository, source, ...rest } = overrides;
  const key = overrides.number !== undefined ? String(overrides.number) : (overrides.version ?? 'entry');
  return {
    id: `${repository}:${source}:${key}`,
    repository,
    source,
    title: 'Change title',
    body: 'Change body',
    date: '2026-10-25T12:00:00.000Z',
    url: 'https://github.com/fixture/repo/pull/1',
    crossRepo: false,
    relatedPullRequests: [],
    ...rest,
  };
}

function report(): EcosystemChangelog {
  const complete = { status: 'complete' } as const;
  return {
    schemaVersion: 1,
    complete: false,
    repositories: [
      {
        repository: 'fixture/zeta', directory: 'zeta', tier: 'core-fleet',
        sources: [{ source: 'changelog', ...complete }, { source: 'release', ...complete }, { source: 'pull-request', ...complete }],
        changes: [
          change({ repository: 'fixture/zeta', source: 'pull-request', number: 7, title: 'Ships the renderer', date: '2026-10-25T12:00:00.000Z', url: 'https://github.com/fixture/zeta/pull/7', crossRepo: true, relatedPullRequests: ['fixture/middle#3'] }),
          change({ repository: 'fixture/zeta', source: 'changelog', version: '1.1.0', title: '[1.1.0] - 2026-10-20', date: '2026-10-20T00:00:00.000Z', url: 'https://github.com/fixture/zeta/blob/HEAD/CHANGELOG.md' }),
          change({ repository: 'fixture/zeta', source: 'changelog', version: 'Unreleased', title: '[Unreleased]', date: null, unreleased: true, url: 'https://github.com/fixture/zeta/blob/HEAD/CHANGELOG.md' }),
          change({ repository: 'fixture/zeta', source: 'release', version: 'v1.2.0', title: 'v1.2.0', date: '2026-10-10T12:00:00.000Z', url: 'https://github.com/fixture/zeta/releases/tag/v1.2.0', prerelease: false }),
        ],
      },
      {
        repository: 'fixture/middle', directory: 'middle', tier: 'force-multiplier',
        sources: [{ source: 'changelog', ...complete }, { source: 'release', ...complete }, { source: 'pull-request', ...complete }],
        changes: [
          change({ repository: 'fixture/middle', source: 'pull-request', number: 3, title: 'Companion change', date: '2026-10-22T12:00:00.000Z', url: 'https://github.com/fixture/middle/pull/3', crossRepo: true, relatedPullRequests: ['fixture/zeta#7'] }),
          change({ repository: 'fixture/middle', source: 'changelog', version: '0.9.0', title: '[0.9.0] - 2026-10-01', date: '2026-10-01T00:00:00.000Z', url: 'https://github.com/fixture/middle/blob/HEAD/CHANGELOG.md' }),
        ],
      },
      {
        repository: 'fixture/alpha', directory: 'alpha', tier: 'supporting',
        sources: [
          { source: 'changelog', status: 'missing' },
          { source: 'release', status: 'truncated', reason: 'page-limit' },
          { source: 'pull-request', status: 'error', reason: 'unavailable' },
        ],
        changes: [],
      },
    ],
  };
}

const schema = JSON.parse(
  readFileSync(new URL('../schemas/ecosystem-changelog.v1.schema.json', import.meta.url), 'utf8'),
) as object;
const validate = new AjvJsonSchemaValidator().getValidator(schema);

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ecosystem-changelog-document-'));
  mocks.execFile.mockReset();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('parseEcosystemChangelogSince', () => {
  it('resolves day and hour windows against the as-of anchor', () => {
    expect(parseEcosystemChangelogSince('7d', AS_OF)).toBe(SINCE_7D);
    expect(parseEcosystemChangelogSince('14d', AS_OF)).toBe(RECENT_SINCE);
    expect(parseEcosystemChangelogSince('24h', AS_OF)).toBe('2026-10-27T12:00:00.000Z');
    expect(parseEcosystemChangelogSince('1d', AS_OF)).toBe('2026-10-27T12:00:00.000Z');
  });

  it('accepts ISO dates and datetimes and returns null when unset', () => {
    expect(parseEcosystemChangelogSince('2026-10-21', AS_OF)).toBe('2026-10-21T00:00:00.000Z');
    expect(parseEcosystemChangelogSince('2026-10-21T08:30:00Z', AS_OF)).toBe('2026-10-21T08:30:00.000Z');
    expect(parseEcosystemChangelogSince(undefined, AS_OF)).toBeNull();
  });

  it.each(['7w', 'soon', '2026-02-30', '0d', '-3d', '2026-10-21T08:30:00'])('rejects %s', (value) => {
    expect(() => parseEcosystemChangelogSince(value, AS_OF)).toThrow('Invalid');
  });

  it('rejects an invalid as-of anchor even without a since value', () => {
    expect(() => parseEcosystemChangelogSince(undefined, 'yesterday')).toThrow('Invalid --as-of timestamp');
  });
});

describe('renderEcosystemChangelogDocument', () => {
  it('derives totals, the fixed 14-day summary and an unfiltered window', () => {
    const document = renderEcosystemChangelogDocument(report(), { asOf: AS_OF });
    expect(document).toMatchObject({
      schema: 'ecosystem-changelog.v1',
      generatedAt: AS_OF,
      complete: false,
      window: { since: null },
      totals: { repositories: 3, changes: 6, changelog: 3, releases: 1, pullRequests: 2, crossRepo: 2 },
      recent14d: {
        days: 14, since: RECENT_SINCE, changes: 3, changelogEntries: 1,
        releases: 0, pullRequests: 2, crossRepo: 2, repositories: 2,
      },
    });
  });

  it('filters dated changes inclusively and always keeps undated entries', () => {
    const document = renderEcosystemChangelogDocument(report(), { asOf: AS_OF, since: SINCE_7D });
    const ids = document.repositories.flatMap((repo) => repo.changes.map((entry) => entry.id));
    expect(ids).toEqual([
      'fixture/zeta:pull-request:7',
      'fixture/zeta:changelog:Unreleased',
      'fixture/middle:pull-request:3',
    ]);
    expect(document.window.since).toBe(SINCE_7D);
    expect(document.totals.changes).toBe(3);
    // The 14-day summary aggregates the emitted document, so every number it
    // reports is derivable from the changes the document contains.
    expect(document.recent14d).toMatchObject({
      changes: 2, pullRequests: 2, changelogEntries: 0, releases: 0, crossRepo: 2, repositories: 2,
    });
  });

  it('treats the since boundary as inclusive at instant precision', () => {
    const document = renderEcosystemChangelogDocument(report(), { asOf: AS_OF, since: '2026-10-25T12:00:00.000Z' });
    const zeta = document.repositories[0].changes.map((entry) => entry.id);
    expect(zeta).toEqual(['fixture/zeta:pull-request:7', 'fixture/zeta:changelog:Unreleased']);
  });

  it('produces byte-identical documents for identical inputs', () => {
    const first = renderEcosystemChangelogJson(renderEcosystemChangelogDocument(report(), { asOf: AS_OF }));
    const second = renderEcosystemChangelogJson(renderEcosystemChangelogDocument(report(), { asOf: AS_OF }));
    expect(second).toBe(first);
  });

  it('matches the golden JSON document snapshot', () => {
    const document = renderEcosystemChangelogJson(renderEcosystemChangelogDocument(report(), { asOf: AS_OF }));
    expect(document).toMatchSnapshot();
  });

  it('matches the golden windowed JSON document snapshot', () => {
    const document = renderEcosystemChangelogJson(renderEcosystemChangelogDocument(report(), { asOf: AS_OF, since: SINCE_7D }));
    expect(document).toMatchSnapshot();
  });
});

describe('renderEcosystemChangelogMarkdown', () => {
  it('matches the golden llms-style markdown snapshot', () => {
    const markdown = renderEcosystemChangelogMarkdown(renderEcosystemChangelogDocument(report(), { asOf: AS_OF }));
    expect(markdown).toMatchSnapshot();
  });

  it('matches the golden windowed markdown snapshot', () => {
    const markdown = renderEcosystemChangelogMarkdown(renderEcosystemChangelogDocument(report(), { asOf: AS_OF, since: SINCE_7D }));
    expect(markdown).toMatchSnapshot();
  });

  it('contains the 14-day summary, pending notes and coverage line without em dashes', () => {
    const markdown = renderEcosystemChangelogMarkdown(renderEcosystemChangelogDocument(report(), { asOf: AS_OF }));
    expect(markdown).toContain('## Last 14 days');
    expect(markdown).toContain(`Activity since ${RECENT_SINCE}: 3 changes across 2 repositories`);
    expect(markdown).toContain('## Pending release notes');
    expect(markdown).toContain('Coverage incomplete: fixture/alpha changelog missing');
    expect(markdown).toContain('[#7 Ships the renderer](https://github.com/fixture/zeta/pull/7): pull-request; 2026-10-25; cross-repo fixture/middle#3');
    expect(markdown).not.toMatch(/[\u2013\u2014]/);
    expect(renderEcosystemChangelogJson(renderEcosystemChangelogDocument(report(), { asOf: AS_OF }))).not.toContain('\u2014');
  });
});

describe('ecosystem-changelog.v1 schema conformance', () => {
  it('validates a rendered document against the registered schema', () => {
    const document = renderEcosystemChangelogDocument(report(), { asOf: AS_OF, since: SINCE_7D });
    const result = validate(JSON.parse(renderEcosystemChangelogJson(document)));
    expect(result.valid, result.errorMessage).toBe(true);
  });

  it('rejects a document with an unknown field or discriminator', () => {
    const document = JSON.parse(renderEcosystemChangelogJson(renderEcosystemChangelogDocument(report(), { asOf: AS_OF }))) as Record<string, unknown>;
    document['extra'] = true;
    expect(validate(document).valid).toBe(false);
    delete document['extra'];
    document['schema'] = 'ecosystem-changelog.v2';
    expect(validate(document).valid).toBe(false);
  });
});

describe('checked-in artifacts', () => {
  const repoRoot = new URL('../', import.meta.url).pathname;
  it('docs/ecosystem-changelog.json validates against ecosystem-changelog.v1', () => {
    const document = JSON.parse(readFileSync(join(repoRoot, ECOSYSTEM_CHANGELOG_JSON_PATH), 'utf8'));
    const result = validate(document);
    expect(result.valid, result.errorMessage).toBe(true);
    expect(document.schema).toBe('ecosystem-changelog.v1');
    expect(document.repositories.length).toBeGreaterThan(0);
  });

  it('ECOSYSTEM_CHANGELOG.md carries the generated sections and no em dashes', () => {
    const markdown = readFileSync(join(repoRoot, ECOSYSTEM_CHANGELOG_MARKDOWN_PATH), 'utf8');
    expect(markdown).toContain('# Ashlr.AI ecosystem changelog');
    expect(markdown).toContain('## Last 14 days');
    expect(markdown).toContain('## Pending release notes');
    expect(markdown).toContain('## Repositories');
    expect(markdown).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('cmdEcosystem changelog', () => {
  const roster = [
    'phantom', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-md', 'ashlr-stack', 'ashlr-plugin',
  ];

  function answerGh(): void {
    mocks.execFile.mockImplementation((_file: string, args: string[], _opts: unknown, callback: (e: unknown, out: string) => void) => {
      const endpoint = args[args.length - 1];
      const name = /^repos\/(ashlrai\/[a-z0-9-]+)/.exec(endpoint)?.[1];
      if (endpoint.includes('?')) return callback(null, '[]');
      callback(null, JSON.stringify({ private: false, full_name: name }));
    });
  }

  async function captureStdout(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; });
    try {
      const code = await run();
      return { code, stdout: out.join(''), stderr: err.join('') };
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  }

  beforeEach(async () => {
    for (const directory of roster) {
      await mkdir(join(root, directory), { recursive: true });
      await writeFile(join(root, directory, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-24\n\n### Added\n- Useful change.\n');
    }
  });

  it('emits the ecosystem-changelog.v1 document for --since 7d --json', async () => {
    answerGh();
    const { code, stdout } = await captureStdout(() =>
      cmdEcosystem(['changelog', '--root', root, '--since', '7d', '--as-of', AS_OF, '--json']));
    const document = JSON.parse(stdout);
    expect(code).toBe(0);
    expect(document.schema).toBe('ecosystem-changelog.v1');
    expect(document.generatedAt).toBe(AS_OF);
    expect(document.window.since).toBe(SINCE_7D);
    expect(document.complete).toBe(true);
    expect(document.totals.repositories).toBe(7);
    expect(validate(document).valid).toBe(true);
    const apiCalls = mocks.execFile.mock.calls.map((call) => call[1].at(-1));
    expect(apiCalls).toHaveLength(21);
    expect(apiCalls.every((endpoint) => endpoint.startsWith('repos/ashlrai/'))).toBe(true);
  });

  it('prints the markdown render in human mode', async () => {
    answerGh();
    const { code, stdout } = await captureStdout(() =>
      cmdEcosystem(['changelog', '--root', root, '--as-of', AS_OF]));
    expect(code).toBe(0);
    expect(stdout).toContain('# Ashlr.AI ecosystem changelog');
    expect(stdout).toContain('## Last 14 days');
  });

  it('writes both artifacts into the nearest repository root with --write', async () => {
    answerGh();
    const checkout = join(root, 'checkout');
    await mkdir(join(checkout, 'docs'), { recursive: true });
    await writeFile(join(checkout, 'package.json'), '{"name":"fixture"}\n');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(checkout);
    const { code, stdout, stderr } = await captureStdout(() =>
      cmdEcosystem(['changelog', '--root', root, '--as-of', AS_OF, '--write']));
    cwd.mockRestore();
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('wrote');
    const markdown = await readFile(join(checkout, ECOSYSTEM_CHANGELOG_MARKDOWN_PATH), 'utf8');
    const json = JSON.parse(await readFile(join(checkout, ECOSYSTEM_CHANGELOG_JSON_PATH), 'utf8'));
    expect(markdown).toContain('# Ashlr.AI ecosystem changelog');
    expect(json.schema).toBe('ecosystem-changelog.v1');
    expect(existsSync(join(checkout, 'docs'))).toBe(true);
  });

  it.each([
    ['changelog', '--since', 'soon'],
    ['changelog', '--as-of', 'yesterday'],
    ['changelog', '--max-pages', '0'],
    ['changelog', '--deep'],
    ['changelog', '--bogus'],
  ])('rejects invalid usage %j with exit 2', async (...args: string[]) => {
    const { code } = await captureStdout(() => cmdEcosystem(args));
    expect(code).toBe(2);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('returns exit 1 when a source is incomplete but still renders', async () => {
    mocks.execFile.mockImplementation((_file: string, _args: string[], _opts: unknown, callback: (e: unknown, out: string) => void) => {
      callback(new Error('unavailable fixture'), '');
    });
    const { code, stdout } = await captureStdout(() =>
      cmdEcosystem(['changelog', '--root', root, '--as-of', AS_OF, '--json']));
    const document = JSON.parse(stdout);
    expect(code).toBe(1);
    expect(document.complete).toBe(false);
    expect(document.repositories[0].sources[0].status).toBe('error');
  });

  it('prints help for the changelog verb and exits 0', async () => {
    const { code, stdout } = await captureStdout(() => cmdEcosystem(['changelog', '--help']));
    expect(code).toBe(0);
    expect(stdout).toContain('ashlr ecosystem changelog');
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});
