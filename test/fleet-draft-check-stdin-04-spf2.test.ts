import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetDraftCheck } from '../src/cli/fleet-draft-check.js';
import type { JobPrecheckGit } from '../src/core/fleet/job-precheck.js';

const RESOLVED = 'a'.repeat(40);
const bytes = (value: string) => Buffer.from(value, 'utf8');
const stream = (...values: Uint8Array[]) => async function* () { yield* values; };
const input = (drafts: Array<{ name: string; markdown: string }>) => bytes(JSON.stringify({ drafts }));
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function capture() {
  const out: string[] = [];
  const errors: string[] = [];
  return { out, errors, log: (line: string) => out.push(line), error: (line: string) => errors.push(line) };
}

function fakeGit(master: Record<string, string>) {
  return {
    exists: vi.fn(async (path: string) => Object.prototype.hasOwnProperty.call(master, path)),
    lastCommit: vi.fn(async (path: string) => (master[path] ? { sha: 'abc1234', subject: master[path]! } : null)),
  } satisfies JobPrecheckGit;
}

function deps(c: ReturnType<typeof capture>, git: JobPrecheckGit, stdin: Uint8Array) {
  const resolveRef = vi.fn(async () => RESOLVED);
  return { deps: { ...c, git, resolveRef, readStdin: stream(stdin) }, resolveRef };
}

const HEADER = '#job repo=phantom lane=devin tier=work';
const md = (body: string) => `${HEADER}\n${body}`;
const DONE = { 'src/done.ts': 'bridge(RQ-PHX-AAAA1): landed', 'src/shared.ts': 'bridge(RQ-PHX-BBBB2): landed' };
const A = { name: 'RQ-PHX-AAA1.md', markdown: md('Edit src/done.ts and src/shared.ts\n') };
const B = { name: 'RQ-PHX-BBB2.md', markdown: md('Touch src/shared.ts and src/new.ts\n') };

it('pipes a two-draft batch through the batch path over one immutable ref', async () => {
  const git = fakeGit(DONE);
  const c = capture();
  const { deps: d, resolveRef } = deps(c, git, input([A, B]));
  expect(await cmdFleetDraftCheck(['--stdin', '--json'], d)).toBe(3);
  expect(resolveRef).toHaveBeenCalledTimes(1);
  expect(resolveRef).toHaveBeenCalledWith('origin/master');
  // Shared-path caching: src/shared.ts is named by both drafts but probed once.
  expect(git.exists.mock.calls.map(call => call[0])).toEqual(['src/done.ts', 'src/shared.ts', 'src/new.ts']);
  const body = JSON.parse(c.out[0]!) as {
    schema: string; ref: string; resolvedRef: string;
    results: Array<{ file: string; verdict?: string }>;
    counts: Record<string, number>;
    collisions: Array<{ path: string; files: string[] }>;
  };
  expect(body).toMatchObject({ schema: 'fleet.draft-check.v1', ref: 'origin/master', resolvedRef: RESOLVED });
  expect(body.results.map(r => [r.file, r.verdict])).toEqual([[A.name, 'likely-done'], [B.name, 'partly-on-master']]);
  expect(body.counts).toEqual({ fresh: 0, 'partly-on-master': 1, 'likely-done': 1, errors: 0 });
  expect(body.collisions).toEqual([{ path: 'src/shared.ts', files: [A.name, B.name] }]);
});

it('exits 2 when any draft errors even with a likely-done present, 0 when all fresh', async () => {
  const boom: JobPrecheckGit = {
    exists: vi.fn(async (path: string) => {
      if (path === 'src/boom.ts') throw new Error('fatal: bad revision');
      return Object.prototype.hasOwnProperty.call(DONE, path);
    }),
    lastCommit: vi.fn(async (path: string) => (DONE[path] ? { sha: 'abc1234', subject: DONE[path]! } : null)),
  };
  const c = capture();
  const failing = { name: 'RQ-PHX-CCC3.md', markdown: md('src/boom.ts\n') };
  const { deps: d } = deps(c, boom, input([A, failing]));
  expect(await cmdFleetDraftCheck(['--stdin', '--json'], d)).toBe(2);
  const body = JSON.parse(c.out[0]!) as { results: Array<{ verdict?: string; error?: string }>; counts: Record<string, number> };
  expect(body.results.map(r => r.verdict)).toEqual(['likely-done', undefined]);
  expect(body.results[1]!.error).toBe('fatal: bad revision');
  expect(body.counts).toEqual({ fresh: 0, 'partly-on-master': 0, 'likely-done': 1, errors: 1 });
  const c2 = capture();
  const fresh = { name: 'RQ-PHX-DDD4.md', markdown: md('Create src/never.ts\n') };
  expect(await cmdFleetDraftCheck(['--stdin', '--json'], deps(c2, fakeGit({}), input([fresh])).deps)).toBe(0);
  expect((JSON.parse(c2.out[0]!) as { counts: Record<string, number> }).counts).toEqual({ fresh: 1, 'partly-on-master': 0, 'likely-done': 0, errors: 0 });
});

