import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSessionTree, leaderRecord, sessionRecords, type LeaderSessionFacts, type SessionNode, type SessionRecord } from '../src/core/fleet/session-tree.js';
import { buildLiveSessions, flatTree, leaderGaps, renderLiveSessionsText } from '../src/core/fleet/live-sessions.js';
import { readLeaderSessionFacts, readLiveSessions } from '../src/core/fleet/live-sessions-read.js';
import type { FleetSessionMap } from '../src/core/fleet/sessions-view.js';
import type { SubagentRecord } from '../src/core/subagent/spawn.js';
import { createFleetLiveSessionsApi } from '../src/core/verse/fleet-live-sessions-api.js';
import { cmdLiveSessions } from '../src/cli/sessions.js';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const record = (id: string, parentId: string | null, over: Partial<SessionRecord> = {}): SessionRecord => ({ id, parentId, agent: 'claude', lane: 'claude',
  model: 'fixture-model', repo: 'phantom', jobId: parentId === 'leader' ? id : null, state: 'running', startedAt: ago(30), lastMessageAt: ago(2),
  lastMessage: 'Reading the code', ...over });
const leader = record('leader', null, { agent: 'leader', lane: 'leader', lastMessage: 'Queued two jobs' });
const shape = (nodes: SessionNode[]): unknown[] => nodes.map(node => [node.id, node.kind, node.state, ...(node.children.length ? [shape(node.children)] : [])]);

describe('buildSessionTree', () => {
  it('puts the leader at the root, then workers, then their subagents, with counts and a plain top line', () => {
    const tree = buildSessionTree([record('helper-a', 'worker-a', { lastMessage: null, lastMessageAt: null }), record('worker-b', 'leader', { lastMessageAt: ago(9) }),
      leader, record('worker-a', 'leader')], NOW);
    expect(tree).toMatchObject({ schema: 'fleet.session-tree.v1', version: 1, generatedAt: ago(0), line: '4 sessions running: leader, 2 workers, 1 subagent' });
    expect(shape(tree.roots)).toEqual([['leader', 'leader', 'running', [['worker-a', 'worker', 'running', [['helper-a', 'subagent', 'running']]], ['worker-b', 'worker', 'running']]]]);
    expect(tree.roots[0]!.counts).toEqual({ below: 3, running: 3, failed: 0 });
    expect(tree.roots[0]!.children[0]).toMatchObject({ jobId: 'worker-a', model: 'fixture-model', repo: 'phantom', lastMessageAgeSeconds: 120,
      lastMessage: 'Reading the code', counts: { below: 1, running: 1, failed: 0 } });
    expect(tree.roots[0]!.children[0]!.children[0]).toMatchObject({ lastMessage: null, lastMessageAt: null, lastMessageAgeSeconds: null });
    expect(tree.counts).toEqual({ sessions: 4, running: 4, idle: 0, done: 0, failed: 0, unknown: 0, leaders: 1, workers: 2, subagents: 1, orphans: 0, failedLastHour: 0 });
    expect(Object.keys(tree.roots[0]!)).toEqual(['id', 'parentId', 'agent', 'lane', 'model', 'repo', 'jobId', 'state', 'startedAt', 'lastMessageAt',
      'lastMessage', 'kind', 'lastMessageAgeSeconds', 'counts', 'children']);
  });

  it('shows a session whose parent is missing under "unknown parent", and survives a parent loop and a repeated id', () => {
    const tree = buildSessionTree([leader, record('worker-a', 'leader'), record('lost-a', 'gone-worker'), record('loop-a', 'loop-b'), record('loop-b', 'loop-a'),
      record('worker-a', 'leader', { state: 'failed' }), record('self-a', 'self-a')], NOW);
    expect(tree.roots.map(node => node.id)).toEqual(['leader', 'unknown parent']);
    const unknown = tree.roots[1]!;
    expect(unknown).toMatchObject({ kind: 'unknown-parent', state: 'unknown', counts: { below: 4, running: 4, failed: 0 } });
    expect(flatTree(unknown.children).map(({ node }) => node.id).sort()).toEqual(['loop-a', 'loop-b', 'lost-a', 'self-a']);
    expect(unknown.children.find(node => node.id === 'lost-a')).toMatchObject({ parentId: 'gone-worker', kind: 'worker' });
    expect(tree.line).toBe('6 sessions running: leader, 4 workers, 1 subagent; 3 under unknown parent');
    expect(tree.counts).toMatchObject({ sessions: 6, orphans: 3 });
  });

  it('counts a failure in the last hour, and sorts running first, then most recent', () => {
    const tree = buildSessionTree([leader, record('worker-old', 'leader', { lastMessageAt: ago(20) }), record('worker-new', 'leader', { lastMessageAt: ago(1) }),
      record('worker-failed', 'leader', { state: 'failed', lastMessageAt: ago(0) }), record('worker-done', 'leader', { state: 'done', lastMessageAt: ago(5) }),
      record('worker-idle', 'leader', { state: 'idle', lastMessageAt: ago(3) }), record('worker-failed-old', 'leader', { state: 'failed', lastMessageAt: ago(90), startedAt: ago(120) }),
      record('worker-what', 'leader', { state: 'unknown', lastMessageAt: null, startedAt: null })], NOW);
    expect(tree.roots[0]!.children.map(node => node.id)).toEqual(['worker-new', 'worker-old', 'worker-failed', 'worker-idle', 'worker-done', 'worker-failed-old', 'worker-what']);
    expect(tree.line).toBe('3 sessions running: leader, 2 workers; 1 failed in the last hour; 1 with state unknown');
    expect(tree.counts).toMatchObject({ running: 3, idle: 1, done: 1, failed: 2, unknown: 1, failedLastHour: 1 });
    expect(tree.roots[0]!.counts).toEqual({ below: 7, running: 2, failed: 2 });
    expect(buildSessionTree([record('worker-failed', 'leader', { state: 'failed' }), { ...leader, state: 'idle' }], NOW).line).toBe('No agent sessions running; 1 failed in the last hour');
  });

  it('returns an empty tree for empty input, and the same JSON for the same records in any order', () => {
    expect(buildSessionTree([], NOW)).toEqual({ schema: 'fleet.session-tree.v1', version: 1, generatedAt: ago(0), line: 'No agent sessions running.', roots: [],
      counts: { sessions: 0, running: 0, idle: 0, done: 0, failed: 0, unknown: 0, leaders: 0, workers: 0, subagents: 0, orphans: 0, failedLastHour: 0 } });
    const records = [leader, record('worker-a', 'leader'), record('worker-b', 'leader'), record('helper-a', 'worker-a'), record('lost-a', 'gone-worker')];
    expect(JSON.stringify(buildSessionTree([...records].reverse(), NOW))).toBe(JSON.stringify(buildSessionTree(records, NOW)));
  });
});

