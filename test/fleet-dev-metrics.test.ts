import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectLoopGithub, observeLoopPr, type LoopGh } from '../src/core/fleet/loop-github.js';
import { loopCosts, loopWindowEnd, parseCiTimes, parseLoopQueue } from '../src/core/fleet/loop-inputs.js';
import { emitLoopEvents, loopEvents, refreshLoopReport } from '../src/core/fleet/loop-report.js';
import { elapsed, LOOP_REPOS, percentiles, row, summarizeLoop, type LoopPr, type Row } from '../src/core/fleet/loop.js';
import { formatLoopReport } from '../src/cli/fleet-loop.js';

const now = Date.parse('2026-10-26T12:00:00Z');
const sha = 'a'.repeat(40);
const opened = '2026-10-25T09:00:00Z', ready = '2026-10-25T10:00:00Z', merged = '2026-10-25T11:00:00Z';
const pr = { number: 12, state: 'closed', draft: false, created_at: opened, updated_at: merged, merged_at: merged, head: { sha, ref: 'codex-bridge/RQ-LOOP-1' }, is_revert: false };
const queue = '| Repo | PR | Task | Queued at | Claimed at | Agent |\n| --- | --- | --- | --- | --- | --- |\n| phantom | #12 | RQ-LOOP-1 | 2026-10-25T08:00:00Z | 2026-10-25T08:30:00Z | codex-1 |';
const check = { id: 1, head_sha: sha, status: 'completed', conclusion: 'success', name: 'test', app: { slug: 'github-actions' }, started_at: ready, completed_at: '2026-10-25T10:02:00Z' };
function fakeGh(overrides: Partial<{ pulls: Row[]; timeline: Row[]; reviews: Row[]; checks: Row[]; statuses: Row[] }> = {}): LoopGh {
  return vi.fn(async args => {
    const endpoint = args[1]!;
    if (endpoint.includes('/pulls?')) return endpoint.includes('state=closed') && endpoint.includes('ashlrai/phantom/') ? overrides.pulls ?? [pr] : [];
    if (endpoint.includes('/timeline')) return overrides.timeline ?? [{ event: 'ready_for_review', created_at: ready }];
    if (endpoint.includes('/reviews')) return overrides.reviews ?? [{ state: 'APPROVED', submitted_at: '2026-10-25T10:10:00Z' }];
    if (endpoint.includes('/check-runs')) return { total_count: (overrides.checks ?? [check]).length, check_runs: overrides.checks ?? [check] };
    if (endpoint.includes('/statuses')) return overrides.statuses ?? [];
    throw new Error('unexpected fixture endpoint');
  });
}
function costFixture(): Row {
  return { schema: 'fleet.v1', preserved: { nested: true }, spend: {
    complete: true, window_start: new Date(now - 7 * 86400_000).toISOString(), window_end: new Date(now).toISOString(), entries: [
      { at: opened, pool: 'grok-ultra-weekly', usd: 2, points: 10, repo: 'ashlrai/phantom', pr: 12, agent: 'grok-worker' },
      { at: opened, pool: 'codex-cmp', usd: 3 },
      { at: opened, pool: 'grok-ultra-weekly', usd: 0, points: 5 },
    ],
  } };
}
function emptyReport() {
  const cost = loopCosts({}, [], now).cost;
  return summarizeLoop(now, [], [], LOOP_REPOS.map(repo => ({ repo, complete: true, merged_prs: 0 })), cost);
}

