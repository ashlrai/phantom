import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { compactBriefLines, LEADER_COMPACT_FILE, readCompactBrief } from '../src/core/fleet/leader-compact-brief.js';
import { runSelfTick, SELF_TICK_STEP_ORDER, type SelfTickSteps } from '../src/core/fleet/self-tick.js';
import { cmdLeaderBrief } from '../src/cli/leader-brief.js';
import { groupHostFamilies } from '../src/core/fleet/host-families.js';
import * as hostFamilies from '../src/core/fleet/host-families.js';
import { localIso } from '../src/core/fleet/runs-parked-queue.js';
import * as gitLatency from '../src/core/fleet/git-merge-latency.js';
let dir: string;
const now = Date.parse('2026-11-21T12:00:00Z'), at = new Date(now).toISOString();
beforeEach(async () => {
  vi.spyOn(gitLatency, 'readGitMergeLatency').mockResolvedValue(gitLatency.mergeLatencyFromGit([], [], now / 1000));
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
it('reads the last bounded tick, slot holds and ready supply for the headline', async () => {
  const stamp = localIso(new Date(now)).slice(0, 19).replace('T', ' ');
  const tick = (running: number) => `${stamp} tick run={"personal":${running},"local":1} q=2 launched=0 reap=0 pause=False wall=1s\n`;
  await writeFile(join(dir, 'dispatchd.log'), 'plain\n'.repeat(50_000) + tick(9) + tick(3) + 'plain\n');
  await writeFile(join(dir, 'queue/slots.json'), JSON.stringify({ personal: { target: 20, held: false }, local: { target: 8, held: false, pause_new_until: now / 1000 + 60 } }));
  await writeFile(join(dir, 'queue/ready.tsv'), 'first\tphantom\tpersonal\twork\tplain\nsecond\tphantom\tpersonal\twork\tplain\nparked\tphantom\tPARKED-DEP.personal\twork\tplain\n');
  const b = await readCompactBrief(dir, now);
  expect(b.lanes).toEqual(expect.arrayContaining([
    expect.objectContaining({ lane: 'personal', running: 3, target: 20, held: false, queuedReady: 2 }),
    expect.objectContaining({ lane: 'local', running: 1, held: true, pause_new_until: now / 1000 + 60 }),
  ]));
  expect(b.headline).toBe('personal 3/20 running, 2 queued: supply-starved');
  expect(compactBriefLines(b)[0]).toBe(b.headline);
  expect(Buffer.byteLength(JSON.stringify(b))).toBeLessThan(8192);
  await writeFile(join(dir, 'dispatchd.log'), tick(3) + 'plain tick run=broken\n');
  expect((await readCompactBrief(dir, now)).sources['dispatchd.log']).toMatchObject({ state: 'unknown', why: expect.stringContaining('no valid tick') });
  await writeFile(join(dir, 'dispatchd.log'), tick(3));
  const stale = await readCompactBrief(dir, now + 121_000);
  expect(stale.lanes[0]?.running).toBeNull(); expect(stale.lanes[1]?.held).toBe(false);
  expect(stale.headline).toBe('No measured supply-starved lane');
});
it.each(['file', 'ledger', 'snapshot'])('uses %s opening evidence with actual merge times, deduplicating PRs', async basis => {
  const url = 'https://github.com/ashlrai/phantom/pull/7', opened = new Date(now - 3_600_000);
  const merged = { job: 'plain', state: 'MERGED', url, mergedAt: at, ts: at };
  const rows: object[] = [merged, { ...merged, source: 'metrics-outcomes-reconciler', event: 'publish' }];
  rows.push({ ...merged, job: 'other', url: 'https://github.com/ashlrai/phantom/pull/8', createdAt: new Date(now - 7_200_000).toISOString() });
  if (basis === 'file') {
    await writeFile(join(dir, 'plain.publish'), `RESULT PR ${url}\n`);
    await utimes(join(dir, 'plain.publish'), opened, opened);
  } else if (basis === 'ledger') rows.unshift({ event: 'publish', job: 'plain', url, ts: opened.toISOString() });
  else {
    await mkdir(join(dir, 'fleet'));
    await writeFile(join(dir, 'fleet/open-prs.json'), JSON.stringify([{ url, createdAt: opened.toISOString(), mergedAt: at }]));
  }
  await writeFile(join(dir, 'metrics/jobs.jsonl'), rows.map(r => JSON.stringify(r)).join('\n'));
  const b = await readCompactBrief(dir, now);
  expect(b.medianOpenToMergeSeconds).toBe(5400);
  expect(b.mergeLatencySource).toContain(basis === 'file' ? '*.publish mtime' : basis === 'ledger' ? 'publication' : 'fleet/open-prs.json');
  expect(b.mergeLatencyWhy).toContain('2 merged PRs');
  if (basis !== 'snapshot') expect(b.sources['fleet/open-prs.json']).toMatchObject({ state: 'missing', why: 'file does not exist' });
});
it('explains degraded sources and refuses merge observations without mergedAt', async () => {
  await writeFile(join(dir, 'metrics/jobs.jsonl'), 'plain\n' + JSON.stringify({ event: 'merged', job: 'plain', url: 'https://github.com/ashlrai/phantom/pull/7', ts: at }));
  const b = await readCompactBrief(dir, now);
  expect(b.sources['metrics/jobs.jsonl']).toMatchObject({ state: 'degraded', why: expect.stringContaining('invalid') });
  expect(Object.values(b.sources).every(s => s.why.length > 0)).toBe(true);
  expect(b.medianOpenToMergeSeconds).toBeNull(); expect(b.mergeLatencyWhy).toContain('no publications paired');
});

it.each([
  [45, 36, 1, false, 0, true], [36, 36, 1, false, 0, false], [20, 36, 1, false, 0, false],
  [45, 36, 100, false, 0, false], [45, 36, 101, false, 0, false], [45, 36, 1, true, 0, false],
  [45, 36, 1, false, 120_000, false],
])('shows external load slowing starts only with fresh enabled load-gate evidence (%s, %s, %s)', async (load1, load_max, fleet, disabled, age, visible) => {
  await writeFile(join(dir, 'queue/status.json'), JSON.stringify({ last_tick: new Date(now - age).toISOString(), admission: { load1, load_max, disabled } }));
  const host = groupHostFamilies(`10 1 ${fleet} 1024 00:01 worker /repo/wt/plain\n20 1 60 1024 00:01 docker\n30 1 40 1024 00:01 chrome`);
  const brief = await readCompactBrief(dir, now, async () => host);
  if (visible) {
    expect(brief.hostLoadWarning).toBe('Mac busy with Docker/virtualization and browsers (load 45, fleet about 0): starts slowed');
    expect(compactBriefLines(brief)[1]).toBe(brief.hostLoadWarning);
  } else {
    expect(brief.hostLoadWarning).toBeNull(); expect(compactBriefLines(brief).join('\n')).not.toContain('starts slowed');
  }
});
