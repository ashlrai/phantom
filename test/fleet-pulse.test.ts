import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cmdFleetPulse } from '../src/cli/fleet-pulse.js';
import { parseMainGuardianStatus } from '../src/core/fleet/main-health.js';
import { buildPulse, pulseText, readPulse, sparkText, type PulseInputs } from '../src/core/fleet/pulse.js';
import { buildThroughput } from '../src/core/fleet/throughput.js';
import { projectUsageSpend } from '../src/core/usage/spend.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const NOW = Date.parse('2026-11-17T12:00:00Z'), HOUR = 3_600_000, DAY = 24 * HOUR;
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const pr = (n: number) => `https://github.com/ashlrai/phantom/pull/${n}`;
const row = (event: string, minutesAgo: number, extra: Record<string, unknown>) => JSON.stringify({ event, ts: at(minutesAgo), ...extra });
/** One fake job: published, then merged `minutesToMerge` later. */
const merged = (n: number, minutesAgo: number, minutesToMerge: number) => [
  row('launch', minutesAgo + minutesToMerge + 5, { job: `RQ-FAKE-${n}`, lane: 'claude', repo: 'phantom' }),
  row('publish', minutesAgo + minutesToMerge, { job: `RQ-FAKE-${n}`, url: pr(n) }),
  row('outcome', minutesAgo, { job: `RQ-FAKE-${n}`, url: pr(n), state: 'MERGED', mergedAt: at(minutesAgo) }),
];
/** Three merges today (10 min each), one yesterday (30 min). */
const LEDGER = [...merged(1, 30, 10), ...merged(2, 90, 10), ...merged(3, 600, 10), ...merged(4, 1500, 30)].join('\n');
const jobs = (ledger: string | null) => ({
  day: buildThroughput({ ledger, now: NOW, hours: 24, by: 'repo', metricsPath: 'jobs.jsonl' }),
  dayBefore: buildThroughput({ ledger, now: NOW - DAY, hours: 24, by: 'repo', metricsPath: 'jobs.jsonl' }),
});
/** The guardian status carries local time. */
const local = (iso: string) => { const d = new Date(iso); return [[d.getFullYear(), d.getMonth() + 1, d.getDate()], [d.getHours(), d.getMinutes(), d.getSeconds()]].map((part, i) => part.map(n => String(n).padStart(2, '0')).join(i ? ':' : '-')).join(' '); };
const REPOS = ['phantom', 'locus', 'lexicon', 'stack', 'verse', 'secrets', 'plugin'];
const guardian = (red: string[] = []) => [`# Main guardian status (${local(at(5))})`,
  '| repo | branch | sha | state | checked | failing | fix jobs | nightly |', '|---|---|---|---|---|---|---|---|',
  ...REPOS.map((repo, i) => `| ${repo} | main | abcdef${i} | ${red.includes(repo) ? 'red' : 'green'} | ${local(at(5))} | ${red.includes(repo) ? 'lint' : ''} | | |`)].join('\n');
const main = (red: string[] = []) => ({ ...parseMainGuardianStatus(guardian(red), NOW), source: 'ok' as const, guardianOff: false });
const pace = (used: number, burn: number) => ({ use_it_all: { known: true, stale: false, used_pct: used, burn_pct_per_hour: burn, reset_at: new Date(NOW + 10 * HOUR).toISOString() } });
/** claude: 40% used, 5%/h for 10 h, so 10% unused. codex-cmp and zai finish on time. */
const STATUS = { schema: 'dispatchd.status.v1', last_tick: at(1), budget: { claude: pace(40, 5), 'codex-cmp': pace(50, 6), zai: pace(90, 2) } };
const releases = REPOS.map((repo, i) => ({ repo, tag: `v1.${i}.0`, publishedAt: new Date(NOW - (i + 1) * DAY - HOUR).toISOString() }));
const normal = (): PulseInputs => ({ jobs: jobs(LEDGER), main: main(), releases, spend: projectUsageSpend(STATUS, NOW) });
const EMPTY: PulseInputs = { jobs: null, main: null, releases: null, spend: null };