describe('loop metric calculation and source contracts', () => {
  it('uses nearest-rank percentiles and represents no samples as unknown', () => {
    expect(percentiles([])).toEqual({ samples: 0, p50_ms: null, p90_ms: null });
    expect(percentiles([null, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100])).toEqual({ samples: 10, p50_ms: 50, p90_ms: 90 });
    expect(percentiles([0])).toEqual({ samples: 1, p50_ms: 0, p90_ms: 0 });
  });
  it('rejects missing, backwards, future and non-ISO timestamps', () => {
    expect(elapsed(null, merged, now)).toBeNull();
    expect(elapsed(merged, ready, now)).toBeNull();
    expect(elapsed(ready, '2027-01-01T00:00:00Z', now)).toBeNull();
    expect(elapsed('100', merged, now)).toBeNull();
  });
  it('reads header-driven router queue tables and correlates repo plus PR', () => {
    expect(parseLoopQueue(queue)).toEqual({ complete: true, values: [{ repo: 'ashlrai/phantom', pr: 12, task: 'RQ-LOOP-1', queued_at: '2026-10-25T08:00:00.000Z', claimed_at: '2026-10-25T08:30:00.000Z', agent: 'codex-1' }] });
    expect(parseLoopQueue('nothing')).toEqual({ complete: false, values: [] });
    expect(parseLoopQueue(queue.replace('2026-10-25T08:30:00Z', 'unknown')).complete).toBe(false);
  });
  it('reads only valid ci_time.v1 rows, retaining explicit zero duration', () => {
    const valid = { schema: 'ci_time.v1', repo: 'ashlrai/phantom', pr: 12, head_sha: sha, recorded_at: merged, duration_ms: 0 };
    const parsed = parseCiTimes([JSON.stringify(valid), '{broken', JSON.stringify({ ...valid, schema: 'ci_time.v2' })].join('\n'));
    expect(parsed.complete).toBe(false);
    expect(parsed.values).toHaveLength(1);
    expect(parsed.values[0]?.duration_ms).toBe(0);
  });
  it('does not convert pool units or percentages into dollars or points', () => {
    const result = loopCosts({ pools: [{ id: 'grok-ultra-weekly', used_pct: 5 }], repos: [{ merged: [{ cost: [{ pool: 'grok-ultra-weekly', value: 20, unit: 'pool-unit' }] }] }] }, [], now);
    expect(result.complete).toBe(false);
    expect(result.cost.pool_spend_usd).toBeNull();
    expect(result.cost.grok_ultra_points).toBeNull();
  });
});