it('rejects malformed, oversize and duplicate-name input before resolving or probing', async () => {
  const git = fakeGit({});
  const resolveRef = vi.fn(async () => RESOLVED);
  const c = capture();
  const run = (stdin: Uint8Array | (() => AsyncIterable<Uint8Array>), args = ['--stdin']) =>
    cmdFleetDraftCheck(args, { ...c, git, resolveRef, readStdin: typeof stdin === 'function' ? stdin : stream(stdin) });
  const draft = (name: string, markdown: unknown, extra?: Record<string, unknown>) => JSON.stringify({ drafts: [{ name, markdown, ...extra }] });
  const twentyOne = JSON.stringify({ drafts: Array.from({ length: 21 }, (_, i) => ({ name: `RQ-PHX-N${i.toString().padStart(4, '0')}.md`, markdown: 'src/x.ts' })) });
  let continued = false;
  async function* oversized() { yield bytes('x'.repeat(180_000)); yield bytes('x'); continued = true; }
  const bad: Array<Uint8Array | (() => AsyncIterable<Uint8Array>)> = [
    bytes(''), bytes('not json'), bytes('[]'), bytes('{"drafts":{}}'), bytes('{"drafts":[]}'),
    bytes(twentyOne), bytes('{"drafts":[],"extra":1}'), bytes(draft('RQ-PHX-AAA1.md', 'src/x.ts', { path: 'y' })),
    bytes('{"drafts":[{"name":"RQ-PHX-AAA1.md"}]}'),
    ...['RQ-PHX-aa.md', 'RQ-PHX-AB.md', 'RQ-PHX-AAA1', 'RQ-OTHER-AAA1.md', 'RQ-PHX-AAA1.md/x', 'AAA1.md']
      .map(name => bytes(draft(name, 'src/x.ts'))),
    bytes(draft('RQ-PHX-AAA1.md', '  ')), bytes(draft('RQ-PHX-AAA1.md', 5)),
    bytes(draft('RQ-PHX-AAA1.md', 'x'.repeat(8001))),
    bytes(JSON.stringify({ drafts: [A, A] })),
    bytes('x'.repeat(180_001)), oversized,
    new Uint8Array([0xff, 0xfe]),
  ];
  for (const stdin of bad) expect(await run(stdin), String(c.errors.at(-1))).toBe(2);
  for (const args of [[], ['--json'], ['--stdin', '--bogus'], ['--stdin', '--ref', 'x'], ['--stdin', 'a.md'], ['--stdin', '--stdin'], ['--json', '--json', '--stdin']]) {
    expect(await run(input([A]), args), JSON.stringify(args)).toBe(2);
  }
  expect(continued).toBe(false);
  expect(resolveRef).not.toHaveBeenCalled();
  expect(git.exists).not.toHaveBeenCalled();
  expect(git.lastCommit).not.toHaveBeenCalled();
  expect(c.out).toEqual([]);
});

it('returns a resolve error instead of fresh when origin/master is missing', async () => {
  const git = fakeGit({});
  const c = capture();
  const resolveRef = vi.fn(async () => { throw new Error('fatal: ambiguous argument'); });
  expect(await cmdFleetDraftCheck(['--stdin', '--json'], { ...c, git, resolveRef, readStdin: stream(input([A])) })).toBe(2);
  expect(c.errors.join(' ')).toContain('cannot resolve ref origin/master');
  expect(c.out).toEqual([]);
  expect(git.exists).not.toHaveBeenCalled();
});