describe('buildPulse', () => {
  it('normal: five numbers with trends and plain lines', () => {
    const pulse = buildPulse(normal(), NOW);
    expect(pulse).toMatchObject({ schema: 'fleet.pulse.v1', v: 1, asOf: '2026-11-17T12:00:00.000Z', verdict: 'watch', headline: 'Watch: 1 pool will leave allowance unused.' });
    expect(pulse.mergesPerHour).toMatchObject({ value: 0.1, trend: 'up', better: true, line: '3 PRs merged in the last 24 hours, 1 the day before.' });
    expect(pulse.mergesPerHour.sparkline).toHaveLength(24);
    expect(pulse.mergesPerHour.sparkline.reduce((a, b) => a + b)).toBe(3);
    expect(pulse.medianMergeSeconds).toEqual({ value: 600, trend: 'down', better: true, line: 'Half of PRs merge within 10m 0s of publishing.' });
    expect(pulse.mainsGreen).toEqual({ value: 7, total: 7, red: [], trend: 'unknown', better: null, line: 'Every main branch is green.' });
    expect(pulse.daysSinceRelease).toMatchObject({ value: 7, worstRepo: 'plugin', trend: 'up', better: false, line: 'plugin last released 7 days ago (v1.6.0).' });
    expect(pulse.daysSinceRelease.repos.map(r => r.days)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(pulse.poolsOnPace).toMatchObject({ value: 2, measured: 3, trend: 'unknown', line: '2 of 3 pools on pace; claude will leave 10% unused.' });
  });

  it('empty: every number is null and says why, never 0', () => {
    const pulse = buildPulse(EMPTY, NOW);
    expect(pulse.verdict).toBe('unknown');
    expect(pulse.headline).toBe('Partly unknown: 5 numbers could not be read.');
    for (const field of [pulse.mergesPerHour, pulse.medianMergeSeconds, pulse.mainsGreen, pulse.daysSinceRelease, pulse.poolsOnPace]) {
      expect(field).toMatchObject({ value: null, trend: 'unknown', better: null });
      expect(field.line).toMatch(/^Unknown: /);
    }
    expect(pulse.mergesPerHour.sparkline).toEqual([]);
    expect(pulse.mainsGreen.total).toBeNull();
    expect(pulse.poolsOnPace.line).toBe('Unknown: the spend snapshot could not be read.');
    // An unreadable ledger and a stale spend snapshot stay unknown as well.
    const unread = buildPulse({ ...EMPTY, jobs: jobs(null), spend: projectUsageSpend(null, NOW) }, NOW);
    expect(unread.mergesPerHour.value).toBeNull();
    expect(unread.poolsOnPace.line).toBe('Unknown: the dispatcher status is missing or stale.');
    expect(pulseText(pulse)).toContain('? Pools on pace: unknown (the spend snapshot could not be read)');
  });

  it('one red main: verdict bad, named in the headline and the line', () => {
    const pulse = buildPulse({ ...normal(), main: main(['locus']) }, NOW);
    expect(pulse.verdict).toBe('bad');
    expect(pulse.headline).toBe('Not well: main is red on locus.');
    expect(pulse.mainsGreen).toMatchObject({ value: 6, total: 7, red: ['locus'], line: 'Red: locus.' });
  });

  it('a quiet day is bad; a release today hides the trend; unread releases are counted', () => {
    const quiet = buildPulse({ ...normal(), jobs: jobs(merged(9, 1500, 30).join('\n')) }, NOW);
    expect(quiet).toMatchObject({ verdict: 'bad', headline: 'Not well: no PR merged in the last 24 hours.' });
    expect(quiet.mergesPerHour).toMatchObject({ value: 0, trend: 'down', better: false });
    expect(quiet.medianMergeSeconds.value).toBeNull();
    const today = buildPulse({ ...normal(), releases: [{ repo: 'phantom', tag: 'v2.0.0', publishedAt: at(60) }, { repo: 'locus', tag: null, publishedAt: null }] }, NOW);
    expect(today.daysSinceRelease).toMatchObject({ value: 0, worstRepo: 'phantom', trend: 'unknown', line: 'phantom last released today (v2.0.0). 1 not known.' });
    const stale = buildPulse({ ...normal(), main: { ...main(), stale: true } }, NOW);
    expect(stale.mainsGreen.value).toBeNull();
  });

  it('good: everything known and fine', () => {
    const spend = projectUsageSpend({ ...STATUS, budget: { zai: pace(90, 2) } }, NOW);
    const pulse = buildPulse({ ...normal(), spend }, NOW);
    expect(pulse).toMatchObject({ verdict: 'good', headline: 'Doing well: 0.1 PRs merged per hour and every main is green.' });
    expect(pulse.poolsOnPace.line).toBe('1 of 1 pool on pace.');
  });

  it('draws the sparkline in eight levels', () => {
    expect(sparkText([0, 1, 2, 4])).toBe('▁▃▅█');
    expect(sparkText([0, 0])).toBe('▁▁');
  });
});

describe('readPulse and phm fleet pulse', () => {
  let runs: string;
  beforeEach(async () => { runs = await mkdtemp(join(tmpdir(), 'fleet-pulse-')); });
  afterEach(async () => { vi.restoreAllMocks(); await rm(runs, { recursive: true, force: true }); });
  const put = async (file: string, text: string) => { await mkdir(dirname(join(runs, file)), { recursive: true }); await writeFile(join(runs, file), text); };

  it('reads the ledger, guardian status, spend snapshot and releases once each', async () => {
    await put('metrics/jobs.jsonl', `${LEDGER}\n`);
    await put('supervisor/status-main-guardian.md', guardian(['stack']));
    await put('queue/status.json', JSON.stringify(STATUS));
    const asked: string[] = [];
    const run = async (argv: string[]) => {
      asked.push(argv[1]!);
      return argv[1]!.includes('/phantom/') ? { code: 0, stdout: JSON.stringify({ tag_name: 'v9.0.0', published_at: new Date(NOW - 3 * DAY).toISOString(), html_url: 'https://github.com/ashlrai/phantom/releases/tag/v9.0.0', draft: false, prerelease: false }) } : { code: 1, stdout: '' };
    };
    const pulse = await readPulse({ runsDir: runs, now: NOW, run });
    expect(asked).toContain('repos/ashlrai/phantom/releases/latest');
    expect(asked).toHaveLength(7);
    expect(pulse.mergesPerHour.value).toBe(0.1);
    expect(pulse.mainsGreen).toMatchObject({ value: 6, red: ['stack'] });
    expect(pulse.daysSinceRelease).toMatchObject({ value: 3, worstRepo: 'phantom', line: 'phantom last released 3 days ago (v9.0.0). 6 not known.' });
    expect(pulse.poolsOnPace.value).toBe(2);
  });

  it('an empty runs directory stays unknown and asks GitHub nothing', async () => {
    const run = vi.fn();
    const pulse = await readPulse({ runsDir: runs, now: NOW, run });
    expect(run).not.toHaveBeenCalled();
    expect(pulse.mainsGreen.value).toBeNull();
    expect(pulse.daysSinceRelease.value).toBeNull();
  });

  it('the desktop API serves the same pulse; GET only', async () => {
    await put('queue/status.json', JSON.stringify(STATUS));
    const api = createFleetRunsApi({ runsDir: runs, now: () => NOW }), path = '/api/verse/fleet/runs/pulse';
    const call = async (method: string) => {
      const req = Object.assign(Readable.from([]), { url: path, method, headers: {} }) as unknown as IncomingMessage;
      let status = 0, body: unknown = null;
      const res = { headersSent: false, writeHead(code: number) { status = code; }, end(text: string) { body = JSON.parse(text); } } as unknown as ServerResponse;
      expect(await api({ cfg: {}, token: 'fake', allowDispatch: false } as VerseApiContext, req, res, path, method)).toBe(true);
      return { status, body };
    };
    // No guardian status, so no repo is known and GitHub is not asked.
    expect(await call('GET')).toEqual({ status: 200, body: await readPulse({ runsDir: runs, now: NOW }) });
    expect((await call('POST')).status).toBe(405);
  });

  it('the Pulse strip API serves fleet.pulse.lanes.v1 from the ledger; GET only', async () => {
    await put('metrics/jobs.jsonl', `${LEDGER}\n`);
    const api = createFleetRunsApi({ runsDir: runs, now: () => NOW }), path = '/api/verse/fleet/runs/pulse/lanes';
    const call = async (method: string) => {
      const req = Object.assign(Readable.from([]), { url: path, method, headers: {} }) as unknown as IncomingMessage;
      let status = 0, body: unknown = null;
      const res = { headersSent: false, writeHead(code: number) { status = code; }, end(text: string) { body = JSON.parse(text); } } as unknown as ServerResponse;
      expect(await api({ cfg: {}, token: 'fake', allowDispatch: false } as VerseApiContext, req, res, path, method)).toBe(true);
      return { status, body };
    };
    const ok = await call('GET');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ schema: 'fleet.pulse.lanes.v1', window_h: 24, totals: { merged: 3 } });
    expect((await call('POST')).status).toBe(405);
  });

  it('prints text, JSON and usage', async () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(text => { out.push(String(text)); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const read = () => Promise.resolve(buildPulse(normal(), NOW));
    expect(await cmdFleetPulse([], read)).toBe(0);
    expect(out[0]!.split('\n')).toEqual([
      'Watch: 1 pool will leave allowance unused.',
      expect.stringMatching(/^↑ PRs merged per hour: 0\.1\. 3 PRs merged in the last 24 hours, 1 the day before\. [▁-█]{24}$/),
      '↓ Median publish to merge: 10m 0s. Half of PRs merge within 10m 0s of publishing.',
      '? Main branches green: 7 of 7. Every main branch is green.',
      '↑ Days since last release: 7 (plugin). plugin last released 7 days ago (v1.6.0).',
      '? Pools on pace: 2 of 3. 2 of 3 pools on pace; claude will leave 10% unused.',
    ]);
    expect(await cmdFleetPulse(['--json'], read)).toBe(0);
    expect(JSON.parse(out[1]!)).toMatchObject({ schema: 'fleet.pulse.v1', v: 1 });
    expect(await cmdFleetPulse(['--help'], read)).toBe(0);
    expect(out[2]).toMatch(/^Usage: phm fleet pulse \[--lanes \| --alerts \[--no-notify\]\] \[--json\]/);
    expect(await cmdFleetPulse(['--nope'], read)).toBe(2);
  });
});
