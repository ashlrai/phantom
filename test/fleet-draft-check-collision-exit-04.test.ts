import { expect, it, vi } from 'vitest';
import { cmdFleetDraftCheck } from '../src/cli/fleet-draft-check.js';
import type { JobPrecheckGit } from '../src/core/fleet/job-precheck.js';

const RESOLVED = 'a'.repeat(40);
const bytes = (value: string) => Buffer.from(value, 'utf8');
const stream = (...values: Uint8Array[]) => async function* () { yield* values; };
const input = (drafts: Array<{ name: string; markdown: string }>) => bytes(JSON.stringify({ drafts }));

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
const DONE = {
  'src/done.ts': 'bridge(RQ-PHX-AAAA1): landed',
  'src/shared2.ts': 'bridge(RQ-PHX-BBBB2): landed',
};

// Two fresh drafts sharing one implementation path.
const CLASH_A = { name: 'RQ-PHX-AAA1.md', markdown: md('Edit src/alpha.ts\n') };
const CLASH_B = { name: 'RQ-PHX-BBB2.md', markdown: md('Edit src/alpha.ts and src/beta.ts\n') };
const DISJOINT = { name: 'RQ-PHX-CCC3.md', markdown: md('Create src/gamma.ts\n') };
const TEST_A = { name: 'RQ-PHX-DDD4.md', markdown: md('Add test/alpha.test.ts\n') };
const TEST_B = { name: 'RQ-PHX-EEE5.md', markdown: md('Also add test/alpha.test.ts\n') };
const DONE_A = { name: 'RQ-PHX-FFF6.md', markdown: md('Edit src/done.ts and src/shared2.ts\n') };
const DONE_B = { name: 'RQ-PHX-HHH8.md', markdown: md('Edit src/shared2.ts only\n') };

interface JsonBody {
  schema: string;
  results: Array<{ file: string; verdict?: string; error?: string }>;
  counts: Record<string, number>;
  collisions: Array<{ path: string; files: string[] }>;
}
const body = (c: ReturnType<typeof capture>) => JSON.parse(c.out[0]!) as JsonBody;

it('exits 4 in strict mode when fresh drafts share an implementation path, 0 by default', async () => {
  for (const args of [['--stdin', '--json', '--fail-on-collision'], ['--stdin', '--fail-on-collision', '--json']]) {
    const c = capture();
    expect(await cmdFleetDraftCheck(args, deps(c, fakeGit({}), input([CLASH_A, CLASH_B])).deps)).toBe(4);
    const b = body(c);
    expect(b.schema).toBe('fleet.draft-check.v1');
    expect(b.counts).toEqual({ fresh: 2, 'partly-on-master': 0, 'likely-done': 0, errors: 0 });
    expect(b.collisions).toEqual([{ path: 'src/alpha.ts', files: [CLASH_A.name, CLASH_B.name] }]);
  }
  const c = capture();
  expect(await cmdFleetDraftCheck(['--stdin', '--json'], deps(c, fakeGit({}), input([CLASH_A, CLASH_B])).deps)).toBe(0);
  expect(body(c).collisions).toEqual([{ path: 'src/alpha.ts', files: [CLASH_A.name, CLASH_B.name] }]);
});

it('exits 4 in text mode with the collision line still printed', async () => {
  const c = capture();
  expect(await cmdFleetDraftCheck(['--stdin', '--fail-on-collision'], deps(c, fakeGit({}), input([CLASH_A, CLASH_B])).deps)).toBe(4);
  expect(c.out).toContain(`collision: src/alpha.ts <- ${CLASH_A.name}, ${CLASH_B.name}`);
  expect(c.out.at(-1)).toBe('batch: fresh=2 partly-on-master=0 likely-done=0 errors=0');
});

it('exits 0 for disjoint drafts and ignores shared test paths, strict or not', async () => {
  const c = capture();
  expect(await cmdFleetDraftCheck(['--stdin', '--json', '--fail-on-collision'], deps(c, fakeGit({}), input([CLASH_A, DISJOINT])).deps)).toBe(0);
  expect(body(c).collisions).toEqual([]);
  for (const args of [['--stdin', '--json', '--fail-on-collision'], ['--stdin', '--json']]) {
    const c2 = capture();
    expect(await cmdFleetDraftCheck(args, deps(c2, fakeGit({}), input([TEST_A, TEST_B])).deps)).toBe(0);
    expect(body(c2).collisions).toEqual([]);
  }
});

it('keeps errors (2) and likely-done (3) ahead of the collision exit', async () => {
  const boom: JobPrecheckGit = {
    exists: vi.fn(async (path: string) => {
      if (path === 'src/boom.ts') throw new Error('fatal: bad revision');
      return Object.prototype.hasOwnProperty.call(DONE, path);
    }),
    lastCommit: vi.fn(async (path: string) => (DONE[path] ? { sha: 'abc1234', subject: DONE[path]! } : null)),
  };
  const failing = { name: 'RQ-PHX-GGG7.md', markdown: md('src/boom.ts\n') };
  const c = capture();
  expect(await cmdFleetDraftCheck(['--stdin', '--json', '--fail-on-collision'], deps(c, boom, input([CLASH_A, failing])).deps)).toBe(2);
  expect(body(c).counts.errors).toBe(1);
  const c2 = capture();
  expect(await cmdFleetDraftCheck(['--stdin', '--json', '--fail-on-collision'], deps(c2, fakeGit(DONE), input([DONE_A, DONE_B])).deps)).toBe(3);
  const b = body(c2);
  expect(b.results.map(r => r.verdict)).toEqual(['likely-done', 'likely-done']);
  expect(b.collisions).toEqual([{ path: 'src/shared2.ts', files: [DONE_A.name, DONE_B.name] }]);
});

it('rejects a duplicated --fail-on-collision like every other flag, without probing', async () => {
  const git = fakeGit({});
  const resolveRef = vi.fn(async () => RESOLVED);
  const c = capture();
  const run = (args: string[]) =>
    cmdFleetDraftCheck(args, { ...c, git, resolveRef, readStdin: stream(input([CLASH_A, CLASH_B])) });
  for (const args of [
    ['--stdin', '--fail-on-collision', '--fail-on-collision'],
    ['--fail-on-collision', '--stdin', '--fail-on-collision'],
  ]) {
    expect(await run(args), JSON.stringify(args)).toBe(2);
    expect(c.errors.at(-1)).toContain('Usage: ashlr fleet draft-check');
  }
  expect(resolveRef).not.toHaveBeenCalled();
  expect(git.exists).not.toHaveBeenCalled();
  expect(c.out).toEqual([]);
});

it('documents the strict planner check and exit 4 on --help', async () => {
  const git = fakeGit({});
  const readStdin = vi.fn(stream(input([CLASH_A])));
  const resolveRef = vi.fn(async () => RESOLVED);
  const c = capture();
  expect(await cmdFleetDraftCheck(['--help'], { ...c, git, resolveRef, readStdin })).toBe(0);
  const text = c.out.join('\n');
  for (const fragment of ['--fail-on-collision', 'planner check only', 'exits 4']) {
    expect(text, fragment).toContain(fragment);
  }
  expect(readStdin).not.toHaveBeenCalled();
  expect(resolveRef).not.toHaveBeenCalled();
  expect(git.exists).not.toHaveBeenCalled();
});
