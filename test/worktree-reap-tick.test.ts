/** Hermetic tests for the self-tick worktree reap: a fake audit, no Git, state kept in a temp runs dir. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdWorktrees } from '../src/cli/worktrees.js';
import {
  readWorktreeReapStatus, runWorktreeReapTick, WORKTREE_REAP_CAP, WORKTREE_REAP_MIN_GAP_MS, WORKTREE_REAP_STATUS_SCHEMA,
} from '../src/core/fleet/worktree-reap-tick.js';
import type { WorktreesDeps } from '../src/core/fleet/worktrees.js';
import type { WtAuditEntry, WtAuditReport } from '../src/core/fleet/wt-audit.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
let runs: string;
beforeEach(async () => { runs = await mkdtemp(join(tmpdir(), 'reap-tick-')); });
afterEach(async () => { await rm(runs, { recursive: true, force: true }); });

const entry = (name: string, state: WtAuditEntry['state'], reapable = true): WtAuditEntry => ({
  name, state, pool: null, repo: 'phantom', bytes: null, sizeComplete: true, ageHours: 10, reapable, via: null,
  blockers: reapable ? [] : ['kept'], signals: {} as WtAuditEntry['signals'],
});

/** `merged` safe rows, `open` open-PR rows; the audit lists them all. */
function fixture(merged: number, open: number) {
  const entries = [
    ...Array.from({ length: merged }, (_, i) => entry(`RQ-M${String(i).padStart(3, '0')}`, 'merged')),
    ...Array.from({ length: open }, (_, i) => entry(`RQ-O${String(i).padStart(3, '0')}`, 'open', false)),
  ];
  const sources = { worktrees: 'healthy', runs: 'healthy', queue: 'healthy', keep: 'healthy', run: 'healthy', jobs: 'healthy', status: 'healthy', ps: 'healthy', pins: 'valid', sized: false };
  const removed: string[] = [];
  const deps = {
    wtRoot: '/wt',
    audit: (async () => ({ worktrees: entries, sources })) as unknown as WorktreesDeps['audit'],
    isClean: async () => true,
    measure: () => ({ bytes: 1_000_000, complete: true }),
    remove: async (path: string) => { removed.push(path.slice('/wt/'.length)); },
    logRemoval: async () => undefined,
  } satisfies WorktreesDeps;
  return { deps, removed };
}
const tick = (deps: WorktreesDeps, now = NOW, apply = true) => runWorktreeReapTick({ runsDir: runs, apply, now, deps });

describe('self-tick worktree reap', () => {
  it('above the warning level reaps up to the cap and records the run', async () => {
    const { deps, removed } = fixture(60, 5);
    const result = await tick(deps);
    expect(result.state).toBe('ran');
    expect(removed).toHaveLength(WORKTREE_REAP_CAP);
    const status = await readWorktreeReapStatus(runs);
    expect(status.schema).toBe(WORKTREE_REAP_STATUS_SCHEMA);
    expect(status.off).toBe(false);
    expect(status.last).toMatchObject({ total: 65, removed: 25, waiting: 35, bytesFreed: 25_000_000, bytesComplete: true, skipped: { 'open-pr': 5 } });
    expect(status.nextRunAfter).toBe(new Date(NOW + WORKTREE_REAP_MIN_GAP_MS).toISOString());
  });

  it('at or below the warning level does nothing', async () => {
    const { deps, removed } = fixture(30, 10);
    const result = await tick(deps);
    expect(result).toEqual({ state: 'skipped', reason: '40 job worktrees, at or below the warning level of 40' });
    expect(removed).toHaveLength(0);
    expect((await readWorktreeReapStatus(runs)).lastNote).toBe('never-run');
  });

  it('a kill switch file is a plain no-op', async () => {
    const { deps, removed } = fixture(60, 0);
    await mkdir(join(runs, 'queue'), { recursive: true });
    await writeFile(join(runs, 'queue', 'worktree-reap.off'), '');
    expect(await tick(deps)).toEqual({ state: 'skipped', reason: 'off: worktree-reap.off is present' });
    expect(removed).toHaveLength(0);
    expect((await readWorktreeReapStatus(runs)).off).toBe(true);
  });

  it('a second run inside 30 minutes is a no-op, and one after it runs again', async () => {
    const { deps, removed } = fixture(60, 0);
    expect((await tick(deps)).state).toBe('ran');
    expect(await tick(deps, NOW + 29 * 60_000)).toEqual({ state: 'skipped', reason: 'ran less than 30 minutes ago' });
    expect(removed).toHaveLength(25);
    expect((await tick(deps, NOW + 31 * 60_000)).state).toBe('ran');
    expect(removed).toHaveLength(50);
  });

  it('a dry run removes and records nothing', async () => {
    const { deps, removed } = fixture(60, 0);
    expect((await tick(deps, NOW, false)).state).toBe('skipped');
    expect(removed).toHaveLength(0);
    expect((await readWorktreeReapStatus(runs)).last).toBeNull();
  });
});

describe('phm worktrees --reap --status', () => {
  const run = async (args: string[]) => {
    const lines: string[] = [];
    const code = await cmdWorktrees(args, { runsRoot: runs, output: { log: t => lines.push(t), error: t => lines.push(t) } });
    return { code, text: lines.join('\n') };
  };

  it('prints typed JSON with a schema id, showing never-run as null', async () => {
    const { code, text } = await run(['--reap', '--status', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(text)).toMatchObject({ schema: 'worktrees.reap-status.v1', off: false, last: null, lastNote: 'never-run', cap: 25 });
  });

  it('prints plain words after a run', async () => {
    const { deps } = fixture(60, 5);
    await tick(deps);
    const { text } = await run(['--reap', '--status']);
    expect(text).toContain('removed 25');
    expect(text).toContain('5 open pr');
    expect(text).toContain('Freed: 25 MB.');
  });

  it('rejects --status without --reap or beside --apply', async () => {
    const spy = vi.fn();
    for (const args of [['--status'], ['--reap', '--status', '--apply']]) {
      expect((await cmdWorktrees(args, { runsRoot: runs, output: { log: spy, error: spy } }))).toBe(2);
    }
  });
});
