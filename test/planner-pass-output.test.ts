import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPlannerPassOutput, summarizePlannerPassOutput } from '../src/core/fleet/planner-pass-output.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'pass-output-')); roots.push(root);
  const runsRoot = join(root, 'runs'), home = join(root, 'home');
  const claude = join(runsRoot, 'leader', 'drop', 'claude'), done = join(runsRoot, 'leader', 'drop', 'done');
  const sol = join(home, 'Projects', 'ashlrai', '.orch-drop', 'sol');
  await Promise.all([claude, done, sol].map((dir) => mkdir(dir, { recursive: true })));
  return { runsRoot, home, claude, done, sol };
}
async function touch(path: string, ms: number) {
  await writeFile(path, 'fixture');
  await utimes(path, new Date(ms), new Date(ms));
}

describe('planner pass output', () => {
  it('reads inclusive local-time ledger and file windows, tracking invalid ids', async () => {
    const dirs = await setup();
    const start = new Date(2026, 0, 15, 12, 0, 0).getTime();
    const end = start + 60_000;
    await writeFile(join(dirs.runsRoot, 'leader', 'drop', 'ingested.tsv'), [
      '2026-01-15 11:59:59\tRQ-PHX-OLD\tclaude\tclaude\twork\told',
      '2026-01-15 12:00:00\tRQ-PHX-ONE\tclaude\tclaude\twork\tfixture',
      '2026-01-15 12:01:00\tRQ-PHX-TWO\tsol\tcodex-personal\tfast\tfixture',
      '2026-01-15 12:01:01\tRQ-PHX-LATE\tsol\tclaude\twork\tfixture',
      '2026-01-15 12:00:00\tRQ-PHX-bad\tsol\tclaude\twork\tfixture',
    ].join('\n') + '\n');
    await Promise.all([
      touch(join(dirs.claude, 'RQ-PHX-THREE.md'), start),
      touch(join(dirs.sol, 'RQ-PHX-FOUR.md'), end),
      touch(join(dirs.done, 'RQ-PHX-FIVE.md.denied-path'), end),
      touch(join(dirs.done, 'RQ-PHX-OUT.md.denied-path'), end + 1000),
      touch(join(dirs.claude, 'RQ-PHX-bad.md'), start),
    ]);
    const view = await readPlannerPassOutput({ ...dirs, sinceMs: start, untilMs: end, now: () => end + 5000 });
    expect(view.ingested.map((row) => row.id)).toEqual(['RQ-PHX-ONE', 'RQ-PHX-TWO']);
    expect(view.ingested[0]?.at).toMatch(/^2026-01-15T12:00:00[+-]\d\d:\d\d$/);
    expect(view.pending).toEqual(expect.arrayContaining([
      { id: 'RQ-PHX-THREE', dropDir: dirs.claude, ageSeconds: 65 },
      { id: 'RQ-PHX-FOUR', dropDir: dirs.sol, ageSeconds: 5 },
    ]));
    expect(view.rejected).toEqual([{ id: 'RQ-PHX-FIVE', reason: 'denied-path', at: new Date(end).toISOString() }]);
    expect(view.sources).toMatchObject({ ledger: 'invalid', skipped: 2 });
    expect(view.sources.drops.map((s) => s.state)).toEqual(['ok', 'ok', 'ok']);
    expect(summarizePlannerPassOutput(view)).toBe('Pass wrote 5 jobs: 2 ingested, 2 pending, 1 rejected');
  });

  it('reports missing sources and an empty pass', async () => {
    const dirs = await setup();
    await rm(dirs.claude, { recursive: true });
    const view = await readPlannerPassOutput({ ...dirs, sinceMs: 0, untilMs: 1 });
    expect(view.sources.ledger).toBe('missing');
    expect(view.sources.drops[0]?.state).toBe('missing');
    expect(view.ingested).toEqual([]); expect(view.pending).toEqual([]); expect(view.rejected).toEqual([]);
    expect(summarizePlannerPassOutput(view)).toBe('Pass wrote no jobs');
  });

  it('marks a byte-truncated ledger invalid while preserving independent drops', async () => {
    const dirs = await setup();
    const start = new Date(2026, 0, 15, 12).getTime();
    await writeFile(join(dirs.runsRoot, 'leader', 'drop', 'ingested.tsv'), 'x'.repeat(4 * 1024 * 1024) + '\n2026-01-15 12:00:00\tRQ-PHX-ABC\tclaude\tclaude\twork\tfixture\n');
    await touch(join(dirs.sol, 'RQ-PHX-DEF.md'), start);
    const view = await readPlannerPassOutput({ ...dirs, sinceMs: start, untilMs: start });
    expect(view.sources.ledger).toBe('invalid');
    expect(view.ingested.map((row) => row.id)).toEqual(['RQ-PHX-ABC']);
    expect(view.pending.map((row) => row.id)).toEqual(['RQ-PHX-DEF']);
  });

  it('examines only the last 2000 ledger rows and rejects symlinks', async () => {
    const dirs = await setup();
    const start = new Date(2026, 0, 15, 12).getTime();
    const ledger = join(dirs.runsRoot, 'leader', 'drop', 'ingested.tsv');
    await writeFile(ledger, Array.from({ length: 2001 }, (_, i) => `2026-01-15 12:00:00\tRQ-PHX-${String(i).padStart(3, '0')}\tclaude\tclaude\twork\tfixture`).join('\n'));
    await symlink(ledger, join(dirs.claude, 'RQ-PHX-LINK.md'));
    const view = await readPlannerPassOutput({ ...dirs, sinceMs: start, untilMs: start });
    expect(view.ingested).toHaveLength(2000);
    expect(view.ingested.some((row) => row.id === 'RQ-PHX-000')).toBe(false);
    expect(view.sources.skipped).toBe(1);
  });
});
