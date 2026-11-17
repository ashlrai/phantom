import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { foldRouterOutcomes, readBoundedRouterFile, readRouterOutcomes } from '../src/core/router/outcomes.js';

it('joins URL outcomes, preserves unknowns, and tolerates malformed rows', () => {
  const rows = foldRouterOutcomes('broken\n' + [
    { job: 'job1', lane: 'opaque', model: 'model', pr: 'url' },
    { pr: 'url', phase: 'MERGED', ts: '2026-01-02' },
    { pr: 'url', state: 'CLOSED', ts: '2026-01-01' },
    { job: 'job2', review_findings: { fixed: 0, rejected: 1, ignored: 2 }, ci_first_pass: false },
  ].map(r => JSON.stringify(r)).join('\n'));
  expect(rows[0]).toMatchObject({ merged: true, ci_first_pass: null, cost_usd: null, wall_s: null, passk: null, review_findings: null });
  expect(rows[1]).toMatchObject({ lane: null, merged: null, ci_first_pass: false, review_findings: { fixed: 0, rejected: 1, ignored: 2 } });
  expect(foldRouterOutcomes('')).toEqual([]);
});

it('reads only bounded regular ledgers and filters opaque lanes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-outcomes-'));
  try {
    await mkdir(join(root, 'metrics'));
    expect(await readRouterOutcomes({ runsDir: root, rootDir: root })).toEqual([]);
    const file = join(root, 'metrics/jobs.jsonl');
    await writeFile(file, JSON.stringify({ job_id: 'job', lane: 'opaque' }));
    expect(await readBoundedRouterFile(file, 1)).toBeNull();
    expect(await readRouterOutcomes({ runsDir: root, rootDir: root, lane: 'other' })).toEqual([]);
    expect(await readRouterOutcomes({ runsDir: root, rootDir: root, lane: 'opaque' })).toHaveLength(1);
    await rm(file);
    await symlink(join(root, 'source'), file);
    await writeFile(join(root, 'source'), JSON.stringify({ job: 'hidden' }));
    expect(await readRouterOutcomes({ runsDir: root, rootDir: root })).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('attaches published pass^k only for the matching lane and model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-passk-'));
  try {
    await mkdir(join(root, 'metrics'), { recursive: true });
    await mkdir(join(root, 'eval/passk'), { recursive: true });
    await writeFile(join(root, 'metrics/jobs.jsonl'), [
      { job: 'one', lane: 'opaque', model: 'model' }, { job: 'two', lane: 'opaque', model: 'other' },
    ].map(r => JSON.stringify(r)).join('\n'));
    const score = { lane: 'opaque', model: 'model', tasks: 1, trials: 4, passes: 2, pass1: 0.5, ci95: null, passAtK: 0.5, passPowK: 0.25 };
    const file = join(root, 'eval/passk/lane-scores.json');
    await writeFile(file, JSON.stringify({ schema: 'eval.lane-scores.v1', reportId: 'report', k: 2, lanes: [score] }));
    const rows = await readRouterOutcomes({ runsDir: root, rootDir: root });
    expect(rows[0].passk).toEqual(score);
    expect(rows[1].passk).toBeNull();
    await writeFile(file, 'invalid');
    expect((await readRouterOutcomes({ runsDir: root, rootDir: root }))[0].passk).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});
