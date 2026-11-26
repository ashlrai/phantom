/** `phm org` through its injectable reader: every fleet here is a fixture, no real runs dir or process table. */
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderOrgTreeText, type FleetOrgTree } from '../src/core/fleet/org-tree.js';
import type { LaneModelSnapshot } from '../src/core/fleet/lane-models.js';
import type { FleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import type { ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';
import { getFleetSessions, type FleetSessionsV1 } from '../src/core/fleet/runs-sessions.js';
import { readFleetOrgMap, type FleetOrgReaders } from '../src/core/verse/fleet-org-map-api.js';

const NOW = Date.parse('2026-11-17T12:00:00Z'), AT = '2026-11-17T12:00:00Z';
const session = (job: string, lane: string, extra: object = {}) => ({ job, lane, repo: 'phantom', model: 'fixture-model', status: 'running',
  elapsedSeconds: 600, startedAt: '2026-11-17T11:50:00Z', live: 'yes', ...extra });
const lane = (name: string, running: number, target: number, extra: object = {}) => ({ lane: name, running, target, queued: 0, held: false, heldReason: null, ...extra });

/** A fleet as its sources report it. Anything left out fails to read, as a missing file would. */
function fleet(parts: { sessions?: object[]; lanes?: object[]; paused?: boolean; usage?: object[]; launches?: Record<string, string> }): Partial<FleetOrgReaders> {
  const missing = async (): Promise<never> => { throw new Error('fixture: source missing'); };
  return {
    now: () => NOW, live: missing, messages: () => null, registry: missing, profileLanes: async () => [],
    sessions: parts.sessions ? async () => ({ generatedAt: AT, sourceState: 'healthy', truncated: false, recent: [], sessions: parts.sessions }) as unknown as FleetSessionsV1 : missing,
    runs: parts.lanes ? async () => ({ lanes: parts.lanes, events: [], lastTick: AT, paused: parts.paused ?? false, sources: { status: 'healthy' } }) as unknown as FleetRunsDirState : missing,
    ledger: parts.usage ? async () => ({ asOf: AT, lanes: parts.usage, sources: { status: 'healthy' } }) as unknown as ResourceLedgerV1 : missing,
    models: parts.launches ? async () => ({ lanes: Object.entries(parts.launches!).map(([name, model]) => ({ lane: name, lastLaunch: { model } })) }) as unknown as LaneModelSnapshot : missing,
  };
}
const org = async (readers: Partial<FleetOrgReaders>) => (await readFleetOrgMap(60, readers)).tree;
const find = (tree: FleetOrgTree, name: string) => tree.lanes.find(row => row.lane === name)!;

describe('phm org reader', () => {
  it('uses the same status read for the leader seat row and reports a missing registry honestly', async () => {
    const readers = fleet({ lanes: [lane('claude', 0, 1, { healthy: true })] });
    const read = readers.runs!; let calls = 0;
    readers.runs = async clock => { calls++; return { ...await read(clock), leader: { lane: 'claude', model: 'fixture-model', lastSuccessAt: AT } }; };
    const result = await org(readers);
    expect(calls).toBe(1);
    expect(result.leaderSeat).toMatchObject({ schema: 'leader.seat.v1', version: 1,
      current: { lane: 'claude', model: 'fixture-model', lastSuccessAt: AT }, pick: null,
      reason: 'No seat available. claude: Model is not confirmed in the registry.' });
  });
  it('shows an empty fleet as idle lanes under an idle leader, with a versioned schema', async () => {
    const tree = await org(fleet({ sessions: [], lanes: [lane('claude', 0, 8), lane('gemini', 0, 1, { queued: 2 })] }));
    expect(tree).toMatchObject({ schema: 'fleet.org.v1', version: 1, jobsKnown: true });
    expect(tree.leader).toMatchObject({ state: 'idle', doing: 'No jobs running', provider: 'unknown', model: null });
    expect(find(tree, 'claude')).toMatchObject({ state: 'idle', doing: 'Idle, nothing queued', running: 0, target: 8, model: null, jobs: [] });
    expect(find(tree, 'gemini')).toMatchObject({ state: 'idle', doing: 'Idle, 2 queued' });
    expect(tree.lanes.every(row => row.state === 'idle')).toBe(true);
  });

  it('shows nothing invented when no source answers', async () => {
    const tree = await org(fleet({}));
    expect(tree.leader).toMatchObject({ state: 'unknown', doing: 'Unknown' });
    expect(tree.lanes).toEqual([]);
    expect(renderOrgTreeText(tree, NOW)).not.toContain('claude (Anthropic');
  });

  it('shows a busy fleet as leader, lanes and jobs with provider, model, state and activity', async () => {
    const tree = await org(fleet({
      sessions: [session('RQ-A', 'claude'), session('RQ-B', 'claude', { status: 'publishing' }), session('RQ-C', 'codex-cmp', { status: 'launching', model: null, repo: null }),
        session('RQ-OLD', 'codex-cmp', { status: 'stale', live: 'no' }), session('RQ-WAIT', 'claude', { status: 'queued' })],
      lanes: [lane('claude', 2, 8), lane('codex-cmp', 2, 3)], usage: [{ lane: 'claude', usedPct: 41.6, resetAt: null }], launches: { 'codex-cmp': 'gpt-fixture', grok: 'grok-fixture' },
    }));
    expect(tree.leader).toMatchObject({ state: 'running', doing: 'Directing 4 running jobs across 2 lanes' });
    expect(find(tree, 'claude')).toMatchObject({ provider: 'Anthropic', model: 'fixture-model', state: 'running', doing: '2 jobs running', running: 2, target: 8, usage: { usedPct: 41.6 } });
    expect(find(tree, 'claude').jobs.map(job => [job.id, job.state, job.doing, job.model])).toEqual([
      ['RQ-A', 'running', 'Working in phantom', 'fixture-model'], ['RQ-B', 'running', 'Opening its pull request', 'fixture-model']]);
    // Two models under one lane: the lane falls back to its newest launch. A stale job is unknown, never running.
    expect(find(tree, 'codex-cmp')).toMatchObject({ provider: 'OpenAI', model: 'gpt-fixture', state: 'running' });
    expect(find(tree, 'codex-cmp').jobs.map(job => [job.id, job.state, job.doing])).toEqual([
      ['RQ-C', 'running', 'Starting up'], ['RQ-OLD', 'unknown', 'Dispatched, but no sign of life']]);
    expect(tree.lanes.find(row => row.lane === 'grok')).toBeUndefined();
    const text = renderOrgTreeText(tree, NOW);
    expect(text).toContain('Leader (CEO): running. Directing 4 running jobs across 2 lanes.');
    expect(text).toContain('claude (Anthropic, fixture-model): running. 2 running of 8, 0 queued, usage 42% (measured just now)');
    expect(text).toContain('RQ-B | running | Opening its pull request | fixture-model | started 10m ago');
  });

  it('marks a held lane and a paused dispatcher as held, with the reason', async () => {
    const tree = await org(fleet({ sessions: [session('RQ-D', 'devin')], paused: true,
      lanes: [lane('devin', 1, 0, { held: true, heldReason: 'autobackoff: usage limit' }), lane('claude', 0, 8)] }));
    expect(find(tree, 'devin')).toMatchObject({ state: 'held', doing: 'Held: autobackoff: usage limit', heldReason: 'autobackoff: usage limit', running: 1, target: 0 });
    expect(find(tree, 'claude').state).toBe('idle');
    expect(tree.leader).toMatchObject({ state: 'held', doing: 'Dispatch is paused' });
    // Held is not idle: the held lane's running job still counts for the leader once dispatch resumes.
    const resumed = await org(fleet({ sessions: [session('RQ-D', 'devin')], lanes: [lane('devin', 1, 0, { held: true })] }));
    expect(resumed.leader).toMatchObject({ state: 'running', doing: 'Directing 1 running job across 1 lane' });
    expect(find(resumed, 'devin')).toMatchObject({ state: 'held', doing: 'Held, reason not reported' });
    expect(renderOrgTreeText(tree, NOW)).toContain('devin (Cognition, fixture-model): held. Held: autobackoff: usage limit. 1 running of 0, 0 queued, held');
  });

  it('shows a published cloud job as done and does not count it as running', async () => {
    const tree = await org(fleet({ sessions: [session('RQ-CLOUD', 'devin', { status: 'stale', live: 'no', published: true }), session('RQ-LIVE', 'devin')],
      lanes: [lane('devin', 1, 4), lane('zai', 1, 1)] }));
    const devin = find(tree, 'devin');
    expect(devin).toMatchObject({ state: 'running', doing: '1 job running', running: 1, target: 4 });
    expect(devin.jobs.map(job => [job.id, job.state, job.doing])).toEqual([
      ['RQ-CLOUD', 'done', 'Published its result; waiting for cleanup'], ['RQ-LIVE', 'running', 'Working in phantom']]);
    expect(renderOrgTreeText(tree, NOW)).toContain('RQ-CLOUD | done | Published its result; waiting for cleanup');
    // A lane whose only job already published is idle, not running.
    const only = await org(fleet({ sessions: [session('RQ-CLOUD', 'devin', { published: true })], lanes: [lane('devin', 0, 4)] }));
    expect(find(only, 'devin')).toMatchObject({ state: 'idle', running: 0 });
    expect(only.leader.state).toBe('idle');
  });

  it('reads "published" from the publish record itself: a RESULT line from this attempt, no exit code needed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'org-reader-')), run = join(dir, 'queue', 'run'), at = (NOW - 3_600_000) / 1000;
    mkdirSync(run, { recursive: true });
    for (const job of ['RQ-CLOUD', 'RQ-BUSY', 'RQ-RETRY', 'RQ-DENIED']) {
      writeFileSync(join(run, `${job}.line`), `${job}\tphantom\tdevin\tfrontier\t/fixture/prompt.md\n`);
      writeFileSync(join(run, `${job}.dispatched`), `${at}\n`);
    }
    writeFileSync(join(dir, 'RQ-CLOUD.publish'), 'RESULT PR https://github.com/ashlrai/phantom/pull/1\n');
    writeFileSync(join(dir, 'RQ-BUSY.publish'), 'AUTO_MERGE on\n');
    writeFileSync(join(dir, 'RQ-DENIED.publish'), 'RESULT DENIED\n');
    // A RESULT left by an earlier attempt, written before this dispatch, says nothing about this one.
    writeFileSync(join(dir, 'RQ-RETRY.publish'), 'RESULT EMPTY\n'); utimesSync(join(dir, 'RQ-RETRY.publish'), at - 600, at - 600);
    const sessions = await getFleetSessions({ runsDir: dir, now: () => NOW, runPs: async () => '' });
    const published = Object.fromEntries([...sessions.sessions, ...sessions.recent].map(row => [row.job, row.published]));
    expect(published).toEqual({ 'RQ-CLOUD': true, 'RQ-BUSY': false, 'RQ-RETRY': false, 'RQ-DENIED': false });
    const tree = await org({ ...fleet({ lanes: [lane('devin', 2, 4)] }), sessions: async () => sessions });
    expect(find(tree, 'devin').jobs.map(job => [job.id, job.state])).toEqual(expect.arrayContaining([['RQ-CLOUD', 'done']]));
    expect(sessions.recent.find(row => row.job === 'RQ-CLOUD')).toMatchObject({ status: 'finished', published: true });
    expect(sessions.sessions.some(row => row.job === 'RQ-CLOUD')).toBe(false);
    expect(find(tree, 'devin').running).toBe(2);
  });
});
