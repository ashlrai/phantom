/**
 * fleet draft-check must catch what the dispatch ingest would drop: a draft
 * whose line 1 is not `#job repo=phantom lane=<lane> tier=<tier>`. The check
 * runs inside parseDrafts, so a bad header fails before origin/master is
 * resolved and before any git probe runs. Pure injected deps — no fs, no HOME.
 */
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
const draft = (name: string, markdown: string) => ({ name, markdown });
const ok = (name: string, body: string) => draft(name, `${HEADER}\n${body}`);

const DONE = { 'src/done.ts': 'bridge(RQ-PHX-HDRA1): landed', 'src/shared.ts': 'bridge(RQ-PHX-HDRB2): landed' };
const A = ok('RQ-PHX-HDRA1.md', 'Edit src/done.ts and src/shared.ts\n');
const B = ok('RQ-PHX-HDRB2.md', 'Touch src/shared.ts and src/new.ts\n');

it('accepts a valid header and emits the normal snapshot and results', async () => {
  const git = fakeGit(DONE);
  const c = capture();
  const { deps: d, resolveRef } = deps(c, git, input([A, B]));
  expect(await cmdFleetDraftCheck(['--stdin'], d)).toBe(3);
  expect(resolveRef).toHaveBeenCalledTimes(1);
  expect(resolveRef).toHaveBeenCalledWith('origin/master');
  expect(git.exists.mock.calls.map(call => call[0])).toEqual(['src/done.ts', 'src/shared.ts', 'src/new.ts']);
  expect(c.out).toEqual([
    `snapshot: origin/master -> ${RESOLVED}`,
    `== ${A.name}`,
    'src/done.ts on-master abc1234 bridge(RQ-PHX-HDRA1): landed',
    'src/shared.ts on-master abc1234 bridge(RQ-PHX-HDRB2): landed',
    'verdict: likely-done',
    `== ${B.name}`,
    'src/shared.ts on-master abc1234 bridge(RQ-PHX-HDRB2): landed',
    'src/new.ts missing',
    'verdict: partly-on-master',
    `collision: src/shared.ts <- ${A.name}, ${B.name}`,
    'batch: fresh=0 partly-on-master=1 likely-done=1 errors=0',
  ]);
});

it('accepts a CRLF-terminated header line and rejects a bare CR', async () => {
  const git = fakeGit({});
  const crlf = draft('RQ-PHX-HDRC1.md', '#job repo=phantom lane=devin tier=work\r\nCreate src/fresh.ts\r\n');
  const c = capture();
  const { deps: d, resolveRef } = deps(c, git, input([crlf]));
  expect(await cmdFleetDraftCheck(['--stdin', '--json'], d)).toBe(0);
  expect(resolveRef).toHaveBeenCalledTimes(1);
  expect(git.exists).toHaveBeenCalledWith('src/fresh.ts');
  const body = JSON.parse(c.out[0]!) as { resolvedRef: string; counts: Record<string, number> };
  expect(body.resolvedRef).toBe(RESOLVED);
  expect(body.counts).toEqual({ fresh: 1, 'partly-on-master': 0, 'likely-done': 0, errors: 0 });

  // A CR not followed by LF is content, not a line ending: the header parse sees it.
  const bareCr = draft('RQ-PHX-HDRC2.md', '#job repo=phantom lane=devin tier=work\rCreate src/fresh.ts\n');
  const c2 = capture();
  const { deps: d2, resolveRef: resolveRef2 } = deps(c2, git, input([bareCr]));
  expect(await cmdFleetDraftCheck(['--stdin', '--json'], d2)).toBe(2);
  expect(c2.errors.join(' ')).toContain(bareCr.name);
  expect(resolveRef2).not.toHaveBeenCalled();
  expect(git.exists).toHaveBeenCalledTimes(1);
});

