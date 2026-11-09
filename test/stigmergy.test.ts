import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  TrailError, beatTrail, claimTrail, listTrailClaims, parseTrailClaim,
  releaseTrail, resumeTrail, saveTrailCheckpoint, showTrailClaim, sweepTrail,
  TRAIL_DEFAULT_LEASE_MS,
} from '../src/core/stigmergy.js';
import { cmdTrail } from '../src/cli/trail.js';

const KEY = 'repo:example/project';
const checkpoint = {
  version: 1, goal: 'Ship the change', done: ['Implemented the parser'],
  next: ['Run the affected tests'], evidence: ['src/parser.ts'], openQuestions: [],
};

let dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'trail-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
  delete process.env['ASHLR_HOME'];
});

describe('stigmergic trail', () => {
  it('claims a key, exposes a holder view without the token, and conflicts overlaps', async () => {
    const dir = await scratch();
    const result = claimTrail({ claimKey: KEY, owner: 'job-1', note: 'first pass', dir, now: 1_000 });
    expect(result.status).toBe('claimed');
    if (result.status !== 'claimed') return;
    expect(result.token).toMatch(/^[a-f0-9]{64}$/);
    expect(result.claim.leaseUntil).toBe(1_000 + TRAIL_DEFAULT_LEASE_MS);
    const names = await readdir(join(dir, 'claims'));
    expect(names).toHaveLength(1);
    const file = join(dir, 'claims', names[0]!);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain(result.token);
    expect(JSON.parse(text).tokenHash).toMatch(/^[a-f0-9]{64}$/);
    const clash = claimTrail({ claimKey: KEY, owner: 'job-2', dir, now: 1_001 });
    expect(clash.status).toBe('conflict');
    if (clash.status !== 'conflict') return;
    expect(clash.holder.owner).toBe('job-1');
    expect(JSON.stringify(clash)).not.toContain(result.token);
    const overlap = claimTrail({ claimKey: 'path:example/project:src/**', owner: 'job-3', dir, now: 1_001 });
    expect(overlap.status).toBe('conflict');
    const free = claimTrail({ claimKey: 'repo:example/other', owner: 'job-4', dir, now: 1_001 });
    expect(free.status).toBe('claimed');
  });

  it('beats to extend the lease and refresh the note, and refuses bad tokens and expiry', async () => {
    const dir = await scratch();
    const claimed = claimTrail({ claimKey: KEY, owner: 'job-1', dir, now: 1_000 });
    if (claimed.status !== 'claimed') throw new Error('setup failed');
    const beat = beatTrail({ claimKey: KEY, token: claimed.token, note: 'halfway', dir, now: 2_000 });
    expect(beat.status).toBe('ok');
    if (beat.status !== 'ok') return;
    expect(beat.claim.heartbeatAt).toBe(2_000);
    expect(beat.claim.note).toBe('halfway');
    expect(beat.claim.leaseUntil).toBe(2_000 + TRAIL_DEFAULT_LEASE_MS);
    expect(beatTrail({ claimKey: KEY, token: 'f'.repeat(64), dir, now: 3_000 })).toEqual({ status: 'refused', reason: 'bad-token' });
    expect(beatTrail({ claimKey: 'repo:example/absent', token: claimed.token, dir, now: 3_000 })).toEqual({ status: 'refused', reason: 'unknown-claim' });
    const expiredAt = beat.claim.leaseUntil + 1;
    expect(beatTrail({ claimKey: KEY, token: claimed.token, dir, now: expiredAt })).toEqual({ status: 'refused', reason: 'expired' });
    const takeover = claimTrail({ claimKey: KEY, owner: 'job-2', dir, now: expiredAt });
    expect(takeover.status).toBe('claimed');
    if (takeover.status === 'claimed') {
      expect(beatTrail({ claimKey: KEY, token: claimed.token, dir, now: expiredAt })).toEqual({ status: 'refused', reason: 'bad-token' });
    }
  });

  it('releases with the token and forgets the marker', async () => {
    const dir = await scratch();
    const claimed = claimTrail({ claimKey: KEY, owner: 'job-1', dir, now: 1_000 });
    if (claimed.status !== 'claimed') throw new Error('setup failed');
    expect(releaseTrail({ claimKey: KEY, token: '0'.repeat(64), dir })).toEqual({ status: 'refused', reason: 'bad-token' });
    expect(releaseTrail({ claimKey: KEY, token: claimed.token, outcome: 'completed', dir }))
      .toEqual({ status: 'released', outcome: 'completed', claimKey: KEY });
    expect(showTrailClaim({ claimKey: KEY, dir, now: 2_000 })).toBeUndefined();
    expect(releaseTrail({ claimKey: KEY, token: claimed.token, dir })).toEqual({ status: 'refused', reason: 'unknown-claim' });
  });

  it('saves resumable state into the deterministic slot and resumes it after a stall', async () => {
    const dir = await scratch();
    const wt = await mkdtemp(join(tmpdir(), 'trail-wt-'));
    dirs.push(wt);
    const git = (...args: string[]) => promisify(execFile)('git', ['-C', wt, ...args]);
    await git('init'); await git('config', 'user.email', 'test@example.test'); await git('config', 'user.name', 'Test');
    await writeFile(join(wt, 'tracked'), 'base'); await git('add', 'tracked'); await git('commit', '-m', 'base');
    await writeFile(join(wt, 'tracked'), 'changed');
    const source = join(dir, 'handoff.json');
    await writeFile(source, JSON.stringify(checkpoint));

    const claimed = claimTrail({ claimKey: KEY, owner: 'job-1', worktree: wt, dir, now: 1_000 });
    if (claimed.status !== 'claimed') throw new Error('setup failed');
    const saved = await saveTrailCheckpoint({ claimKey: KEY, token: claimed.token, source, worktree: wt, dir, now: 2_000 });
    expect(saved.status).toBe('saved');
    if (saved.status !== 'saved') return;
    expect(saved.checkpoint.startsWith(join(dir, 'checkpoints'))).toBe(true);
    expect((await stat(saved.checkpoint)).mode & 0o777).toBe(0o600);

    const resumed = await resumeTrail({ claimKey: KEY, dir, now: 3_000 });
    expect(resumed.status).toBe('ok');
    if (resumed.status !== 'ok') return;
    expect(resumed.checkpoint?.goal).toBe('Ship the change');
    expect(resumed.checkpoint?.evidence.join(' ')).toContain('Worktree HEAD:');
    expect(resumed.checkpoint?.evidence.join(' ')).toContain('tracked');
    expect(resumed.claim.checkpoint).toBe(saved.checkpoint);

    releaseTrail({ claimKey: KEY, token: claimed.token, dir });
    const reclaim = claimTrail({ claimKey: KEY, owner: 'job-9', dir, now: 4_000 });
    expect(reclaim.status).toBe('claimed');
    const picked = await resumeTrail({ claimKey: KEY, dir, now: 4_001 });
    if (picked.status !== 'ok') throw new Error('resume failed');
    expect(picked.checkpoint?.next).toEqual(['Run the affected tests']);
    expect(picked.claim.owner).toBe('job-9');
  });

  it('saves an authored checkpoint without a worktree and refuses secret-shaped content', async () => {
    const dir = await scratch();
    const claimed = claimTrail({ claimKey: KEY, owner: 'job-1', dir, now: 1_000 });
    if (claimed.status !== 'claimed') throw new Error('setup failed');
    const source = join(dir, 'handoff.json');
    await writeFile(source, JSON.stringify(checkpoint));
    const saved = await saveTrailCheckpoint({ claimKey: KEY, token: claimed.token, source, dir, now: 2_000 });
    expect(saved.status).toBe('saved');
    await writeFile(source, JSON.stringify({ ...checkpoint, goal: 'password=supersecretvalue123' }));
    await expect(saveTrailCheckpoint({ claimKey: KEY, token: claimed.token, source, dir, now: 3_000 }))
      .rejects.toThrow(TrailError);
    expect(() => claimTrail({ claimKey: KEY, owner: 'job-1', note: `sk-ant-${'a'.repeat(30)}`, dir, now: 3_000 })).toThrow(TrailError);
  });

  it('lists live markers ahead of expired ones and reports corrupt files', async () => {
    const dir = await scratch();
    claimTrail({ claimKey: 'repo:example/old', owner: 'job-1', dir, now: 100 });
    claimTrail({ claimKey: 'repo:example/fresh', owner: 'job-2', dir, now: 1_000 });
    await writeFile(join(dir, 'claims', `${'a'.repeat(64)}.json`), '{broken');
    const list = listTrailClaims({ dir, now: 2_000 });
    expect(list.claims.map(c => c.claimKey)).toEqual(['repo:example/fresh', 'repo:example/old']);
    expect(list.unreadable).toBe(1);
    const later = listTrailClaims({ dir, now: 100 + TRAIL_DEFAULT_LEASE_MS + 1 });
    expect(later.claims.map(c => c.status)).toEqual(['live', 'expired']);
  });

  it('sweeps expired markers and old orphaned checkpoints, keeping live claims', async () => {
    const dir = await scratch();
    const t0 = Date.now();
    claimTrail({ claimKey: 'repo:example/live', owner: 'job-1', leaseMs: 600_000, dir, now: t0 });
    claimTrail({ claimKey: 'repo:example/dead', owner: 'job-2', leaseMs: 1, dir, now: t0 });
    await writeFile(join(dir, 'checkpoints', `${'c'.repeat(64)}.json`), JSON.stringify(checkpoint));
    const swept = sweepTrail({ dir, now: t0 + 60_000, checkpointMaxAgeMs: 1 });
    expect(swept.keptClaims).toBe(1);
    expect(swept.removedClaims).toBe(1);
    expect(swept.removedCheckpoints).toBe(1);
  });

  it('validates markers strictly', () => {
    const base = {
      version: 1, claimKey: KEY, owner: 'job-1', tokenHash: 'a'.repeat(64),
      leaseMs: 1000, leaseUntil: 2000, heartbeatAt: 1000, createdAt: 1000, updatedAt: 1000,
    };
    expect(parseTrailClaim(JSON.stringify(base)).claimKey).toBe(KEY);
    for (const bad of ['{', '{}', JSON.stringify({ ...base, extra: 1 }), JSON.stringify({ ...base, version: 2 }),
      JSON.stringify({ ...base, claimKey: 'nonsense' }), JSON.stringify({ ...base, leaseMs: 0 })]) {
      expect(() => parseTrailClaim(bad)).toThrow(TrailError);
    }
  });

  it('maps CLI verbs to exit codes and JSON output', async () => {
    const dir = await scratch();
    process.env['ASHLR_HOME'] = dir;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await cmdTrail(['claim', KEY, '--owner', 'job-1', '--json'])).toBe(0);
      const claimed = JSON.parse(String(log.mock.calls[0]![0]));
      expect(claimed.status).toBe('claimed');
      expect(await cmdTrail(['claim', KEY, '--owner', 'job-2'])).toBe(3);
      expect(await cmdTrail(['beat', KEY, '--token', 'f'.repeat(64)])).toBe(4);
      expect(await cmdTrail(['beat', KEY, '--token', claimed.token, '--json'])).toBe(0);
      expect(await cmdTrail(['show', KEY, '--json'])).toBe(0);
      expect(await cmdTrail(['list', '--json'])).toBe(0);
      const listed = JSON.parse(String(log.mock.calls.at(-1)![0]));
      expect(listed.claims).toHaveLength(1);
      expect(await cmdTrail(['resume', KEY, '--json'])).toBe(0);
      expect(await cmdTrail(['release', KEY, '--token', claimed.token, '--outcome', 'released'])).toBe(0);
      expect(await cmdTrail(['sweep', '--json'])).toBe(0);
      expect(await cmdTrail(['show', 'repo:example/gone'])).toBe(4);
      expect(await cmdTrail(['claim'])).toBe(2);
      expect(await cmdTrail(['claim', 'bad key', '--owner', 'x'])).toBe(2);
      expect(await cmdTrail(['bogus'])).toBe(2);
      expect(await cmdTrail(['--help'])).toBe(0);
    } finally {
      log.mockRestore(); err.mockRestore();
    }
  });
});