describe('recorded gh observations', () => {
  it('replays the sanitized real #930 timeline and head check recording', async () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/fleet-loop/gh-recording.json', import.meta.url), 'utf8'));
    const metadata = fixture.pull_request;
    const recordedPr = { ...pr, number: metadata.number, created_at: metadata.createdAt, merged_at: metadata.mergedAt, draft: metadata.isDraft, head: { sha: metadata.headRefOid, ref: 'recorded' } };
    const result = await observeLoopPr(fakeGh({ timeline: fixture.timeline, reviews: fixture.reviews, checks: fixture.checks.check_runs }), 'ashlrai/phantom', recordedPr, [], [], now);
    expect(result.pr.durations_ms.ci).toBe(6_135_000);
    expect(result.pr.durations_ms.merge).toBe(8_968_000);
    expect(result.pr.ready_at).toBe('2026-10-26T02:35:39Z');
    expect(result.pr.agent).toBeNull();
  });
  it('computes all five stages and sums overlapping head check durations', async () => {
    const result = await observeLoopPr(fakeGh({ checks: [check, { ...check, id: 2 }] }), 'ashlrai/phantom', pr, parseLoopQueue(queue).values, [], now);
    expect(result.pr.durations_ms).toEqual({ queue_wait: 1_800_000, agent: 1_800_000, ci: 240_000, review: 600_000, merge: 3_600_000 });
    expect(result.pr.ci_source).toBe('github');
  });
  it('uses the first approval after ready, excluding earlier reviews', async () => {
    const result = await observeLoopPr(fakeGh({ reviews: [{ state: 'APPROVED', submitted_at: '2026-10-25T09:30:00Z' }, { state: 'APPROVED', submitted_at: '2026-10-25T10:15:00Z' }, { state: 'APPROVED', submitted_at: '2026-10-25T10:05:00Z' }] }), 'ashlrai/phantom', pr, [], [], now);
    expect(result.pr.durations_ms.review).toBe(300_000);
  });
  it('rejects mixed-head check populations instead of publishing a partial sum', async () => {
    const result = await observeLoopPr(fakeGh({ checks: [check, { ...check, id: 3, head_sha: 'b'.repeat(40) }] }), 'ashlrai/phantom', pr, [], [], now);
    expect(result.complete).toBe(false);
    expect(result.pr.durations_ms.ci).toBeNull();
  });
  it('uses an earlier CodeRabbit check pass', async () => {
    const result = await observeLoopPr(fakeGh({ checks: [{ ...check, app: { slug: 'coderabbitai' } }] }), 'ashlrai/phantom', pr, [], [], now);
    expect(result.pr.durations_ms.review).toBe(120_000);
  });
  it('reads CodeRabbit commit-status passes without comment bodies', async () => {
    const result = await observeLoopPr(fakeGh({ statuses: [{ id: 7, context: 'CodeRabbit', state: 'success', created_at: '2026-10-25T10:01:00Z', creator: { login: 'coderabbitai[bot]' } }] }), 'ashlrai/phantom', pr, [], [], now);
    expect(result.pr.durations_ms.review).toBe(60_000);
  });
  it('treats initial non-draft PRs as ready at opening and never drafts without ready evidence', async () => {
    const run = (draft: boolean) => observeLoopPr(fakeGh({ timeline: [] }), 'ashlrai/phantom', { ...pr, draft }, [], [], now);
    expect((await run(false)).pr.ready_at).toBe(opened);
    expect((await run(true)).pr.ready_at).toBeNull();
  });
  it('does not attribute ambiguous duplicate queue claims', async () => {
    const claims = parseLoopQueue(queue).values;
    const result = await observeLoopPr(fakeGh(), 'ashlrai/phantom', pr, [...claims, ...claims], [], now);
    expect(result.complete).toBe(false);
    expect(result.pr.durations_ms.queue_wait).toBeNull();
    expect(result.pr.agent).toBeNull();
  });
  it('matches task-only claims by an exact branch segment', async () => {
    const claim = { ...parseLoopQueue(queue).values[0]!, pr: null };
    const result = await observeLoopPr(fakeGh(), 'ashlrai/phantom', pr, [claim], [], now);
    expect(result.pr.agent).toBe('codex-1');
    expect((await observeLoopPr(fakeGh(), 'ashlrai/phantom', { ...pr, head: { sha, ref: 'RQ-LOOP-10' } }, [claim], [], now)).pr.agent).toBeNull();
  });
  it('uses only a matching head ledger total as CI fallback, never double-counting', async () => {
    const records = [{ repo: 'ashlrai/phantom', pr: 12, head_sha: sha, duration_ms: 777, recorded_at: now }];
    expect((await observeLoopPr(fakeGh(), 'ashlrai/phantom', pr, [], records, now)).pr.durations_ms.ci).toBe(120_000);
    const result = await observeLoopPr(fakeGh({ checks: [] }), 'ashlrai/phantom', pr, [], records, now);
    expect(result.pr.durations_ms.ci).toBe(777);
    expect(result.pr.ci_source).toBe('ci_time.v1');
    expect((await observeLoopPr(fakeGh({ checks: [] }), 'ashlrai/phantom', pr, [], [{ ...records[0]!, head_sha: 'b'.repeat(40) }], now)).pr.durations_ms.ci).toBeNull();
  });
  it('keeps running/invalid checks and tied conflicting ledger records unknown', async () => {
    const records = [1, 2].map(duration_ms => ({ repo: 'ashlrai/phantom', pr: 12, head_sha: sha, duration_ms, recorded_at: now }));
    const result = await observeLoopPr(fakeGh({ checks: [{ ...check, completed_at: null }] }), 'ashlrai/phantom', pr, [], records, now);
    expect(result.pr.durations_ms.ci).toBeNull();
    expect(result.pr.ci_ledger_ms).toBeNull();
  });
  it('queries all seven repos and only counts merges inside the seven-day window', async () => {
    const gh = fakeGh({ pulls: [pr, { ...pr, number: 13, created_at: '2026-09-30T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', merged_at: '2026-10-01T00:00:00Z' }] });
    const result = await collectLoopGithub(gh, [], [], now);
    expect(result.repos.map(repo => repo.repo)).toEqual(LOOP_REPOS);
    expect(result.prs).toHaveLength(1);
    expect(result.repos[0]?.merged_prs).toBe(1);
    expect(vi.mocked(gh).mock.calls.some(([args]) => args[1]?.includes(`${sha}/check-runs?filter=all`))).toBe(true);
  });
  it('retains partial observations but never turns failed repo reads into zero merges', async () => {
    const base = fakeGh();
    const gh: LoopGh = async args => {
      if (args[1]?.includes('/locus/')) throw new Error('PRIVATE failure text');
      return base(args);
    };
    const result = await collectLoopGithub(gh, [], [], now);
    expect(result.repos.find(repo => repo.repo === 'ashlrai/locus')).toMatchObject({ complete: false, merged_prs: null });
    const report = summarizeLoop(now, result.prs, result.sources, result.repos, loopCosts({}, [], now).cost);
    expect(report.merged_prs).toBeNull();
    expect(report.revert_rate.rate).toBeNull();
    expect(JSON.stringify(report)).not.toContain('PRIVATE');
  });
  it('paginates check runs and sums the complete head population', async () => {
    const base = fakeGh();
    const gh: LoopGh = async args => args[1]?.includes('check-runs') ? {
      total_count: 101,
      check_runs: args[1].includes('&page=1') ? Array.from({ length: 100 }, (_, i) => ({ ...check, id: i + 1 })) : [{ ...check, id: 101 }],
    } : base(args);
    const result = await observeLoopPr(gh, 'ashlrai/phantom', pr, [], [], now);
    expect(result.pr.durations_ms.ci).toBe(12_120_000);
  });
  it('rejects duplicate check identities instead of counting a rerun twice', async () => {
    const result = await observeLoopPr(fakeGh({ checks: [check, check] }), 'ashlrai/phantom', pr, [], [], now);
    expect(result.complete).toBe(false);
    expect(result.pr.durations_ms.ci).toBeNull();
  });
  it('marks malformed merged PR metadata unknown rather than silently reporting zero', async () => {
    const result = await collectLoopGithub(fakeGh({ pulls: [{ ...pr, merged_at: 'broken' }] }), [], [], now);
    expect(result.repos[0]).toMatchObject({ complete: false, merged_prs: null });
  });
  it('does not infer readiness or a first review from malformed event timestamps', async () => {
    const result = await observeLoopPr(fakeGh({ timeline: [{ event: 'ready_for_review', created_at: 'bad' }], reviews: [{ state: 'APPROVED', submitted_at: 'bad' }] }), 'ashlrai/phantom', pr, [], [], now);
    expect(result.complete).toBe(false);
    expect(result.pr.ready_at).toBeNull();
    expect(result.pr.durations_ms.review).toBeNull();
  });
  it('marks a pagination cap partial instead of reporting a false first approval', async () => {
    const base = fakeGh();
    const gh: LoopGh = async args => args[1]?.includes('/reviews') ? Array.from({ length: 100 }, () => ({ state: 'APPROVED', submitted_at: merged })) : base(args);
    const result = await observeLoopPr(gh, 'ashlrai/phantom', pr, [], [], now);
    expect(result.complete).toBe(false);
    expect(result.pr.durations_ms.review).toBeNull();
  });
});