const subagent = (id: string, parent_id: string, over: Partial<SubagentRecord> = {}): SubagentRecord => ({ schema: 'subagent.v1', id, parent_id, depth: 1, tier: 'work',
  lane: 'claude', model: 'small-model', tools_allowed: ['read'], write_scope: [], max_tokens: 1000, max_cost_class: 'included', state: 'running', result_ref: null,
  created_at: ago(4), reason_codes: [], task_digest: 'a'.repeat(64), ...over } as SubagentRecord);
const map = { schema: 'fleet.sessions.v1', runsDirPresent: true, sourceState: 'healthy', sources: {}, truncated: false, localNodeId: 'node-here',
  sessions: [{ job: 'worker-a', lane: 'claude', repo: 'phantom', tier: 'frontier', model: 'fixture-model', startedAt: ago(30), lastOutputAt: ago(2), prUrl: null },
    { job: 'worker-b', lane: 'codex-local', repo: 'lexicon', tier: 'work', model: null, startedAt: ago(8), lastOutputAt: null, prUrl: null }],
  mapSessions: [{ job: 'worker-a', lane: 'claude', model: 'fixture-model', status: 'running', nodeId: 'node-here', placement: 'process', prUrl: null, activity: 'Running the tests' },
    { job: 'worker-b', lane: 'codex-local', model: null, status: 'launching', nodeId: 'node-here', placement: 'process', prUrl: null, activity: null }],
  recent: [{ job: 'worker-failed', lane: 'claude', repo: 'phantom', model: 'fixture-model', startedAt: ago(50), finishedAt: ago(20), outcome: 'failed' },
    { job: 'worker-shipped', lane: 'claude', repo: 'phantom', model: 'fixture-model', startedAt: ago(50), finishedAt: ago(10), outcome: 'pr' },
    { job: 'worker-yesterday', lane: 'claude', repo: 'phantom', model: 'fixture-model', startedAt: ago(1500), finishedAt: ago(1440), outcome: 'pr' }],
} as unknown as FleetSessionMap;
const subagents = [subagent('sa-000000000000000a', 'worker-a'), subagent('sa-000000000000000b', 'sa-000000000000000a', { depth: 2, state: 'held', model: null }),
  subagent('sa-000000000000000c', 'worker-gone'), subagent('sa-000000000000000d', 'worker-gone', { state: 'held', created_at: ago(600) }),
  subagent('sa-000000000000000e', 'worker-a', { state: 'completed', created_at: ago(600) })];