it('summarizes verdicts, collisions and counts in text mode', async () => {
  const c = capture();
  expect(await cmdFleetDraftCheck(['--stdin'], deps(c, fakeGit(DONE), input([A, B])).deps)).toBe(3);
  expect(c.out).toEqual([
    `snapshot: origin/master -> ${RESOLVED}`,
    `== ${A.name}`,
    'src/done.ts on-master abc1234 bridge(RQ-PHX-AAAA1): landed',
    'src/shared.ts on-master abc1234 bridge(RQ-PHX-BBBB2): landed',
    'verdict: likely-done',
    `== ${B.name}`,
    'src/shared.ts on-master abc1234 bridge(RQ-PHX-BBBB2): landed',
    'src/new.ts missing',
    'verdict: partly-on-master',
    `collision: src/shared.ts <- ${A.name}, ${B.name}`,
    'batch: fresh=0 partly-on-master=1 likely-done=1 errors=0',
  ]);
});

it('documents the input shape and read-only nature on --help without touching stdin or git', async () => {
  const git = fakeGit({});
  const readStdin = vi.fn(stream(input([A])));
  const resolveRef = vi.fn(async () => RESOLVED);
  const c = capture();
  expect(await cmdFleetDraftCheck(['--help'], { ...c, git, resolveRef, readStdin })).toBe(0);
  const text = c.out.join('\n');
  for (const fragment of ['{"drafts"', 'RQ-PHX-[A-Z0-9]{3,40}.md', '8000', '180000', 'origin/master', 'Read-only', 'collision']) {
    expect(text, fragment).toContain(fragment);
  }
  expect(readStdin).not.toHaveBeenCalled();
  expect(resolveRef).not.toHaveBeenCalled();
  expect(git.exists).not.toHaveBeenCalled();
});

it('reads no filesystem: the module has no fs import and runs fully on injected deps', async () => {
  const source = readFileSync(resolve('src/cli/fleet-draft-check.ts'), 'utf8');
  expect(source).not.toContain('node:fs');
  expect(source).not.toContain('readFile(');
  const git = fakeGit(DONE);
  const c = capture();
  expect(await cmdFleetDraftCheck(['--stdin', '--json'], deps(c, git, input([A])).deps)).toBe(3);
});

it('checks a piped batch against a real repo over a pinned origin/master', { timeout: 60_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'draft-check-'));
  dirs.push(dir);
  const env = {
    ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'pipe' });
  git(['init']);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/done.ts'), 'done\n');
  git(['add', 'src/done.ts']);
  git(['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'bridge(RQ-PHX-E2ESP2): landed']);
  git(['update-ref', 'refs/remotes/origin/master', 'HEAD']);
  const cli = resolve('src/cli/index.ts');
  const tsx = resolve('node_modules/.bin/tsx');
  const payload = JSON.stringify({
    drafts: [
      { name: 'RQ-PHX-E2EA1.md', markdown: md('Edit src/done.ts and add test/e2e-spf2.test.ts\n') },
      { name: 'RQ-PHX-E2EB2.md', markdown: md('Touch src/done.ts and src/absent-spf2.ts\n') },
    ],
  });
  const result = spawnSync(tsx, [cli, 'fleet', 'draft-check', '--stdin', '--json'], { cwd: dir, env, input: payload, encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(3);
  const head = String(git(['rev-parse', 'origin/master'])).trim();
  const body = JSON.parse(result.stdout) as {
    resolvedRef: string;
    results: Array<{ file: string; verdict: string; newTestFiles: string[] }>;
    counts: Record<string, number>;
    collisions: Array<{ path: string; files: string[] }>;
  };
  expect(body.resolvedRef).toBe(head);
  expect(body.results.map(r => [r.file, r.verdict])).toEqual([
    ['RQ-PHX-E2EA1.md', 'likely-done'], ['RQ-PHX-E2EB2.md', 'partly-on-master'],
  ]);
  expect(body.results[0]!.newTestFiles).toEqual(['test/e2e-spf2.test.ts']);
  expect(body.collisions).toEqual([{ path: 'src/done.ts', files: ['RQ-PHX-E2EA1.md', 'RQ-PHX-E2EB2.md'] }]);
  expect(body.counts).toEqual({ fresh: 0, 'partly-on-master': 1, 'likely-done': 1, errors: 0 });
  // A repo without origin/master reports a resolve error, never fresh.
  const bare = mkdtempSync(join(tmpdir(), 'draft-check-noref-'));
  dirs.push(bare);
  execFileSync('git', ['init'], { cwd: bare, env, stdio: 'pipe' });
  const noRef = spawnSync(tsx, [cli, 'fleet', 'draft-check', '--stdin'], { cwd: bare, env: { ...env, HOME: bare }, input: payload, encoding: 'utf8' });
  expect(noRef.status).toBe(2);
  expect(noRef.stderr).toContain('cannot resolve ref origin/master');
});
