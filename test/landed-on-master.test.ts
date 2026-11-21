import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { landedLine, landedOnMaster, readPublishedJobs } from '../src/core/fleet/landed-on-master.js';
import { cmdJobsLanded } from '../src/cli/jobs-landed.js';
import { writeLeaderFacts } from '../src/core/fleet/leader-facts.js';

const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.test' } });
let base: string, origin: string, clone: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'landed-git-'));
  origin = join(base, 'origin'); clone = join(base, 'clone');
  await mkdir(origin);
  run(origin, 'init', '-q', '-b', 'master');
  for (const subject of ['start of history', 'bridge(RQ-ABC): add the thing (#1)', 'RQ-DEF squash title (#2)']) run(origin, 'commit', '-q', '--allow-empty', '-m', subject);
  run(base, 'clone', '-q', origin, clone);
});
afterAll(async () => { await rm(base, { recursive: true, force: true }); });

describe('landedOnMaster', () => {
  it('finds ids in bridge and squash subjects and reports the rest as not landed', () => {
    const r = landedOnMaster(['RQ-ABC', 'RQ-DEF', 'RQ-NOPE'], { cwd: clone, since: '1 day ago' });
    expect(r.map(x => x.state)).toEqual(['landed', 'landed', 'not-landed']);
    expect(r[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Date.parse(r[0]!.landedAt!)).not.toBeNaN();
    expect(r.every(x => x.how === 'git-subject')).toBe(true);
  });
  it('does not match an id that is only a prefix of another id', () => {
    const r = landedOnMaster(['RQ-AB', 'RQ-AB-'], { cwd: clone, since: '1 day ago' });
    expect(r.map(x => x.state)).toEqual(['not-landed', 'not-landed']);
  });
  it('says unknown, never not-landed, when the fetch fails', () => {
    const broken = join(base, 'not-a-repo');
    const r = landedOnMaster(['RQ-ABC'], { cwd: broken });
    expect(r[0]!.state).toBe('unknown');
    const r2 = landedOnMaster(['RQ-ABC'], { git: () => { throw new Error('offline'); } });
    expect(r2[0]!.state).toBe('unknown');
  });
  it('picks up a commit that landed after the clone was made', () => {
    run(origin, 'commit', '-q', '--allow-empty', '-m', 'bridge(RQ-LATE): later (#3)');
    expect(landedOnMaster(['RQ-LATE'], { cwd: clone, since: '1 day ago' })[0]!.state).toBe('landed');
  });
});

describe('landedLine', () => {
  const now = Date.parse('2026-01-02T12:00:00Z');
  it('uses plain words', () => {
    expect(landedLine({ id: 'RQ-A', state: 'landed', sha: '1a2b3c4d5e', landedAt: '2026-01-02T10:03:00Z', how: 'git-subject' }, Date.parse('2026-01-02T10:00:00Z'), now)).toBe('RQ-A landed 3 min after its PR (sha 1a2b3c4)');
    expect(landedLine({ id: 'RQ-B', state: 'not-landed', how: 'git-subject' }, Date.parse('2026-01-02T10:00:00Z'), now)).toBe('RQ-B published 2 h ago, not on master yet');
    expect(landedLine({ id: 'RQ-C', state: 'unknown', how: 'git-subject' }, undefined, now)).toContain("can't tell");
  });
});

describe('surfaces', () => {
  it('jobs landed lists published jobs from the ledger', async () => {
    const root = join(base, 'runs'); await mkdir(join(root, 'metrics'), { recursive: true });
    const nowMs = Date.now();
    await writeFile(join(root, 'metrics', 'jobs.jsonl'), `${JSON.stringify({ id: 'RQ-ABC', event: 'publish', ts: new Date(nowMs - 3_600_000).toISOString() })}\n`);
    expect((await readPublishedJobs(root, nowMs - 86_400_000)).map(j => j.id)).toEqual(['RQ-ABC']);
    const prev = process.env.ASHLR_LANDED_REPO; process.env.ASHLR_LANDED_REPO = clone;
    const lines: string[] = [], orig = console.log; console.log = (t: string) => { lines.push(t); };
    try { expect(await cmdJobsLanded(['--runs-dir', root, '--json'], nowMs)).toBe(0); } finally { console.log = orig; if (prev === undefined) delete process.env.ASHLR_LANDED_REPO; else process.env.ASHLR_LANDED_REPO = prev; }
    expect(JSON.parse(lines[0]!).jobs[0].state).toBe('landed');
  });
  it('leader facts fill merged from git when gh cannot answer', async () => {
    const root = join(base, 'facts'); await mkdir(join(root, 'queue'), { recursive: true }); await mkdir(join(root, 'metrics'));
    await writeFile(join(root, 'queue/router-queue.md'), '- READY RQ-ABC (repo=phantom, src=leader): work\n');
    await writeFile(join(root, 'metrics/jobs.jsonl'), `${JSON.stringify({ id: 'RQ-ABC', event: 'publish', pr_url: 'https://github.com/ashlrai/phantom/pull/1', ts: '2026-01-02T01:00:00Z' })}\n`);
    const facts = await writeLeaderFacts(root, async () => { throw new Error('no gh'); }, Date.parse('2026-01-02T02:00:00Z'), ids => landedOnMaster(ids, { cwd: clone, since: '1 day ago' }));
    expect(facts.jobs[0]).toMatchObject({ id: 'RQ-ABC', pr_state: 'merged', source: 'git' });
    expect(facts.jobs[0]!.merged_at).not.toBeNull();
  });
});