describe('the tree in fleet.live-sessions.v1', () => {
  it('joins running workers, sessions finished in the last hour and subagent records under one leader', () => {
    const list = buildLiveSessions(map, NOW, { subagents });
    expect(list).toMatchObject({ schema: 'fleet.live-sessions.v1', live: false, tree: { schema: 'fleet.session-tree.v1', version: 1 } });
    expect(shape(list.tree.roots)).toEqual([
      ['leader', 'leader', 'unknown', [['worker-a', 'worker', 'running', [['sa-000000000000000a', 'subagent', 'running', [['sa-000000000000000b', 'subagent', 'idle']]]]],
        ['worker-b', 'worker', 'running'], ['worker-shipped', 'worker', 'done'], ['worker-failed', 'worker', 'failed']]],
      ['unknown parent', 'unknown-parent', 'unknown', [['sa-000000000000000c', 'subagent', 'running']]]]);
    expect(list.tree.line).toBe('4 sessions running: 2 workers, 2 subagents; 1 failed in the last hour; 1 with state unknown; 1 under unknown parent');
    const rows = Object.fromEntries(flatTree(list.tree.roots).map(({ node }) => [node.id, node]));
    expect(rows['worker-a']).toMatchObject({ lastMessage: 'Running the tests', lastMessageAgeSeconds: 120, jobId: 'worker-a', agent: 'claude' });
    expect(rows['worker-b']).toMatchObject({ model: 'unknown', lastMessage: null, lastMessageAt: null, repo: 'lexicon' });
    expect(rows['worker-failed']).toMatchObject({ lastMessage: 'Failed', lastMessageAt: ago(20) });
    expect(rows['sa-000000000000000b']).toMatchObject({ model: 'unknown', repo: 'phantom', jobId: null, lastMessage: null });
    expect(list.gaps).toEqual(['Leader state, model and messages unknown: no source records the leader session yet.']);
    expect(renderLiveSessionsText(list)).toContain('\n    sa-000000000000000a | subagent | small-model | phantom | running | last spoke unknown\n');
    expect(renderLiveSessionsText(list)).toContain('\nunknown parent:\n  sa-000000000000000c | subagent |');
  });

  it('keeps only running and waiting sessions with live, applies lane and repo to the tree, and says when subagents are unreadable', async () => {
    const live = buildLiveSessions(map, NOW, { subagents, live: true });
    expect(live.live).toBe(true);
    expect(flatTree(live.tree.roots).map(({ node }) => node.id)).toEqual(['leader', 'worker-a', 'sa-000000000000000a', 'sa-000000000000000b', 'worker-b',
      'unknown parent', 'sa-000000000000000c']);
    const lexicon = buildLiveSessions(map, NOW, { subagents, repo: 'lexicon' });
    expect(flatTree(lexicon.tree.roots).map(({ node }) => node.id)).toEqual(['leader', 'worker-b']);
    expect(sessionRecords([], null, [], NOW)).toEqual([]);
    const unread = await readLiveSessions({ now: NOW, readMap: async () => map, readSubagents: async () => { throw new Error('unreadable'); } });
    expect(unread.gaps).toContain('Subagents unknown: the subagent records could not be read.');
    expect(unread.tree.counts).toMatchObject({ workers: 4, subagents: 0 });
    const read = await readLiveSessions({ now: NOW, readMap: async () => map, readSubagents: async () => subagents });
    expect(JSON.stringify(read)).toBe(JSON.stringify(buildLiveSessions(map, NOW, { subagents })));
  });

  it('passes --live from the CLI and live=1 from the API to the reader', async () => {
    const out: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { out.push(String(line)); });
    const read = vi.fn((filter: { live?: boolean }) => readLiveSessions({ ...filter, now: NOW, readMap: async () => map, readSubagents: async () => subagents }));
    try {
      expect(await cmdLiveSessions(['--live', '--json'], read)).toBe(0);
      expect(read).toHaveBeenLastCalledWith({ lane: null, repo: null, live: true });
      expect(JSON.parse(out[0]!)).toMatchObject({ schema: 'fleet.live-sessions.v1', live: true, tree: { schema: 'fleet.session-tree.v1', version: 1, counts: { done: 0, failed: 0 } } });
      expect(await cmdLiveSessions([], read)).toBe(0);
      expect(out[1]!.split('\n')[0]).toBe('4 sessions running: 2 workers, 2 subagents; 1 failed in the last hour; 1 with state unknown; 1 under unknown parent');
    } finally { log.mockRestore(); }
    const api = async (url: string) => {
      let status = 0;
      const res = { writeHead: (code: number) => { status = code; return res; }, setHeader: () => res, end: () => {} } as unknown as ServerResponse;
      const apiRead = vi.fn(async () => buildLiveSessions(map, NOW));
      await createFleetLiveSessionsApi(apiRead)({ readSession: { expiresAt: Date.now() + 60_000 } } as never, { url } as IncomingMessage, res, url.split('?')[0]!, 'GET');
      return { status, apiRead };
    };
    const ok = await api('/api/verse/fleet/control/live-sessions?live=1&lane=claude');
    expect(ok.status).toBe(200);
    expect(ok.apiRead).toHaveBeenCalledWith({ lane: 'claude', repo: null, live: true });
    expect((await api('/api/verse/fleet/control/live-sessions?live=yes')).status).toBe(400);
  });
});

