/** The self-tick reap over real temp git worktrees: real clean check, real `git worktree remove`, fake audit verdicts. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWorktreeReapStatus, runWorktreeReapTick, WORKTREE_REAP_CAP } from '../src/core/fleet/worktree-reap-tick.js';
import type { WorktreesDeps } from '../src/core/fleet/worktrees.js';
import type { WtAuditEntry } from '../src/core/fleet/wt-audit.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
let base: string;
let repo: string;
let wt: string;
let runs: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'reap-git-'));
  repo = join(base, 'repo'); wt = join(base, 'wt'); runs = join(base, 'runs');
  execFileSync('mkdir', ['-p', repo, wt, runs]);
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 'a@example.com'); git('config', 'user.name', 'a');
  await writeFile(join(repo, 'a.txt'), 'plain words\n');
  git('add', '.'); git('commit', '-q', '-m', 'first');
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });

const add = (job: string): void => { execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', job, join(wt, job)], { stdio: 'ignore' }); };
const entry = (name: string, state: WtAuditEntry['state'], ageHours: number, reapable = true): WtAuditEntry => ({
  name, state, pool: null, repo: 'phantom', bytes: null, sizeComplete: true, ageHours, reapable, via: null,
  blockers: reapable ? [] : [state === 'held' ? 'kept' : 'fresh'], signals: {} as WtAuditEntry['signals'],
});
const deps = (entries: WtAuditEntry[]): WorktreesDeps => ({
  wtRoot: wt,
  audit: (async () => ({ worktrees: entries, sources: { worktrees: 'healthy', runs: 'healthy', queue: 'healthy', keep: 'healthy', run: 'healthy', jobs: 'healthy', status: 'healthy', ps: 'healthy', pins: 'valid', sized: false } })) as unknown as WorktreesDeps['audit'],
});

describe('worktree reap over real git worktrees', () => {
  it('reaps safe ones, keeps dirty, young and kept-list ones, stops at the cap, records the run', { timeout: 60_000 }, async () => {
    const entries: WtAuditEntry[] = [];
    for (let i = 0; i < WORKTREE_REAP_CAP + 2; i++) { const job = `RQ-DONE${String(i).padStart(2, '0')}`; add(job); entries.push(entry(job, i % 2 ? 'merged' : 'empty', 10)); }
    add('RQ-DIRTY'); entries.push(entry('RQ-DIRTY', 'merged', 10));
    await writeFile(join(wt, 'RQ-DIRTY', 'notes.txt'), 'unsaved work\n');
    add('RQ-YOUNG'); entries.push(entry('RQ-YOUNG', 'merged', 0.5, false));
    add('RQ-KEPT'); entries.push(entry('RQ-KEPT', 'held', 10, false));

    const result = await runWorktreeReapTick({ runsDir: runs, apply: true, now: NOW, deps: deps(entries) });
    expect(result.state).toBe('ran');
    const gone = entries.filter(e => !existsSync(join(wt, e.name))).map(e => e.name);
    expect(gone).toHaveLength(WORKTREE_REAP_CAP);
    expect(gone.every(name => name.startsWith('RQ-DONE'))).toBe(true);
    for (const kept of ['RQ-DIRTY', 'RQ-YOUNG', 'RQ-KEPT']) expect(existsSync(join(wt, kept))).toBe(true);
    // One log line per removal.
    const log = (await readFile(join(runs, 'queue', 'worktree-reap.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l) as { job: string; status: string });
    expect(log).toHaveLength(WORKTREE_REAP_CAP);
    expect(log.every(l => l.status === 'removed')).toBe(true);
    const status = await readWorktreeReapStatus(runs);
    expect(status.last).toMatchObject({ removed: WORKTREE_REAP_CAP, waiting: 2, skipped: { 'uncommitted-changes': 1, 'too-new': 1, kept: 1 } });
  });

  it('a dry run removes nothing', { timeout: 60_000 }, async () => {
    const entries: WtAuditEntry[] = [];
    for (let i = 0; i < 41; i++) { const job = `RQ-DONE${String(i).padStart(2, '0')}`; add(job); entries.push(entry(job, 'merged', 10)); }
    const result = await runWorktreeReapTick({ runsDir: runs, apply: false, now: NOW, deps: deps(entries) });
    expect(result.state).toBe('dry-run');
    expect(entries.every(e => existsSync(join(wt, e.name)))).toBe(true);
  });
});
