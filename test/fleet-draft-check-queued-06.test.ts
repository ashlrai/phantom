/** fleet draft-check --queued: drafts vs jobs still waiting in the queue. Injected deps — no fs, no HOME. */
import { expect, it, vi } from 'vitest';
import { cmdFleetDraftCheck } from '../src/cli/fleet-draft-check.js';
import type { JobPrecheckGit } from '../src/core/fleet/job-precheck.js';
import type { QueuedPathClaims } from '../src/core/fleet/queued-path-claims.js';

const RESOLVED = 'b'.repeat(40);
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

const HEADER = '#job repo=phantom lane=devin tier=work';
const md = (body: string) => `${HEADER}\n${body}`;
const A = 'RQ-PHX-FAKEQUEUEDA06';
const B = 'RQ-PHX-FAKEQUEUEDB06';
const HEALTHY: QueuedPathClaims = {
  sourceState: 'healthy',
  claims: new Map([
    ['src/core/fleet/example-a.ts', [A, B]],
    ['test/example-a.test.ts', [B]],
  ]),
};

function deps(c: ReturnType<typeof capture>, git: JobPrecheckGit, stdin: Uint8Array, read: QueuedPathClaims | Error = HEALTHY) {
  const readQueuedClaims = vi.fn(async () => {
    if (read instanceof Error) throw read;
    return read;
  });
  return {
    deps: { ...c, git, resolveRef: vi.fn(async () => RESOLVED), readStdin: stream(stdin), readQueuedClaims },
    readQueuedClaims,
  };
}

it('prints queued-collision lines before batch and the queued source after it', async () => {
  const drafts = [
    { name: 'RQ-PHX-DRAFTX06.md', markdown: md('Edit src/core/fleet/example-a.ts\n') },
    { name: `${A}.md`, markdown: md('Also edit src/core/fleet/example-a.ts\n') },
    { name: 'RQ-PHX-DRAFTY06.md', markdown: md('Touch src/unclaimed.ts\n') },
  ];
  const c = capture();
  const { deps: d, readQueuedClaims } = deps(c, fakeGit({}), input(drafts));
  expect(await cmdFleetDraftCheck(['--stdin', '--queued'], d)).toBe(0);
  expect(readQueuedClaims).toHaveBeenCalledTimes(1);
  expect(c.out).toEqual([
    `snapshot: origin/master -> ${RESOLVED}`,
    '== RQ-PHX-DRAFTX06.md',
    'src/core/fleet/example-a.ts missing',
    'verdict: fresh',
    `== ${A}.md`,
    'src/core/fleet/example-a.ts missing',
    'verdict: fresh',
    '== RQ-PHX-DRAFTY06.md',
    'src/unclaimed.ts missing',
    'verdict: fresh',
    `collision: src/core/fleet/example-a.ts <- RQ-PHX-DRAFTX06.md, ${A}.md`,
    // Both queued ids claim the path; the draft's own queued id is a re-issue.
    `queued-collision: src/core/fleet/example-a.ts <- RQ-PHX-DRAFTX06.md vs ${A}, ${B}`,
    `queued-collision: src/core/fleet/example-a.ts <- ${A}.md vs ${B}`,
    'batch: fresh=3 partly-on-master=0 likely-done=0 errors=0',
    'queued: healthy',
  ]);
});

it('adds queuedCollisions and queuedSource to --json without changing the exit code', async () => {
  const drafts = [{ name: 'RQ-PHX-DRAFTX06.md', markdown: md('Edit src/core/fleet/example-a.ts\n') }];
  const c = capture();
  expect(await cmdFleetDraftCheck(['--stdin', '--queued', '--json'], deps(c, fakeGit({}), input(drafts)).deps)).toBe(0);
  const body = JSON.parse(c.out[0]!) as {
    schema: string; queuedCollisions: Array<{ path: string; draft: string; queued: string[] }>; queuedSource: string;
  };
  expect(body.schema).toBe('fleet.draft-check.v1');
  expect(body.queuedSource).toBe('healthy');
  expect(body.queuedCollisions).toEqual([
    { path: 'src/core/fleet/example-a.ts', draft: 'RQ-PHX-DRAFTX06.md', queued: [A, B] },
  ]);

  // likely-done drafts still exit 3; per-draft errors still exit 2.
  const done = { 'src/done.ts': 'bridge(RQ-PHX-AAAA1): landed' };
  const c2 = capture();
  const landed = [{ name: 'RQ-PHX-DRAFTZ06.md', markdown: md('Edit src/done.ts\n') }];
  expect(await cmdFleetDraftCheck(['--stdin', '--queued', '--json'], deps(c2, fakeGit(done), input(landed)).deps)).toBe(3);
  const boom: JobPrecheckGit = { exists: vi.fn(async () => { throw new Error('fatal: bad revision'); }), lastCommit: vi.fn(async () => null) };
  const c3 = capture();
  expect(await cmdFleetDraftCheck(['--stdin', '--queued', '--json'], deps(c3, boom, input(landed)).deps)).toBe(2);
  expect((JSON.parse(c3.out[0]!) as { queuedSource: string }).queuedSource).toBe('healthy');
});