describe('the leader row, from the leader\'s own records', () => {
  const facts: LeaderSessionFacts = { lastPassAt: ago(20), lastReplyAt: ago(30), lastReply: 'Queued two jobs\nfor the desk lanes.' };
  const nothing: LeaderSessionFacts = { lastPassAt: null, lastReplyAt: null, lastReply: null };

  it('reads as idle between passes with its last reply on one line, and names only what is still unknown', () => {
    const list = buildLiveSessions(map, NOW, { subagents, leader: facts });
    expect(list.tree.roots[0]).toMatchObject({ id: 'leader', kind: 'leader', state: 'idle', lane: 'unknown', model: 'unknown', startedAt: null,
      lastMessageAt: ago(30), lastMessageAgeSeconds: 1800, lastMessage: 'Queued two jobs for the desk lanes.' });
    expect(list.tree.line).toBe('4 sessions running: 2 workers, 2 subagents; 1 failed in the last hour; 1 under unknown parent');
    expect(list.tree.counts).toMatchObject({ idle: 2, unknown: 0, leaders: 1 });
    expect(list.gaps).toEqual(['Leader model unknown: no source records the model its passes run on.']);
    expect(renderLiveSessionsText(list)).toContain('\nleader | model unknown | repo unknown | idle | spoke 30m ago | Queued two jobs for the desk lanes.\n');
  });

  it('keeps the state unknown when the last pass is old, missing or dated ahead, and never guesses a reply time', () => {
    const stale = buildLiveSessions(map, NOW, { subagents, leader: { ...facts, lastPassAt: ago(185) } });
    expect(stale.tree.roots[0]).toMatchObject({ state: 'unknown', lastMessage: 'Queued two jobs for the desk lanes.', lastMessageAgeSeconds: 1800 });
    expect(stale.tree.line).toContain('1 with state unknown');
    expect(stale.gaps).toEqual(['Leader state unknown: its last recorded pass ended 3h 5m ago.', 'Leader model unknown: no source records the model its passes run on.']);
    expect(leaderRecord({ lastPassAt: ago(-5), lastReplyAt: ago(-5), lastReply: 'Ahead of the clock' }, NOW)).toMatchObject({ state: 'unknown', lastMessageAt: null, lastMessage: 'Ahead of the clock' });
    expect(leaderRecord({ ...facts, lastReplyAt: 'not a time' }, NOW)).toMatchObject({ state: 'idle', lastMessageAt: null });
    expect(leaderGaps({ lastPassAt: null, lastReplyAt: null, lastReply: 'A reply' }, NOW)).toEqual(['Leader state unknown: its plan log records no pass with a readable time.', 'Leader model unknown: no source records the model its passes run on.']);
    expect(leaderGaps({ lastPassAt: ago(5), lastReplyAt: null, lastReply: null }, NOW)).toEqual(['Leader messages unknown: no reply to you is recorded yet.', 'Leader model unknown: no source records the model its passes run on.']);
    const long = leaderRecord({ ...facts, lastReply: 'y'.repeat(400) }, NOW).lastMessage!;
    expect([long.length, long.endsWith('…')]).toEqual([240, true]);
    expect(leaderRecord({ ...facts, lastReply: ' \n ' }, NOW)).toMatchObject({ lastMessage: null, lastMessageAt: null });
    // No fact at all is the list older readers print, byte for byte.
    expect(JSON.stringify(buildLiveSessions(map, NOW, { subagents, leader: nothing }))).toBe(JSON.stringify(buildLiveSessions(map, NOW, { subagents })));
    expect(leaderGaps(nothing, NOW)).toEqual(['Leader state, model and messages unknown: no source records the leader session yet.']);
  });

  it('lists the leader alone when it has records and no worker runs, but not under a lane or repo filter', () => {
    const none = { ...map, sessions: [], mapSessions: [], recent: [] } as unknown as FleetSessionMap;
    const alone = buildLiveSessions(none, NOW, { leader: facts });
    expect(shape(alone.tree.roots)).toEqual([['leader', 'leader', 'idle']]);
    expect(alone.tree.line).toBe('No agent sessions running');
    expect(alone.counts.sessions).toBe(0);
    expect(buildLiveSessions(none, NOW, { leader: facts, lane: 'claude' }).tree.roots).toEqual([]);
    expect(buildLiveSessions(none, NOW, { leader: nothing }).tree.roots).toEqual([]);
    expect(buildLiveSessions(none, NOW).gaps).toEqual([]);
  });

  it('reads the last pass and the newest reply from the leader files, and stays unknown when they are absent or unreadable', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'leader-session-'));
    vi.stubEnv('PHANTOM_PLAN_LOG', '');
    try {
      expect(await readLeaderSessionFacts({ runsDir, now: NOW })).toEqual(nothing);
      mkdirSync(join(runsDir, 'leader'));
      writeFileSync(join(runsDir, 'leader', 'PLAN-LOG.md'), '# Plan\n## 2026-11-18T11:10:00Z\n- earlier pass\n## 2026-11-18T11:40:00Z\n- planning only\n');
      writeFileSync(join(runsDir, 'leader', 'MASON-OUTBOX.md'), '## 2026-11-18T11:15:00Z\nOlder answer\n## 2026-11-18T11:30:00Z\nQueued two jobs\nfor the desk lanes.\n');
      expect(await readLeaderSessionFacts({ runsDir, now: NOW })).toEqual(facts);
      const base = { now: NOW, readMap: async () => map, readSubagents: async () => subagents };
      const list = await readLiveSessions({ ...base, readLeader: at => readLeaderSessionFacts({ runsDir, now: at }) });
      expect(JSON.stringify(list)).toBe(JSON.stringify(buildLiveSessions(map, NOW, { subagents, leader: facts })));
      const unread = await readLiveSessions({ ...base, readLeader: async () => { throw new Error('unreadable'); } });
      expect(unread.tree.roots[0]).toMatchObject({ state: 'unknown', lastMessage: null });
      expect(unread.gaps).toEqual(['Leader state, model and messages unknown: no source records the leader session yet.']);
    } finally { vi.unstubAllEnvs(); rmSync(runsDir, { recursive: true, force: true }); }
  });
});
