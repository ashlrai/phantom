import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdRelease } from '../src/cli/release.js';
import { buildReleaseNotes, collectReleaseNotes, formatReleaseNotesMarkdown, type NoteCommit } from '../src/core/release/notes.js';
import { createAppUpdateApi, VERSE_APP_WHATS_NEW_PATH, whatsNew } from '../src/core/verse/app-update-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

let id = 0;
const change = (subject: string, ...files: string[]): NoteCommit => ({ sha: (++id).toString(16).padStart(40, '0'), author: 'Developer', subject, files });
const notesOf = (...commits: NoteCommit[]) => buildReleaseNotes('v1.0.0', 'head', commits);
const heading = (notes: ReturnType<typeof notesOf>, name: string) => notes.sections.find(section => section.heading === name);
afterEach(() => vi.restoreAllMocks());

describe('plain release notes', () => {
  it('groups by path and title under the plain headings, in reading order', () => {
    const notes = notesOf(
      change('feat: add goals view (#1)', 'src/web-ui/routes/goals/GoalsView.tsx'),
      change('feat: add phone ask box (#2)', 'src/web-ui/routes/phone/Ask.tsx'),
      change('perf: speed up the fleet board (#3)', 'src/core/fleet/board.ts'),
      change('fix: restore saved searches (#4)', 'src/core/search.ts'),
      change('docs: explain release notes (#5)', 'docs/RELEASING.md'),
    );
    expect(notes.sections.map(section => section.heading)).toEqual(['New in the app', 'Phone', 'Fleet and speed', 'Fixes', 'Docs']);
    expect(heading(notes, 'Phone')?.lines).toEqual([{ text: 'Add phone ask box.', count: 1, prs: [2] }]);
    expect(heading(notes, 'Fleet and speed')?.lines[0]).toMatchObject({ text: 'Speed up the fleet board.', prs: [3] });
  });

  it('merges near-identical titles into one line with a count', () => {
    const notes = notesOf(
      change('feat: add goals card 2 (#1)', 'src/web-ui/a.tsx'),
      change('feat: Add goals card 3 (#2)', 'src/web-ui/b.tsx'),
      change('feat: add goals card (#3)', 'src/web-ui/c.tsx'),
    );
    expect(heading(notes, 'New in the app')?.lines).toEqual([{ text: 'Add goals card.', count: 3, prs: [1, 2, 3] }]);
    expect(formatReleaseNotesMarkdown(notes)).toContain('(3 changes)');
  });

  it('shows test-only, recovery and re-publish changes as one count line, and keeps PR numbers out of the text', () => {
    const notes = notesOf(
      change('test: cover search (#1)', 'test/search.test.ts'),
      change('test: cover goals (#2)', 'test/goals.test.ts'),
      change('bridge(RQ-A): recut: add goals view (#3)', 'src/web-ui/goals.tsx'),
      change('bridge: recover the lost handoff (#4)', 'src/core/x.ts'),
    );
    expect(notes.sections).toEqual([{ heading: 'Under the hood', lines: [{ text: 'Tests, recoveries and other internal work.', count: 4, prs: [1, 2, 3, 4] }] }]);
    expect(JSON.stringify(notes.sections.flatMap(section => section.lines.map(line => line.text)))).not.toMatch(/#\d|RQ-/);
    expect(notes.headline).toEqual(['Only behind-the-scenes work since v1.0.0.']);
  });

  it('reports an empty range as nothing new', () => {
    const notes = notesOf();
    expect(notes.sections).toEqual([]);
    expect(notes.headline).toEqual(['Nothing new since v1.0.0.']);
  });

  it('puts a change that matches no rule under "Under the hood" instead of dropping it', () => {
    const notes = notesOf(change('rename helper (#9)', 'src/core/helper.ts'));
    expect(heading(notes, 'Under the hood')?.lines).toMatchObject([{ count: 1, prs: [9] }]);
  });

  it('names at most three user-facing changes, biggest first', () => {
    const notes = notesOf(
      change('feat: add alpha (#1)', 'src/web-ui/a.tsx'),
      change('feat: add beta page (#2)', 'src/web-ui/b.tsx'), change('feat: add beta page (#3)', 'src/web-ui/b.tsx'),
      change('fix: repair gamma (#4)', 'src/core/g.ts'), change('feat: add delta (#5)', 'src/web-ui/d.tsx'),
    );
    expect(notes.headline).toHaveLength(3);
    expect(notes.headline[0]).toBe('Add beta page.');
  });

  it('keeps more than 200 changes under 60 output lines', () => {
    const many = Array.from({ length: 250 }, (_, index) => change(`feat: add thing${String.fromCharCode(97 + (index % 26))}${String.fromCharCode(97 + Math.floor(index / 26))} (#${index + 1})`, 'src/web-ui/x.tsx'));
    const notes = notesOf(...many, ...Array.from({ length: 30 }, (_, index) => change(`fix: repair part${String.fromCharCode(97 + (index % 26))} item (#${300 + index})`, 'src/core/y.ts')));
    expect(formatReleaseNotesMarkdown(notes).trimEnd().split('\n').length).toBeLessThan(60);
    expect(heading(notes, 'New in the app')?.lines.at(-1)?.text).toMatch(/^And \d+ more changes\.$/);
    expect(notes.sections.flatMap(section => section.lines).reduce((sum, line) => sum + line.count, 0)).toBe(280);
  });

  it('writes plain Markdown', () => {
    const notes = notesOf(
      change('feat: add goals view (#1)', 'src/web-ui/goals.tsx'),
      change('fix: repair saved searches (#2)', 'src/core/search.ts'),
      change('fix: repair stuck downloads (#3)', 'src/core/search.ts'),
      change('test: cover goals (#4)', 'test/goals.test.ts'),
    );
    expect(formatReleaseNotesMarkdown(notes)).toMatchInlineSnapshot(`
      "# What's new since v1.0.0

      Add goals view. Repair saved searches. Repair stuck downloads.

      ## New in the app

      - Add goals view.

      ## Fixes

      - Repair saved searches.
      - Repair stuck downloads.

      ## Under the hood

      - Tests, recoveries and other internal work.
      "
    `);
  });
});

describe('phm release notes', () => {
  const run = async (args: string[]) => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await cmdRelease(['notes', ...args]);
    return { code, out: out.join('') };
  };
  it('--json has the reader fields next to the developer groups', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plain-notes-cli-'));
    const here = process.cwd();
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@example.test', ...args], { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    try {
      git('init', '-q'); git('commit', '-q', '--allow-empty', '-m', 'first'); git('tag', 'v1.0.0');
      git('commit', '-q', '--allow-empty', '-m', 'feat: add goals view (#1)');
      process.chdir(dir);
      const { code, out } = await run(['--since', 'v1.0.0', '--json']);
      expect(code).toBe(0);
      const json = JSON.parse(out) as Record<string, unknown>;
      expect(Object.keys(json).sort()).toEqual(['groups', 'head', 'headline', 'schema', 'sections', 'since', 'summary']);
      expect(json).toMatchObject({ schema: 'phantom.release-notes.v1', since: 'v1.0.0', headline: ['Add goals view.'] });
      expect(json['sections']).toEqual([{ heading: 'New in the app', lines: [{ text: 'Add goals view.', count: 1, prs: [1] }] }]);
      const markdown = await run(['--since', 'v1.0.0', '--markdown']);
      expect(markdown.out).toContain("# What's new since v1.0.0");
    } finally { process.chdir(here); rmSync(dir, { recursive: true, force: true }); }
  });
  it('reports a missing tag as JSON with exit 1', async () => {
    const { code, out } = await run(['--since', 'v0.0.0-missing', '--json']);
    expect(code).toBe(1);
    expect(JSON.parse(out)).toEqual({ ok: false, reason: expect.any(String) });
  });
  it('rejects --json together with --markdown', async () => {
    const { code } = await run(['--json', '--markdown']);
    expect(code).toBe(2);
  });
  it('reads a date as --since without a tag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plain-notes-'));
    const git = (when: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    try {
      git('2020-01-01T00:00:00Z', 'init', '-q');
      git('2020-01-01T00:00:00Z', '-c', 'user.name=a', '-c', 'user.email=a@example.test', 'commit', '-q', '--allow-empty', '-m', 'feat: add old thing (#1)');
      git('2026-06-01T00:00:00Z', '-c', 'user.name=a', '-c', 'user.email=a@example.test', 'commit', '-q', '--allow-empty', '-m', 'feat: add new thing (#2)');
      const notes = collectReleaseNotes(dir, '2026-01-01');
      expect(notes.since).toBe('2026-01-01');
      expect(notes.sections.flatMap(section => section.lines).map(line => line.prs)).toEqual([[2]]);
      expect(() => collectReleaseNotes(dir, '2026-13-45')).toThrow('Invalid date');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('GET /api/verse/app/whats-new', () => {
  const call = async (api: ReturnType<typeof createAppUpdateApi>, method = 'GET') => {
    const req = Readable.from([]) as unknown as IncomingMessage;
    let status = 0; let body: unknown = null;
    const res = { headersSent: false, writeHead(code: number) { status = code; }, end(text: string) { body = JSON.parse(text); } } as unknown as ServerResponse;
    const handled = await api({ allowDispatch: false } as unknown as VerseApiContext, req, res, VERSE_APP_WHATS_NEW_PATH, method);
    return { handled, status, body };
  };
  it('returns the notes since the installed version tag', async () => {
    const seen: string[] = [];
    const api = createAppUpdateApi({ readInstalled: () => '3.30.1', readNotes: (since) => { seen.push(since); return notesOf(change('feat: add goals view (#1)', 'src/web-ui/g.tsx')); } });
    const { status, body } = await call(api);
    expect(status).toBe(200);
    expect(seen).toEqual(['v3.30.1']);
    expect(body).toMatchObject({ v: 1, installed: '3.30.1', reason: null, headline: ['Add goals view.'] });
  });
  it('shows unknown as unknown', () => {
    expect(whatsNew(() => null, () => notesOf())).toMatchObject({ installed: null, reason: 'installed-version-unknown', sections: [] });
    expect(whatsNew(() => '3.30.1', () => { throw new Error('no tag'); })).toMatchObject({ installed: '3.30.1', reason: 'history-unavailable', sections: [] });
  });
  it('allows only GET', async () => {
    expect((await call(createAppUpdateApi({}), 'POST')).status).toBe(405);
  });
});