it('rejects every batch with an undispatchable header before resolving or probing', async () => {
  const git = fakeGit(DONE);
  const cases: Array<{ name: string; markdown: string }> = [
    // No header at all: line 1 is body text.
    draft('RQ-PHX-HDRM1.md', 'Edit src/done.ts\n'),
    // Leading blank line: line 1 is empty; it is never trimmed away.
    draft('RQ-PHX-HDRM2.md', '\n#job repo=phantom lane=devin tier=work\nEdit src/done.ts\n'),
    draft('RQ-PHX-HDRM3.md', '   \n#job repo=phantom lane=devin tier=work\nEdit src/done.ts\n'),
    // Doubled spaces anywhere in the header.
    draft('RQ-PHX-HDRM4.md', '#job  repo=phantom lane=devin tier=work\nEdit src/done.ts\n'),
    draft('RQ-PHX-HDRM5.md', '#job repo=phantom lane=devin  tier=work\nEdit src/done.ts\n'),
    // A leading space makes line 1 start with ' ', not '#job'.
    draft('RQ-PHX-HDRM6.md', ' #job repo=phantom lane=devin tier=work\nEdit src/done.ts\n'),
    // Unsupported tier.
    draft('RQ-PHX-HDRM7.md', '#job repo=phantom lane=devin tier=turbo\nEdit src/done.ts\n'),
    // A repo other than phantom — this command is PHX-only.
    draft('RQ-PHX-HDRM8.md', '#job repo=other lane=devin tier=work\nEdit src/done.ts\n'),
    // Header on line 2 does not rescue a bad line 1.
    draft('RQ-PHX-HDRM9.md', 'Plan: touch src/done.ts\n#job repo=phantom lane=devin tier=work\n'),
  ];
  for (const bad of cases) {
    const c = capture();
    const { deps: d, resolveRef } = deps(c, git, input([bad]));
    expect(await cmdFleetDraftCheck(['--stdin', '--json'], d), bad.name).toBe(2);
    const last = c.errors.at(-1) ?? '';
    expect(last, bad.name).toContain(bad.name);
    expect(last.length).toBeLessThanOrEqual(300 + 'error: '.length);
    expect(resolveRef, bad.name).not.toHaveBeenCalled();
    expect(git.exists, bad.name).not.toHaveBeenCalled();
    expect(git.lastCommit, bad.name).not.toHaveBeenCalled();
    expect(c.out, bad.name).toEqual([]);
  }
});

it('rejects a batch whose second draft has a bad header without resolving or probing', async () => {
  const git = fakeGit(DONE);
  // A valid first draft does not rescue a second draft whose line 1 is body text.
  const bad = draft('RQ-PHX-HDRB9.md', 'Edit src/done.ts\n');
  const c = capture();
  const { deps: d, resolveRef } = deps(c, git, input([A, bad]));
  expect(await cmdFleetDraftCheck(['--stdin', '--json'], d)).toBe(2);
  expect(c.errors.join(' ')).toContain(bad.name);
  expect(resolveRef).not.toHaveBeenCalled();
  expect(git.exists).not.toHaveBeenCalled();
  expect(git.lastCommit).not.toHaveBeenCalled();
  expect(c.out).toEqual([]);
});

it('imposes no lane policy: any syntactically valid lane is accepted', async () => {
  const git = fakeGit({});
  const exotic = draft('RQ-PHX-HDRL1.md', '#job repo=phantom lane=lane-never-seen tier=fast\nCreate src/fresh.ts\n');
  const c = capture();
  const { deps: d } = deps(c, git, input([exotic]));
  expect(await cmdFleetDraftCheck(['--stdin', '--json'], d)).toBe(0);
  expect((JSON.parse(c.out[0]!) as { counts: Record<string, number> }).counts.fresh).toBe(1);
});

it('bounds the reported error even when the bad header is long', async () => {
  const git = fakeGit({});
  const long = draft('RQ-PHX-HDRE1.md', `#job repo=phantom lane=devin tier=${'a'.repeat(7000)}\nEdit src/done.ts\n`);
  const c = capture();
  const { deps: d, resolveRef } = deps(c, git, input([long]));
  expect(await cmdFleetDraftCheck(['--stdin', '--json'], d)).toBe(2);
  expect(c.errors).toHaveLength(1);
  expect(c.errors[0]).toContain(long.name);
  expect(c.errors[0]!.length).toBeLessThanOrEqual(300 + 'error: '.length);
  expect(resolveRef).not.toHaveBeenCalled();
  expect(git.exists).not.toHaveBeenCalled();
});
