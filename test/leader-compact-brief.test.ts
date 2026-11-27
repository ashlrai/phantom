import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { compactBriefLines, LEADER_COMPACT_FILE, readCompactBrief, writeCompactBrief } from '../src/core/fleet/leader-compact-brief.js';
import { runSelfTick, SELF_TICK_STEP_ORDER, type SelfTickSteps } from '../src/core/fleet/self-tick.js';
import { cmdLeaderBrief } from '../src/cli/leader-brief.js';
import { groupHostFamilies } from '../src/core/fleet/host-families.js';
import * as hostFamilies from '../src/core/fleet/host-families.js';
import { localIso } from '../src/core/fleet/runs-parked-queue.js';
import * as backlog from '../src/core/release/backlog.js';
import * as gitLatency from '../src/core/fleet/git-merge-latency.js';
let dir: string;
const now = Date.parse('2026-11-21T12:00:00Z'), at = new Date(now).toISOString();
beforeEach(async () => {
  vi.spyOn(backlog, 'readReleaseBacklog').mockResolvedValue({ schema: 'phantom.release-backlog.v1', checkedAt: at, counts: { ok: 1, due: 2, stale: 3, unknown: 1 }, repos: [] });
  vi.spyOn(gitLatency, 'readGitMergeLatency').mockResolvedValue(gitLatency.mergeLatencyFromGit([], [], now / 1000));
  vi.spyOn(hostFamilies, 'readHostFamilies').mockResolvedValue(groupHostFamilies(null));
  dir = await mkdtemp(join(tmpdir(), 'leader-brief-'));
  vi.stubEnv('ASHLR_RUNS_DIR', dir); vi.stubEnv('ASHLR_JOBS_STOP_FILE', join(dir, 'stops.tsv'));
  await mkdir(join(dir, 'queue')); await mkdir(join(dir, 'metrics'));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
it.each([50, 51])('shows leftover load only above fifty percent: %s', async cpu => {
  const host = groupHostFamilies(`10 1 ${cpu} 1024 00:01 tsgo plainword`, {
    worktreeRoot: '/root', cwds: new Map([[10, '/root/done']]), liveJobs: new Map([['done', false]]),
  });
  const brief = await readCompactBrief(dir, now, async () => host);
  expect(compactBriefLines(brief).some(line => line.includes('leftover processes from finished jobs'))).toBe(cpu > 50);
  expect(JSON.stringify(brief.hostLoad)).not.toContain('"items"');
});
it('carries I/O wait names into the typed brief, saved JSON and plain output', async () => {
  const table = `PID PPID %CPU RSS STAT ELAPSED ${'COMM'.padEnd(32)} COMMAND\n` +
    `10 1 1 1024 U 00:01 ${''.padEnd(32)} /usr/libexec/fseventsd hiddenword`;
  const host = groupHostFamilies(table, undefined, { load1: 77, cores: 18 });
  const brief = await readCompactBrief(dir, now, async () => host);
  expect(brief.hostLoad.ioWait).toEqual([{ name: 'fseventsd', processes: 1 }]);
  expect(compactBriefLines(brief)).toContain('io-wait: fseventsd 1');
  expect(compactBriefLines(brief)).toContain('load1 77 on 18 cores: load is mostly I/O wait (fseventsd 1)');
  vi.mocked(hostFamilies.readHostFamilies).mockResolvedValue(host);
  await writeCompactBrief(dir, now);
  const saved = await readFile(join(dir, LEADER_COMPACT_FILE), 'utf8');
  expect(JSON.parse(saved).hostLoad.ioWait).toEqual(brief.hostLoad.ioWait);
  expect(saved).not.toMatch(/hiddenword|\/usr\/libexec|unnamed/);
});
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
  expect(compactBriefLines(b)).toContain('Release: 2 due, 3 stale, 1 unknown');
  expect(compactBriefLines(b)).toContain(host.blame);
  expect(b.hostLoad.families).toHaveLength(8); expect(b.hostLoad.omitted).toBe(0);
  expect(Buffer.byteLength(JSON.stringify(b))).toBeLessThan(8192);
  expect(b.families[0]).toMatchObject({ family: 'empty-*', launches: 6, prs: 0, empty: 6 });
  expect(b.lanes[0]).toMatchObject({ running: 2, queued: 1, target: 4, held: false, emptyRate: 0 });
  expect(b.pools.find(p => p.pool === 'local')).toMatchObject({ usedPct: 40, burnPerHour: 2, safeBurn: 6, verdict: 'ok' });
  expect(b.stopped[0]).toMatchObject({ until: now / 1000 + 60 }); expect(b.omitted).toBeGreaterThan(0);
  expect(compactBriefLines(b).length).toBeGreaterThanOrEqual(10); expect(compactBriefLines(b).length).toBeLessThanOrEqual(19);
});
it('counts queued supply by the market-resolved lane hint and reports lane-open rows', async () => {
  await writeFile(join(dir, 'queue/slots.json'), JSON.stringify({
    personal: { target: 20, held: false }, gemini: { target: 4, held: false }, local: { target: 2, held: false },
  }));
  await writeFile(join(dir, 'queue/status.json'), JSON.stringify({
    last_tick: at, paused: false,
    lanes: { personal: { running: 1 }, gemini: { running: 0 }, local: { running: 0 } },
  }));
  await writeFile(join(dir, 'queue/router-queue.md'), [
    '- READY phantom RQ-ENV (preferred_lane=gemini): hinted work',
    '- READY phantom RQ-ENVALPHA (preferred_lane=personal): back on the column lane anyway',
    '- READY phantom RQ-ENVBAD (preferred_lane=CLAUDE!): rejected spec',
  ].join('\n'));
  await writeFile(join(dir, 'queue/ready.tsv'), [
    // requirements preferred_lane beats the lane column
    'RQ-HINTED\tphantom\tpersonal\twork\tplain\t{"preferred_lane":"gemini"}',
    // spec-less rows resolve their router-queue.md envelope the same way
    'RQ-ENV\tphantom\tpersonal\twork\tplain',
    'RQ-ENVALPHA\tphantom\tpersonal\twork\tplain',
    'RQ-ENVLONE\tphantom\tpersonal\twork\tplain',
    // explicit null and empty lane cells are lane-open shared supply
    'RQ-OPEN1\tphantom\t\twork\tplain',
    'RQ-OPEN2\tphantom\tpersonal\twork\tplain\t{"preferred_lane":null}',
    // a hint naming no snapshot lane is unattributed, never open supply
    'RQ-GHOST\tphantom\tpersonal\twork\tplain\t{"preferred_lane":"ghost"}',
    // market-rejected rows and parked rows are dead work, never queued
    'RQ-ENVBAD\tphantom\tpersonal\twork\tplain',
    'RQ-BADTIER\tphantom\tpersonal\tbogus\tplain',
    'PARKED-DEP.personal\tparked\tpersonal\twork\tplain',
  ].join('\n'));
  const b = await readCompactBrief(dir, now);
  expect(b.openRows).toBe(2);
  expect(b.lanes).toEqual(expect.arrayContaining([
    expect.objectContaining({ lane: 'personal', queued: 2, queuedReady: 2 }),
    expect.objectContaining({ lane: 'gemini', queued: 2, queuedReady: 2 }),
    expect.objectContaining({ lane: 'local', queued: 0, queuedReady: 0 }),
  ]));
  // personal still starves (2 hinted + 2 open cannot fill 19 free slots),
  // gemini and local do not (open supply could fill their free slots).
  expect(b.headline).toBe('personal 1/20 running, 2 queued +2 lane-open: supply-starved');
  // Open supply means "0 ready jobs" is unproven for the empty local lane.
  expect(b.whyIdle).toEqual([]);
  expect(compactBriefLines(b)).toContain(`Leader: ready (${b.at}); lanes: 3; pools: ${b.pools.length}; lane-open ready: 2`);
  // Without lane-open rows the same empty lane is explained as out of work.
  await writeFile(join(dir, 'queue/ready.tsv'), [
    'RQ-HINTED\tphantom\tpersonal\twork\tplain\t{"preferred_lane":"gemini"}',
    'RQ-ENV\tphantom\tpersonal\twork\tplain',
    'RQ-ENVALPHA\tphantom\tpersonal\twork\tplain',
    'RQ-ENVLONE\tphantom\tpersonal\twork\tplain',
  ].join('\n'));
  const dry = await readCompactBrief(dir, now);
  expect(dry.openRows).toBe(0);
  expect(dry.headline).toBe('personal 1/20 running, 2 queued: supply-starved');
  expect(dry.whyIdle).toContain('Local models: 2 free spots, 0 ready jobs');
});
it('reports starvation when duplicate ready rows would otherwise fill the lane', async () => {
  await writeFile(join(dir, 'queue/slots.json'), JSON.stringify({ personal: { target: 4 } }));
  await writeFile(join(dir, 'queue/status.json'), JSON.stringify({
    last_tick: at, paused: false, lanes: { personal: { running: 0, held: false } },
  }));
  await writeFile(join(dir, 'queue/ready.tsv'), [
    'RQ-A\tphantom\tpersonal\tbogus\tplain',
    'RQ-A\tphantom\t\twork\tplain',
    'RQ-A\tphantom\tpersonal\twork\tplain',
    'RQ-B\tphantom\tpersonal\twork\tplain',
    'RQ-B\tphantom\t\twork\tplain',
  ].join('\n'));

  const brief = await readCompactBrief(dir, now);
  expect(brief.openRows).toBe(1);
  expect(brief.lanes[0]).toMatchObject({ lane: 'personal', queued: 1, queuedReady: 1 });
  expect(brief.headline).toBe('personal 0/4 running, 1 queued +1 lane-open: supply-starved');
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
it('shows active automatic stops in plain words and carries them in the self-tick summary', async () => {
  const stop = { family: 'red', until: now / 1000 + 12 * 3600, why: 'auto_0of12_merged_12_empty_red' };
  await writeFile(join(dir, 'queue/family-stop.tsv'), `^red[0-9]+$\t${stop.until}\tauto_0of12_merged_12_empty_red\n^old$\t${now / 1000}\tauto_0of3_merged_3_empty_old\n`);
  const brief = await readCompactBrief(dir, now);
  expect(brief.stopped).toHaveLength(1);
  expect(compactBriefLines(brief)).toContain("Stopped 'red' for 12 h: 0 of 12 merged");
  const steps = Object.fromEntries(SELF_TICK_STEP_ORDER.map(s => [s, async () => ({ exitCode: 0, output: JSON.stringify({ familyStops: [stop] }) })])) as SelfTickSteps;
  expect((await runSelfTick({ runsDir: dir, now: () => now, steps })).report.familyStops).toEqual([stop]);
  expect(JSON.parse(await readFile(join(dir, 'queue/self-tick-last.json'), 'utf8')).familyStops).toEqual([stop]);
});
it('uses actual merge times and keeps only the five oldest stuck jobs', async () => {
  await writeFile(join(dir, 'metrics/jobs.jsonl'), JSON.stringify({ event: 'outcome', job: 'old', state: 'MERGED', ts: at, url: 'https://github.com/ashlrai/phantom/pull/7', createdAt: '2026-11-21T10:00:00Z', mergedAt: at }));
  await writeFile(join(dir, 'queue/live-jobs.json'), JSON.stringify({ known: true, running: Array.from({ length: 8 }, (_, i) => ({ id: `job-${i}`, lane: 'local', state: i === 7 ? 'quiet' : 'stuck', elapsed: i })) }));
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
    expect(brief.hostLoadWarning).toBe('Mac busy with docker and chrome (load 45, fleet about 0, CPU-share estimate): starts slowed');
    expect(compactBriefLines(brief)[1]).toBe(brief.hostLoadWarning);
  } else {
    expect(brief.hostLoadWarning).toBeNull(); expect(compactBriefLines(brief).join('\n')).not.toContain('starts slowed');
  }
});

it('ranks 24-hour EMPTY token waste and preserves unknown usage', async () => {
  const rows = [
    { job: 'alpha-1', tokens_total: 100 }, { job: 'alpha-2', tokens_total: 50 },
    { job: 'alpha-3' }, { job: 'beta-1', tokens: 80 }, { job: 'gamma-1', total_tokens: 0 },
    { job: 'delta-1' },
  ].map(row => ({ ...row, event: 'finish', empty: true, ts: at }));
  rows.push({ job: 'beta-2', tokens_total: 900, event: 'finish', empty: true, ts: new Date(now - 25 * 3600_000).toISOString() });
  await writeFile(join(dir, 'metrics/jobs.jsonl'), rows.map(r => JSON.stringify(r)).join('\n'));
  const brief = await readCompactBrief(dir, now);
  expect(brief.emptyTokenFamilies).toEqual([
    { family: 'alpha-*', tokens: 150, unknownJobs: 1, jobs: 3 },
    { family: 'beta-*', tokens: 80, unknownJobs: 0, jobs: 1 },
    { family: 'gamma-*', tokens: 0, unknownJobs: 0, jobs: 1 },
    { family: 'delta-*', tokens: null, unknownJobs: 1, jobs: 1 },
  ]);
  expect(compactBriefLines(brief)).toEqual(expect.arrayContaining([
    'alpha-*: 150 EMPTY tokens (24h), 1 jobs with unknown usage',
    'beta-*: 80 EMPTY tokens (24h), 0 jobs with unknown usage',
    'gamma-*: 0 EMPTY tokens (24h), 0 jobs with unknown usage',
  ]));
});
it('reads produced open PR counts and reports a failed refresh as unknown', async () => {
  const { refreshOpenPrs } = await import('../src/core/fleet/open-prs.js');
  const run = async () => ({ stdout: '[{"number":7}]', stderr: '', code: 0, timedOut: false, truncated: false, missing: false });
  await refreshOpenPrs(dir, 'ashlrai/phantom', now, run);
  const b = await readCompactBrief(dir, now);
  expect(b.openPrs).toBe(1); expect(compactBriefLines(b)).toContain('Open PRs: 1');
  await refreshOpenPrs(dir, 'ashlrai/phantom', now, async () => ({ ...await run(), code: 1 }));
  const failed = await readCompactBrief(dir, now);
  expect(failed.openPrs).toBeNull(); expect(compactBriefLines(failed)).toContain('Open PRs: unknown');
});
