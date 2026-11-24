import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cmdHome } from '../src/cli/home.js';
import { homeText, readHome, readHomeSources, type HomeSummary } from '../src/core/fleet/home.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const NOW = Date.parse('2026-11-17T12:00:00Z'), pr = (n: number) => `https://github.com/ashlrai/phantom/pull/${n}`;
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
/** The guardian status carries local time. */
const local = (iso: string) => { const d = new Date(iso); return [[d.getFullYear(), d.getMonth() + 1, d.getDate()], [d.getHours(), d.getMinutes(), d.getSeconds()]].map((part, i) => part.map(n => String(n).padStart(2, '0')).join(i ? ':' : '-')).join(' '); };
const row = (event: string, minutesAgo: number, extra: Record<string, unknown>) => JSON.stringify({ event, ts: at(minutesAgo), ...extra });
/** One job on lane claude: launched, published and merged, with fake ids. */
const merged = (n: number, minutesAgo: number, minutesToMerge: number) => [
  row('launch', minutesAgo + minutesToMerge + 5, { job: `RQ-FAKE-${n}`, lane: 'claude', repo: 'phantom', tier: 'frontier' }),
  row('publish', minutesAgo + minutesToMerge, { job: `RQ-FAKE-${n}`, class: 'pr', url: pr(n) }),
  row('outcome', minutesAgo, { job: `RQ-FAKE-${n}`, url: pr(n), state: 'MERGED', mergedAt: at(minutesAgo) }),
];