describe('outcome costs and bottleneck', () => {
  let observed: LoopPr;
  beforeEach(async () => { observed = (await observeLoopPr(fakeGh(), 'ashlrai/phantom', pr, parseLoopQueue(queue).values, [], now)).pr; });
  it('computes per-dollar outcomes and attributes visible Ultra consumption', () => {
    const data = loopCosts(costFixture(), [observed], now);
    expect(data.complete).toBe(true);
    expect(data.cost).toMatchObject({ pool_spend_usd: 5, grok_ultra_points: 15, unattributed_points: 5,
      by_agent: [{ agent: 'grok-worker', points: 10, merged_prs: 1, points_per_merged_pr: 10 }] });
    const report = summarizeLoop(now, [{ ...observed, reverted: true }], [], [{ repo: 'ashlrai/phantom', complete: true, merged_prs: 1 }], data.cost);
    expect(report.cost.merged_prs_per_dollar).toBe(0.2);
    expect(report.cost.grok_ultra_points_per_merged_pr).toBe(15);
    expect(report.revert_rate.rate).toBe(1);
    expect(report.bottleneck.stage).toBe('merge');
    expect(report.panel.stages).toHaveLength(5);
  });
  it('does not invent a points-to-merge ratio for work that did not merge', () => {
    const data = loopCosts(costFixture(), [{ ...observed, merged_at: null }], now);
    expect(data.cost.by_agent[0]?.points_per_merged_pr).toBeNull();
  });
  it('rejects misaligned spend windows and malformed point amounts', () => {
    const fleet = costFixture();
    row(fleet['spend'])['window_start'] = '2020-01-01T00:00:00Z';
    expect(loopCosts(fleet, [observed], now).cost.pool_spend_usd).toBeNull();
    const broken = costFixture();
    const entries = row(broken['spend'])['entries'] as Row[];
    entries[0]!['points'] = -1;
    expect(loopCosts(broken, [observed], now).cost.grok_ultra_points).toBeNull();
  });
  it('supports explicit window-aligned pool USD totals without inferring points', () => {
    const result = loopCosts({ pools: [{ id: 'codex-cmp', complete: true, spend_usd: 5, window_start: new Date(now - 7 * 86400_000).toISOString(), window_end: new Date(now).toISOString() }] }, [], now);
    expect(result.cost.pool_spend_usd).toBe(5);
    expect(result.cost.grok_ultra_points).toBeNull();
  });
  it('adopts a fresh seven-day spend snapshot instead of requiring live clock equality', () => {
    expect(loopWindowEnd(costFixture(), now + 30_000)).toBe(now);
    expect(loopWindowEnd(costFixture(), now + 600_000)).toBe(now + 600_000);
    expect(loopWindowEnd(costFixture(), now - 1)).toBe(now - 1);
  });
  it('keeps bottlenecks provisional when stages have no observations', () => {
    const report = summarizeLoop(now, [{ ...observed, durations_ms: { ...observed.durations_ms, review: null } }], [], [{ repo: 'ashlrai/phantom', complete: true, merged_prs: 1 }], loopCosts(costFixture(), [observed], now).cost);
    expect(report.complete).toBe(true);
    expect(report.bottleneck.provisional).toBe(true);
  });
  it('rejects duplicate or shared pool dollar totals', () => {
    const pool = { id: 'codex-cmp', complete: true, spend_usd: 5, window_start: new Date(now - 7 * 86400_000).toISOString(), window_end: new Date(now).toISOString() };
    expect(loopCosts({ pools: [pool, pool] }, [], now).cost.pool_spend_usd).toBeNull();
    expect(loopCosts({ pools: [{ ...pool, shared_with: 'another' }] }, [], now).cost.pool_spend_usd).toBeNull();
  });
});

