import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { compactBriefLines, LEADER_COMPACT_FILE, readCompactBrief } from '../src/core/fleet/leader-compact-brief.js';
import { runSelfTick, SELF_TICK_STEP_ORDER, type SelfTickSteps } from '../src/core/fleet/self-tick.js';
import { cmdLeaderBrief } from '../src/cli/leader-brief.js';
import { groupHostFamilies } from '../src/core/fleet/host-families.js';
import * as hostFamilies from '../src/core/fleet/host-families.js';
let dir: string;
const now = Date.parse('2026-11-21T12:00:00Z'), at = new Date(now).toISOString();
beforeEach(async () => {
  vi.spyOn(hostFamilies, 'readHostFamilies').mockResolvedValue(groupHostFamilies(null));
  dir = await mkdtemp(join(tmpdir(), 'leader-brief-'));
  vi.stubEnv('ASHLR_RUNS_DIR', dir); vi.stubEnv('ASHLR_JOBS_STOP_FILE', join(dir, 'stops.tsv'));
  await mkdir(join(dir, 'queue')); await mkdir(join(dir, 'metrics'));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
it('bounds 500 jobs, ranks zero PRs in six launches first, and reads status and ready rows', async () => {
  const rows: object[] = [];
  for (let i = 0; i < 500; i++) {
    const family = i < 6 ? 'empty' : `work${String.fromCharCode(97 + i % 26, 97 + Math.floor(i / 26))}`;
    const job = `${family}-${i}`;
    rows.push({ event: 'launch', job, lane: 'local', ts: at }, { event: 'finish', job, lane: 'local', ts: at, empty: i < 6 });
    if (i >= 6) rows.push({ event: 'publish', job, lane: 'local', ts: at, class: 'pr', url: `https://example.invalid/pr/${i}` });
  }
  await writeFile(join(dir, 'metrics/jobs.jsonl'), rows.map(r => JSON.stringify(r)).join('\n'));
  await writeFile(join(dir, 'queue/slots.json'), JSON.stringify({ local: { target: 4 } }));
  await writeFile(join(dir, 'queue/status.json'), JSON.stringify({ last_tick: at, paused: false, lanes: { local: { running: 2, held: false } }, budget: { local: { used_pct: 40, hours_to_reset: 10, burn_pct_per_hour: 2 } } }));
  await writeFile(join(dir, 'queue/ready.tsv'), 'waiting\tphantom\tlocal\twork\tplain\n');
  await writeFile(join(dir, 'stops.tsv'), `^empty.*$\t${now / 1000 + 60}\tquiet\n`);
  const host = groupHostFamilies(Array.from({ length: 8 }, (_, i) => `${100 + i} 1 5 1024 00:01 worker /repo/wt/RQ-WORK-${i}`).join('\n'));
  const b = await readCompactBrief(dir, now, async () => host);
  expect(b.hostLoad.families).toHaveLength(5); expect(b.hostLoad.omitted).toBe(3);
  expect(Buffer.byteLength(JSON.stringify(b))).toBeLessThan(8192);
  expect(b.families[0]).toMatchObject({ family: 'empty-*', launches: 6, prs: 0, empty: 6 });
  expect(b.lanes[0]).toMatchObject({ running: 2, queued: 1, target: 4, held: false, emptyRate: 0 });
  expect(b.pools[0]).toMatchObject({ usedPct: 40, burnPerHour: 2, safeBurn: 5.5, verdict: 'ok' });
  expect(b.stopped[0]).toMatchObject({ until: now / 1000 + 60 }); expect(b.omitted).toBeGreaterThan(0);
  expect(compactBriefLines(b).length).toBeGreaterThanOrEqual(10); expect(compactBriefLines(b).length).toBeLessThanOrEqual(15);
});
it('returns no data on an empty directory and writes a private snapshot each tick', async () => {
  expect(await readCompactBrief(dir, now)).toMatchObject({ state: 'no data', lanes: [], medianOpenToMergeSeconds: null });
  const steps = Object.fromEntries(SELF_TICK_STEP_ORDER.map(s => [s, async () => ({ exitCode: 0, output: '{}' })])) as SelfTickSteps;
  expect((await runSelfTick({ runsDir: dir, now: () => now, steps })).report.leaderBrief).toBe('written');
  expect(JSON.parse(await readFile(join(dir, LEADER_COMPACT_FILE), 'utf8')).at).toBe(at);
  expect((await stat(join(dir, LEADER_COMPACT_FILE))).mode & 0o777).toBe(0o600);
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdLeaderBrief(['--json', '--write', join(dir, 'copy.json')])).toBe(0);
  expect(JSON.parse(await readFile(join(dir, 'copy.json'), 'utf8'))).toEqual(JSON.parse(String(output.mock.calls[0]![0])));
});
it('uses actual merge times and keeps only the five oldest stuck jobs', async () => {
  await writeFile(join(dir, 'metrics/jobs.jsonl'), JSON.stringify({ event: 'outcome', job: 'old', state: 'MERGED', ts: at, url: 'https://github.com/ashlrai/phantom/pull/7', createdAt: '2026-11-21T10:00:00Z', mergedAt: at }));
  await writeFile(join(dir, 'queue/live-jobs.json'), JSON.stringify({ jobs: Array.from({ length: 8 }, (_, i) => ({ id: `job-${i}`, lane: 'local', status: i === 7 ? 'quiet' : 'stuck', elapsed: i })) }));
  const b = await readCompactBrief(dir, now);
  expect(b.medianOpenToMergeSeconds).toBe(7200); expect(b.attention.map(j => j.id)).toEqual(['job-6', 'job-5', 'job-4', 'job-3', 'job-2']);
  expect(b.families[0]).toMatchObject({ family: 'old', launches: 0, merges: 1 });
});