let runs: string;
beforeEach(async () => { runs = await mkdtemp(join(tmpdir(), 'fleet-home-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(runs, { recursive: true, force: true }); });
const put = async (file: string, text: string) => { await mkdir(dirname(join(runs, file)), { recursive: true }); await writeFile(join(runs, file), text); };
/** A fixture fleet. `healthy` merged twice in the last hour; `stalled` last merged 3 hours ago; `red` has one red main. */
async function seed(kind: 'healthy' | 'stalled' | 'red') {
  const recent = kind === 'stalled' ? [] : [...merged(1, 10, 4), ...merged(2, 30, 6)];
  await put('metrics/jobs.jsonl', [...recent, ...merged(3, 180, 20)].join('\n') + '\n');
  await put('supervisor/status-main-guardian.md', [
    `# Main guardian status (${local(at(5))})`,
    '| repo | branch | sha | state | checked | failing | fix jobs | nightly |', '|---|---|---|---|---|---|---|---|',
    `| phantom | master | abcdef1 | ${kind === 'red' ? 'red' : 'green'} | ${local(at(5))} | ${kind === 'red' ? 'lint' : ''} | | |`,
    `| locus | main | abcdef2 | green | ${local(at(5))} | | | |`,
  ].join('\n'));
  // claude has used 40% with 10 hours to its weekly reset at 1% an hour: 50% would expire unused.
  await put('queue/status.json', JSON.stringify({ last_tick: at(1),
    lanes: { claude: { running: 3, target: 8, held: false }, grok: { running: 0, target: 1, held: false } },
    budget: { claude: { weekly_used_pct: 40, burn_pct_per_hour: 1, reset_at: new Date(NOW + 10 * 3_600_000).toISOString(), observed_at: at(1) } } }));
  await put('leader/PLAN-LOG.md', `# Plan log\n\n## ${at(20)} planning pass\n\n**Reply for Mason**: "Second fake reply."\n\n## ${at(200)} planning pass\n\n**Reply for Mason**: "First fake reply."\n`);
}
const read = (leaderSeenMs: number | null = NOW - 60 * 60_000) => readHome({ runsDir: runs, now: NOW, leaderSeenMs }), UNKNOWN = { state: 'unknown' };
describe('phm home', () => {
  it('healthy: merges, median, green mains, lanes, the resource at risk, the work log and unread replies', async () => {
    await seed('healthy');
    const home = await read();
    expect(home).toMatchObject({
      schema: 'home.v1', asOf: '2026-11-17T12:00:00.000Z', health: 'healthy', headline: 'Healthy: 2 PRs merged in the last hour and main is green.',
      mergedLastHour: { state: 'ok', value: 2 }, merged24h: { state: 'ok', value: 3 }, medianMergeSeconds: { state: 'ok', value: 360 },
      main: { state: 'ok', value: [{ repo: 'phantom', state: 'green' }, { repo: 'locus', state: 'green' }] },
      running: { state: 'ok', value: [{ lane: 'claude', running: 3, target: 8 }, { lane: 'grok', running: 0, target: 1 }] },
      atRisk: { state: 'ok', value: { resource: 'claude', percentUnused: 50, usedPercent: 40, burnPctPerHour: 1, resetAt: '2026-11-17T22:00:00.000Z' } },
      unreadLeaderReplies: { state: 'ok', value: 1 }, needsYou: { state: 'ok', value: [] },
    });
    const log = home.worklog.state === 'ok' ? home.worklog.value : [];
    expect(log).toHaveLength(5);
    expect(log.map(item => item.at)).toEqual(log.map(item => item.at).sort().reverse());
    expect(log.some(item => item.kind === 'leader' && item.text.includes('Second fake reply.'))).toBe(true);
    // Stable JSON: the same fleet at the same instant is the same bytes, with a fixed key order.
    expect(JSON.stringify(await read())).toBe(JSON.stringify(home));
    expect(Object.keys(home)).toEqual(['schema', 'asOf', 'health', 'headline', 'mergedLastHour', 'merged24h', 'medianMergeSeconds', 'main', 'running', 'atRisk', 'worklog', 'unreadLeaderReplies', 'needsYou']);
    expect(JSON.stringify(home)).not.toContain(runs);
    expect(homeText(home)).toEqual(expect.arrayContaining(['Merged, last hour: 2', 'Median time to merge: 6m 0s', 'Main: phantom green, locus green', 'Running jobs: claude 3 of 8, grok 0 of 1', 'Unread Leader replies: 1']));
  });
  it('stalled: no merge in 60 minutes is said plainly, and the 24 hour count still shows', async () => {
    await seed('stalled');
    expect(await read()).toMatchObject({ health: 'stalled', headline: 'Stalled: no PR merged in the last 60 minutes.', mergedLastHour: { state: 'ok', value: 0 }, merged24h: { state: 'ok', value: 1 } });
  });
  it('red main: names the red repo and outranks everything else', async () => {
    await seed('red');
    expect(await read()).toMatchObject({ health: 'red', headline: 'Main is red on phantom.', main: { state: 'ok', value: [{ repo: 'phantom', state: 'red' }, { repo: 'locus', state: 'green' }] } });
  });
  it('quiet fleet: nothing running, nothing merged and nothing asked are plain zeros, not unknown', async () => {
    await seed('stalled');
    await put('metrics/jobs.jsonl', '');
    await put('queue/status.json', JSON.stringify({ last_tick: at(1), lanes: { claude: { running: 0, target: 8, held: false } } }));
    expect(await read()).toMatchObject({ health: 'stalled', mergedLastHour: { state: 'ok', value: 0 }, merged24h: { state: 'ok', value: 0 },
      running: { state: 'ok', value: [{ lane: 'claude', running: 0, target: 8 }] }, main: { state: 'ok' }, needsYou: { state: 'ok', value: [] } });
  });
  it('needs you: open asks come with their one-word answers, oldest first; other ledger lines and answered asks stay out', async () => {
    await seed('healthy');
    await put('NEEDS-MASON.md', `- ask:2fa Enter the fake 2FA code (asked ${at(4)})\n- Decide the fake rollout order\n- ask:payment Pay the fake invoice\n`);
    const home = await read(), asks = home.needsYou.state === 'ok' ? home.needsYou.value : [];
    expect(asks).toEqual([
      { id: expect.stringMatching(/^nm-[0-9a-f]{12}$/), shortId: expect.any(String), kind: '2fa', request: 'Enter the fake 2FA code', ageSeconds: 240, answers: ['yes', 'no', 'done', 'later'] },
      { id: expect.stringMatching(/^nm-[0-9a-f]{12}$/), shortId: expect.any(String), kind: 'payment', request: 'Pay the fake invoice', ageSeconds: null, answers: ['yes', 'no', 'done', 'later'] },
    ]);
    expect(home.health).toBe('healthy');
    expect(homeText(home)).toContain(`Needs you: Enter the fake 2FA code (yes, no, done, later ${asks[0]!.shortId}); Pay the fake invoice (yes, no, done, later ${asks[1]!.shortId})`);
    expect(homeText(await readHome({ runsDir: runs, now: NOW, read: async (dir, now) => ({ ...await readHomeSources(dir, now), asks: null }) }))).toContain('Needs you: unknown (The needs-you ledger could not be read.)');
  });
  it('reads through an injectable reader, so a fixture stands in for every source', async () => {
    const seen: unknown[] = [];
    const home = await readHome({ runsDir: '/fake/runs', now: NOW, read: async (dir, now) => { seen.push([dir, now]); return { throughput: null, main: null, ledger: null, worklog: null, asks: { schema: 'asks.v1', asOf: at(0), ledger: 'available', count: 1, fleetDecides: 0,
      asks: [{ id: 'nm-0123456789ab', shortId: '0123', kind: 'device', request: 'Approve the fake device', created: null, ageSeconds: null }] } }; } });
    expect(seen).toEqual([['/fake/runs', NOW]]);
    expect(home).toMatchObject({ schema: 'home.v1', health: 'unknown', running: UNKNOWN, main: UNKNOWN, needsYou: { state: 'ok', value: [{ id: 'nm-0123456789ab', request: 'Approve the fake device', answers: ['yes', 'no', 'done', 'later'] }] } });
  });
  it('all sources missing: every field is unknown with a reason, never zero', async () => {
    const home = await read();
    expect(home).toMatchObject({ health: 'unknown', mergedLastHour: UNKNOWN, merged24h: UNKNOWN, medianMergeSeconds: UNKNOWN, main: UNKNOWN, running: UNKNOWN, atRisk: UNKNOWN, worklog: UNKNOWN, unreadLeaderReplies: UNKNOWN, needsYou: { state: 'ok', value: [] } });
    expect(home.headline).toBe('Unknown: The job metrics file could not be read.');
    for (const field of [home.mergedLastHour, home.main, home.running, home.atRisk, home.worklog, home.unreadLeaderReplies]) expect(field).toEqual({ state: 'unknown', reason: expect.stringMatching(/\w+\.$/) });
    expect(homeText(home)).toContain('Main: unknown (The main guardian status could not be read.)');
  });
  it('counts unread replies only against a given last-read time, and a stale guardian status is unknown', async () => {
    await seed('healthy');
    expect((await read(null)).unreadLeaderReplies).toEqual({ state: 'unknown', reason: 'No last-read time was given, so replies cannot be counted as unread.' });
    expect((await read(NOW - 24 * 3_600_000)).unreadLeaderReplies).toEqual({ state: 'ok', value: 2 });
    expect((await read(NOW)).unreadLeaderReplies).toEqual({ state: 'ok', value: 0 });
    expect(await readHome({ runsDir: runs, now: NOW + 45 * 60_000 })).toMatchObject({ health: 'unknown', main: { state: 'unknown', reason: 'The main guardian status is more than 30 minutes old.' } });
    await put('supervisor/status-main-guardian.md', `# Main guardian status (${local(at(5))})\n| repo | branch | sha | state |\n|---|---|---|---|\n| phantom | master | abcdef1 | pending |\n`);
    expect(await read()).toMatchObject({ health: 'unknown', headline: 'Unknown: Main is not known for phantom.', mergedLastHour: { state: 'ok', value: 2 } });
  });
  it('the CLI prints the summary as text or JSON and rejects unknown options', async () => {
    await seed('healthy');
    const home = await read();
    const out = vi.spyOn(console, 'log').mockImplementation(() => {}), err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: (number | null)[] = [], fake = async (leaderSeenMs: number | null) => { seen.push(leaderSeenMs); return home; };
    expect(await cmdHome(['--json', '--leader-seen', '2026-11-17T11:00:00Z'], fake)).toBe(0);
    expect(JSON.parse(String(out.mock.calls.at(-1)![0]))).toEqual(home);
    expect(await cmdHome([], fake)).toBe(0);
    expect(String(out.mock.calls.at(-1)![0]).split('\n')[0]).toBe(home.headline);
    expect(seen).toEqual([NOW - 3_600_000, null]);
    expect([await cmdHome(['--help'], fake), await cmdHome(['--leader-seen', 'soon'], fake), await cmdHome(['--watch'], fake)]).toEqual([0, 2, 2]);
    expect(err).toHaveBeenCalledTimes(2);
  });
  it('serves the same summary to the desktop Home view', async () => {
    await seed('healthy');
    const api = createFleetRunsApi({ runsDir: runs, now: () => NOW }), path = '/api/verse/fleet/runs/home';
    const call = async (query: string, method = 'GET') => {
      const req = Object.assign(Readable.from([]), { url: path + query, method, headers: {} }) as unknown as IncomingMessage;
      let status = 0, body: unknown = null;
      const res = { headersSent: false, writeHead(code: number) { status = code; }, end(text: string) { body = JSON.parse(text); } } as unknown as ServerResponse;
      expect(await api({ cfg: {}, token: 'fake-token', allowDispatch: false } as VerseApiContext, req, res, path, method)).toBe(true);
      return { status, body: body as HomeSummary };
    };
    expect(await call(`?leaderSeen=${NOW - 3_600_000}`)).toEqual({ status: 200, body: await read() });
    expect((await call('')).body.unreadLeaderReplies.state).toBe('unknown');
    expect((await call('', 'POST')).status).toBe(405);
  });
});