describe('fleet persistence and privacy-safe PostHog', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(realpathSync(tmpdir()), 'fleet-loop-'));
    vi.stubEnv('PHANTOM_POSTHOG_TOKEN', '');
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
  function files() {
    const fleetPath = join(directory, 'fleet.json'), queuePath = join(directory, 'router-queue.md'), ciPath = join(directory, 'ci.jsonl');
    writeFileSync(fleetPath, JSON.stringify(costFixture()));
    writeFileSync(queuePath, queue);
    writeFileSync(ciPath, '');
    return { fleetPath, queuePath, ciPath, now, gh: fakeGh() };
  }
  it('persists loop.v1 under loop, preserving existing fleet fields', async () => {
    const options = files();
    const result = await refreshLoopReport(options);
    expect(result.schema).toBe('loop.v1');
    expect(result.complete).toBe(true);
    expect(JSON.parse(readFileSync(options.fleetPath, 'utf8'))).toMatchObject({ schema: 'fleet.v1', preserved: { nested: true }, loop: result });
    if (process.platform !== 'win32') expect(statSync(options.fleetPath).mode & 0o777).toBe(0o600);
  });
  it('re-reads fleet state after network IO so newer unrelated fields survive', async () => {
    const options = files(), base = fakeGh();
    const gh: LoopGh = async args => {
      writeFileSync(options.fleetPath, JSON.stringify({ ...costFixture(), refreshed_elsewhere: 7 }));
      return base(args);
    };
    await refreshLoopReport({ ...options, gh });
    expect(JSON.parse(readFileSync(options.fleetPath, 'utf8')).refreshed_elsewhere).toBe(7);
  });
  it('uses fresh spend as-of time without calling newer legitimate GitHub rows malformed', async () => {
    const options = files(), wallClock = now + 60_000;
    const base = fakeGh();
    const gh: LoopGh = async args => args[1]?.includes('/pulls?state=open') && args[1].includes('/phantom/') ?
      [{ ...pr, number: 15, state: 'open', created_at: new Date(now + 30_000).toISOString(), updated_at: new Date(now + 30_000).toISOString(), merged_at: null }] : base(args);
    const result = await refreshLoopReport({ ...options, now: wallClock, gh });
    expect(result.generated_at).toBe(new Date(wallClock).toISOString());
    expect(result.window.end).toBe(new Date(now).toISOString());
    expect(result.repos[0]?.complete).toBe(true);
    expect(result.merged_prs).toBe(1);
    expect(result.prs.some(entry => entry.number === 15)).toBe(false);
  });
  it('creates missing fleet state with explicit unknown costs and source failures', async () => {
    const fleetPath = join(directory, 'new', 'fleet.json');
    const result = await refreshLoopReport({ fleetPath, now, gh: fakeGh() });
    expect(existsSync(fleetPath)).toBe(true);
    expect(result.cost.pool_spend_usd).toBeNull();
    expect(result.complete).toBe(false);
    expect(result.sources.find(source => source.source === 'router-queue.md')?.complete).toBe(false);
  });
  it('refuses malformed existing state without overwriting it', async () => {
    const options = files();
    writeFileSync(options.fleetPath, '{malformed');
    await expect(refreshLoopReport(options)).rejects.toThrow('fleet-state-invalid');
    expect(readFileSync(options.fleetPath, 'utf8')).toBe('{malformed');
  });
  it('refuses symlinked fleet state and does not touch the target', async () => {
    const options = files(), linked = join(directory, 'linked.json');
    symlinkSync(options.fleetPath, linked);
    await expect(refreshLoopReport({ ...options, fleetPath: linked })).rejects.toThrow('fleet-state-unavailable-or-unsafe');
    expect(JSON.parse(readFileSync(options.fleetPath, 'utf8')).loop).toBeUndefined();
  });
  it('refuses world-writable existing fleet state', async () => {
    if (process.platform === 'win32') return;
    const options = files();
    chmodSync(options.fleetPath, 0o666);
    await expect(refreshLoopReport(options)).rejects.toThrow('fleet-state-unavailable-or-unsafe');
  });
  it('emits only stage and bottleneck aggregates, with no PR details or agents', async () => {
    const report = await refreshLoopReport(files());
    const serialized = JSON.stringify(loopEvents(report));
    expect(serialized).not.toContain('grok-worker');
    expect(serialized).not.toContain(sha);
    expect(serialized).not.toContain('ashlrai/phantom');
    expect(loopEvents(report).map(event => event.event)).toEqual([...Array(5).fill('phantom_loop_stage'), 'phantom_loop_bottleneck']);
    const send = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    expect(await emitLoopEvents(report, { posthogToken: 'fixture-project-token', fetch: send })).toBe('sent');
    expect(send).toHaveBeenCalledOnce();
    const [url, options] = send.mock.calls[0]!;
    expect(url).toBe('https://us.i.posthog.com/batch/');
    expect(options?.redirect).toBe('error');
    expect(JSON.parse(String(options?.body)).batch).toHaveLength(6);
  });
  it('disables unconfigured telemetry and never posts to untrusted hosts', async () => {
    const send = vi.fn<typeof fetch>();
    expect(await emitLoopEvents(emptyReport(), { fetch: send })).toBe('disabled');
    expect(await emitLoopEvents(emptyReport(), { posthogToken: 'fixture', posthogHost: 'https://untrusted.example', fetch: send })).toBe('failed');
    expect(send).not.toHaveBeenCalled();
  });
  it('records telemetry failures without surfacing raw errors or losing the snapshot', async () => {
    const options = files();
    const result = await refreshLoopReport({ ...options, posthogToken: 'fixture', fetch: async () => { throw new Error('secret raw error'); } });
    expect(result.telemetry).toBe('failed');
    expect(JSON.parse(readFileSync(options.fleetPath, 'utf8')).loop.telemetry).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('secret raw error');
  });
  it('scrubs environment secrets from visible agent attribution', () => {
    vi.stubEnv('TEST_LOOP_SECRET', 'private-fixture-secret');
    const parsed = parseLoopQueue(queue.replace('codex-1', 'private-fixture-secret'));
    expect(JSON.stringify(parsed)).not.toContain('private-fixture-secret');
  });
  it('formats unknowns without NaN, Infinity or fabricated zero ratios', () => {
    const formatted = formatLoopReport(emptyReport());
    expect(formatted).toContain('unknown');
    expect(formatted).not.toMatch(/NaN|Infinity/);
  });
});