it('surfaces missing and degraded queue sources without touching exit codes', async () => {
  const drafts = [{ name: 'RQ-PHX-DRAFTX06.md', markdown: md('Edit src/core/fleet/example-a.ts\n') }];
  for (const sourceState of ['missing', 'degraded'] as const) {
    const c = capture();
    const { deps: d } = deps(c, fakeGit({}), input(drafts), { sourceState, claims: new Map() });
    expect(await cmdFleetDraftCheck(['--stdin', '--queued'], d)).toBe(0);
    expect(c.out.at(-1)).toBe(`queued: ${sourceState}`);
    expect(c.out.some(line => line.startsWith('queued-collision:'))).toBe(false);
  }
  const c = capture();
  expect(await cmdFleetDraftCheck(['--stdin', '--queued'], deps(c, fakeGit({}), input(drafts), new Error('io')).deps)).toBe(0);
  expect(c.out.at(-1)).toBe('queued: degraded');
});

it('leaves output byte-identical without --queued and never reads the queue', async () => {
  const drafts = [
    { name: 'RQ-PHX-DRAFTX06.md', markdown: md('Edit src/core/fleet/example-a.ts\n') },
    { name: 'RQ-PHX-DRAFTW06.md', markdown: md('Touch src/new.ts\n') },
  ];
  const c = capture();
  const { deps: d, readQueuedClaims } = deps(c, fakeGit({}), input(drafts));
  expect(await cmdFleetDraftCheck(['--stdin'], d)).toBe(0);
  expect(readQueuedClaims).not.toHaveBeenCalled();
  const without = [...c.out];

  // With --queued and no claims, the only new line is the queued source trailer.
  const c2 = capture();
  const { deps: d2 } = deps(c2, fakeGit({}), input(drafts), { sourceState: 'healthy', claims: new Map() });
  expect(await cmdFleetDraftCheck(['--stdin', '--queued'], d2)).toBe(0);
  expect(c2.out).toEqual([...without, 'queued: healthy']);

  // JSON without --queued carries no queued keys at all.
  const c3 = capture();
  expect(await cmdFleetDraftCheck(['--stdin', '--json'], deps(c3, fakeGit({}), input(drafts)).deps)).toBe(0);
  const body = JSON.parse(c3.out[0]!) as Record<string, unknown>;
  expect(body).not.toHaveProperty('queuedCollisions');
  expect(body).not.toHaveProperty('queuedSource');
});

it('rejects --queued without --stdin, a repeated --queued and unknown flags', async () => {
  const c = capture();
  const d = deps(c, fakeGit({}), input([{ name: 'RQ-PHX-DRAFTX06.md', markdown: md('src/x.ts\n') }])).deps;
  for (const args of [['--queued'], ['--stdin', '--queued', '--queued'], ['--stdin', '--queued', '--bogus']]) {
    expect(await cmdFleetDraftCheck(args, d), JSON.stringify(args)).toBe(2);
  }
  expect(c.out).toEqual([]);
});

it('documents --queued on --help', async () => {
  const c = capture();
  expect(await cmdFleetDraftCheck(['--help'], { ...c })).toBe(0);
  const text = c.out.join('\n');
  for (const fragment of ['--queued', 'queue prompts', 'queued-collision', 're-issue', 'queued: healthy|missing|degraded']) {
    expect(text, fragment).toContain(fragment);
  }
});
