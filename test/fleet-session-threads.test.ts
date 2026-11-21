/**
 * `fleet.session-threads.v1`: every session as a short conversation in one
 * read, behind `phm sessions threads` and GET
 * /api/verse/fleet/control/session-threads. Fixtures only: no runs directory,
 * bus, inbox or plan log is read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentMessage, AgentMessages } from '../src/core/fleet/agent-messages.js';
import type { FleetCompute } from '../src/core/fleet/compute-view.js';
import type { InboxEntry } from '../src/core/fleet/mason-inbox.js';
import type { LeaderRepliesV1 } from '../src/core/fleet/mason-outbox.js';
import type { OrderTraceJob, OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { FleetJobActivityV1 } from '../src/core/fleet/runs-job-activity.js';
import type { FleetSessionV1, FleetSessionsV1 } from '../src/core/fleet/runs-sessions.js';
import { buildLiveSessions } from '../src/core/fleet/live-sessions.js';
import { buildSessionThread, type SessionThreadOutputRead, type SessionThreadOwnerRead } from '../src/core/fleet/session-thread.js';
import {
  buildSessionThreads, renderSessionThreadsText, threadSessions, THREADS_MAX, THREADS_MESSAGES_SHOWN, THREADS_TEXT_CHARS, type SessionThreadsV1,
} from '../src/core/fleet/session-threads.js';
import { readSessionThreads } from '../src/core/fleet/session-threads-read.js';
import { readFleetSessionMap } from '../src/core/fleet/sessions-view.js';
import { createFleetSessionThreadsApi, defaultSessionThreadsRead } from '../src/core/verse/fleet-session-threads-api.js';
import { handleFleetControlApi } from '../src/core/verse/fleet-control-api.js';
import { cmdSessions, cmdSessionThreads } from '../src/cli/sessions.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const session = (job: string, over: Partial<FleetSessionV1> = {}): FleetSessionV1 => ({
  job, repo: 'phantom', lane: 'claude', tier: 'frontier', status: 'running', model: 'fixture-model', batchId: null, pid: null, live: 'yes',
  exitCode: null, timedOut: false, enqueuedAt: ago(40), claimedAt: ago(31), launchedAt: ago(30), startedAt: ago(30), finishedAt: null,
  elapsedSeconds: 1800, durationSeconds: null, queueWaitSeconds: 540, tokensTotal: null, wallSeconds: null, diffLines: null,
  outcome: null, prUrl: null, lastOutputAt: ago(2), ...over,
});
const inventory = (sessions: FleetSessionV1[]): FleetSessionsV1 => ({
  schema: 'fleet.sessions.v1', generatedAt: ago(0), runsDirPresent: true, sourceState: 'healthy',
  sources: { runDir: 'healthy', ready: 'healthy', claimed: 'healthy', precheck: 'healthy', status: 'healthy', metrics: 'healthy', live: 'healthy' },
  dispatcher: null, sessions, recent: [], counts: { queued: 0, parked: 0, launching: 0, running: sessions.length, publishing: 0, exited: 0, stale: 0 },
  malformed: 0, truncated: false,
});
const compute: FleetCompute = { schema: 'fleet.compute.v1', generatedAt: ago(0), localNodeId: 'node-here', truncated: false, nodes: [], sources: {}, dispatcherAt: null, lanes: {} };
const TWO = [session('RQ-A'), session('RQ-QUIET', { lastOutputAt: ago(25), lane: 'codex' })];
const fleetMap = (sessions: FleetSessionV1[] = TWO) => readFleetSessionMap({ compute, now: NOW, readDetail: async () => { throw new Error('no details'); }, sessions: inventory(sessions) });

const activity = (job = 'RQ-A', brief = 'Fix the reply box.'): FleetJobActivityV1 => ({
  schema: 'fleet.job.activity.v1', generatedAt: ago(0), job, state: 'running', lane: 'claude', tier: 'frontier', model: 'fixture-model',
  sources: { events: 'healthy', commands: 'healthy', files: 'healthy', reports: 'healthy' }, counts: { events: 2, commands: 1, files: 0, reports: 1 }, truncated: false,
  entries: [
    { kind: 'report', name: 'brief', state: 'ok', source: 'prompt', bytes: brief.length, truncated: false, text: brief },
    { kind: 'event', at: ago(30), event: 'launch', summary: 'lane=claude' },
    { kind: 'event', at: ago(4), event: 'verify', summary: 'tests green' },
    { kind: 'command', text: 'npm run test', line: 1 },
  ] as FleetJobActivityV1['entries'],
});
const message = (id: string, from: string, to: string, over: Partial<AgentMessage> = {}): AgentMessage => ({
  id, ts: ago(5), from: { name: from, lane: null }, to: { name: to, lane: null }, kind: 'status', summary: `${from} says ${id}`, conversation: 'c', job: null, pr: null, ...over,
});
const bus = (messages: AgentMessage[], source: AgentMessages['source'] = 'available'): AgentMessages => ({ schema: 'agent-messages.v1', source, messages, matched: messages.length, skipped: 0 });
const replies = (texts: string[], sourceState: LeaderRepliesV1['sourceState'] = 'healthy'): LeaderRepliesV1 => ({
  schema: 'leader.replies.v1', version: 1, sourceState, entries: [], replies: texts.map(text => ({ at: '2026-11-17 06:51', text, source: 'plan-log' })),
});
/** Inbox entries as the reader returns them: newest first, Eastern wall time to the minute (06:40 ET is 11:40Z on this day). */
const wrote = (at: string, text: string, over: Partial<InboxEntry> = {}): InboxEntry => ({ at: `2026-11-17 ${at}`, source: 'desktop', priority: null, text, ...over });
const inbox = (entries: InboxEntry[], sourceState: SessionThreadOwnerRead['sourceState'] = 'healthy'): SessionThreadOwnerRead => ({ sourceState, entries });
const routedJob = (id: string, state: OrderTraceJob['state'], over: Partial<OrderTraceJob> = {}): OrderTraceJob => ({ id, lane: 'claude', state, url: null, ...over });
/** The order trace as `readOrderTrace` returns it: one order per inbox entry, with the jobs whose prompts cite it. */
const trace = (orders: Array<[entry: InboxEntry, jobs: OrderTraceJob[]]>, sources: Partial<OrderTraceV1['sources']> = {}): OrderTraceV1 => ({
  v: 1, generatedAt: ago(0), sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy', queue: 'healthy', ...sources },
  orders: orders.map(([entry, jobs]) => ({ at: entry.at, source: entry.source, key: entry.at.slice(5), jobs })),
});
const liveList = async (sessions?: FleetSessionV1[], filter: { live?: boolean } = {}) => buildLiveSessions(await fleetMap(sessions), NOW, { subagents: [], ...filter });
const none = new Map<string, FleetJobActivityV1 | null>();

afterEach(() => vi.restoreAllMocks());

describe('buildSessionThreads', () => {
  it('gives every session its summary and newest messages, leader first', async () => {
    const read = buildSessionThreads(await liveList(), { sessionsRead: true, activity: new Map([['RQ-A', activity()]]), replies: replies(['On it.']),
      bus: bus([message('m1', 'leader', 'RQ-A', { ts: ago(8), kind: 'ask' }), message('m2', 'RQ-A', 'leader', { ts: ago(3) })]) }, NOW);
    expect(read).toMatchObject({ schema: 'fleet.session-threads.v1', generatedAt: ago(0), filter: { lane: null, repo: null, live: false },
      counts: { sessions: 3, shown: 3, states: { running: 1, quiet: 1, idle: 0, done: 0, failed: 0, unknown: 1 } },
      sources: { sessions: 'available', bus: 'available', owner: 'none', replies: 'available' } });
    expect(read.threads.map(entry => entry.session.id)).toEqual(['leader', 'RQ-A', 'RQ-QUIET']);
    const [leader, worker, quiet] = read.threads as [SessionThreadsV1['threads'][number], SessionThreadsV1['threads'][number], SessionThreadsV1['threads'][number]];
    expect(leader.messages.map(m => m.key)).toEqual(['bus:m1', 'bus:m2', 'reply:0']);
    expect(leader.messages.at(-1)).toMatchObject({ label: 'Leader to Mason', text: 'On it.', truncated: false });
    // The worker's thread holds brief, two steps, commands and two bus messages; the read keeps the newest three.
    expect(worker.messageCount).toBe(6);
    expect(worker.messages.map(m => `${m.key}|${m.side}`)).toEqual(['commands|session', 'bus:m1|other', 'bus:m2|session']);
    expect(worker.summary).toEqual(['Worker on claude, fixture-model, in phantom.', 'Running for 30m; spoke 2m ago.', '1 command seen, changed files unknown.', `Latest step: verify tests green at ${ago(4)}.`]);
    expect(worker.sources).toMatchObject({ sessions: 'available', activity: 'available', bus: 'available', owner: 'none', replies: 'none' });
    expect(worker.sources).toEqual(buildSessionThread(await liveList(), 'RQ-A', { sessionsRead: true, bus: bus([message('m1', 'leader', 'RQ-A')]), activity: activity() }, NOW).sources);
    expect(quiet).toMatchObject({ session: { state: 'quiet', lane: 'codex' }, messages: [], messageCount: 0, sources: { activity: 'none', bus: 'none' } });
  });

  it('matches the single-session thread for the same records', async () => {
    const list = await liveList(), parts = { bus: bus([message('m1', 'leader', 'RQ-A')]), replies: replies(['one', 'two']),
      owner: inbox([wrote('06:55', '@RQ-A keep the draft', { id: 'desk-2' }), wrote('06:50', 'How is the fleet?', { id: 'tg-1' })]) };
    const read = buildSessionThreads(list, { sessionsRead: true, activity: new Map([['RQ-A', activity()]]), ...parts }, NOW);
    for (const entry of read.threads) {
      const id = entry.session.id;
      const single = buildSessionThread(list, id, { sessionsRead: true, bus: parts.bus, owner: parts.owner, ...(id === 'RQ-A' ? { activity: activity() } : {}), ...(id === 'leader' ? { replies: parts.replies } : {}) }, NOW);
      expect(entry.session).toEqual(single.session);
      expect(entry.summary).toEqual(single.summary);
      expect(entry.messageCount).toBe(single.messages.length);
      expect(entry.messages.map(({ truncated: _cut, ...rest }) => rest)).toEqual(single.messages.slice(-THREADS_MESSAGES_SHOWN));
      expect(entry.sources).toEqual(single.sources);
      expect(entry.gaps).toEqual(single.gaps);
      expect(entry.reply).toEqual(single.reply);
    }
  });

  it('says where a reply to each session goes, as the entry\'s last key', async () => {
    const read = buildSessionThreads(await liveList(), { sessionsRead: true, bus: bus([]), activity: new Map() }, NOW);
    expect(read.threads.map(entry => [entry.session.id, entry.reply.to, entry.reply.mention])).toEqual([['leader', 'leader', null], ['RQ-A', 'job', '@RQ-A'], ['RQ-QUIET', 'job', '@RQ-QUIET']]);
    for (const entry of read.threads) {
      expect(Object.keys(entry).at(-1)).toBe('reply');
      expect(entry.reply.hint).not.toBe('');
    }
  });

  it('carries what Mason wrote: every message on the leader, the aimed ones on that worker, none on the rest', async () => {
    const entries = [
      wrote('06:55', '@RQ-A also keep the draft', { channel: 'desktop', id: 'desk-2' }), wrote('06:50', 'How is the fleet?', { channel: 'telegram', id: 'tg-1' }),
      wrote('06:40', 'Stop, @RQ-A. Use the shared form.', { channel: 'desktop', id: 'desk-1' }),
    ];
    const read = buildSessionThreads(await liveList(), { sessionsRead: true, bus: bus([]), activity: none, owner: inbox(entries) }, NOW);
    const [leader, worker, quiet] = read.threads as [SessionThreadsV1['threads'][number], SessionThreadsV1['threads'][number], SessionThreadsV1['threads'][number]];
    expect(read.sources.owner).toBe('available');
    expect(leader.messages.map(m => [m.key, m.side, m.label])).toEqual([
      ['owner:desk-1', 'other', 'Mason to Leader, from desktop'], ['owner:tg-1', 'other', 'Mason to Leader, from telegram'], ['owner:desk-2', 'other', 'Mason to Leader, from desktop'],
    ]);
    expect(worker.messages.map(m => [m.key, m.kind, m.at, m.text])).toEqual([
      ['owner:desk-1', 'owner', '2026-11-17T11:40:00.000Z', 'Stop, @RQ-A. Use the shared form.'], ['owner:desk-2', 'owner', '2026-11-17T11:55:00.000Z', '@RQ-A also keep the draft'],
    ]);
    expect(worker.summary.at(-1)).toBe('Mason aimed 2 messages at it through the Leader inbox, the newest at 2026-11-17T11:55:00.000Z.');
    expect([leader.sources.owner, worker.sources.owner, quiet.sources.owner, quiet.messageCount]).toEqual(['available', 'available', 'none', 0]);
    expect(renderSessionThreadsText(read)).toContain('  > Mason to the Leader, aimed at RQ-A, from desktop [2026-11-17T11:55:00.000Z]: @RQ-A also keep the draft');
  });

  it('tells an unreadable inbox from an empty one and from one nobody asked for', async () => {
    for (const owner of [null, inbox([wrote('06:40', '@RQ-A hi')], 'degraded')]) {
      const read = buildSessionThreads(await liveList(), { sessionsRead: true, bus: bus([]), activity: none, owner }, NOW);
      expect(read.sources.owner).toBe('unavailable');
      expect(read.gaps).toContain('Messages from Mason unknown: the Leader inbox could not be read.');
      expect(read.threads.map(entry => [entry.sources.owner, entry.messages.filter(m => m.kind === 'owner').length])).toEqual([['unavailable', 0], ['unavailable', 0], ['unavailable', 0]]);
    }
    for (const owner of [inbox([], 'missing'), inbox([wrote('06:40', 'nobody named')]), undefined]) {
      const read = buildSessionThreads(await liveList([session('RQ-A')]), { sessionsRead: true, bus: bus([]), activity: none, ...(owner ? { owner } : {}) }, NOW);
      expect(read.threads.find(entry => entry.session.id === 'RQ-A')!.sources.owner).toBe('none');
      expect(read.gaps).not.toContain('Messages from Mason unknown: the Leader inbox could not be read.');
    }
  });

  it('cuts long message text and says so', async () => {
    const long = 'word '.repeat(200).trim();
    const read = buildSessionThreads(await liveList([session('RQ-A')]), { sessionsRead: true, bus: bus([]), activity: new Map([['RQ-A', activity('RQ-A', long)]]) }, NOW);
    const brief = read.threads.find(entry => entry.session.id === 'RQ-A')!.messages.find(m => m.kind === 'brief');
    expect(brief).toBeUndefined(); // The brief is the oldest of four messages, so it is outside the newest three.
    const only = buildSessionThreads(await liveList([session('RQ-A')]), { sessionsRead: true, bus: bus([message('m1', 'leader', 'RQ-A', { summary: long })]), activity: none }, NOW);
    const cut = only.threads.find(entry => entry.session.id === 'RQ-A')!.messages[0]!;
    expect(cut.truncated).toBe(true);
    expect(cut.text.length).toBeLessThanOrEqual(THREADS_TEXT_CHARS);
    expect(cut.text.endsWith('…')).toBe(true);
  });

  it('reads an unreadable list as unknown, never as no sessions', () => {
    const read = buildSessionThreads(buildLiveSessions(null, NOW), { sessionsRead: false, bus: null, activity: none }, NOW);
    expect(read).toMatchObject({ counts: { sessions: 0, shown: 0 }, threads: [], sources: { sessions: 'unavailable', bus: 'none', owner: 'none', replies: 'none' },
      gaps: ['Sessions unknown: the session list could not be read.'] });
    expect(renderSessionThreadsText(read)).toBe('Sessions unknown: the session list could not be read.');
  });

  it('names a failed bus, replies or activity read and keeps the rest', async () => {
    const read = buildSessionThreads(await liveList(), { sessionsRead: true, bus: null, replies: null, activity: new Map([['RQ-A', null]]) }, NOW);
    expect(read.sources).toEqual({ sessions: 'available', bus: 'unavailable', owner: 'none', replies: 'unavailable', orders: 'none' });
    expect(read.gaps).toContain('Bus messages unknown: the agent bus could not be read.');
    expect(read.threads).toHaveLength(3);
    expect(read.threads[1]).toMatchObject({ session: { id: 'RQ-A' }, sources: { activity: 'unavailable', bus: 'unavailable' } });
    expect(read.threads[1]!.gaps).toContain('Activity unknown: this session\'s recorded activity could not be read.');
    expect(read.threads[0]!.gaps).toContain('Leader replies unknown: the plan log could not be read.');
    // A bus that answered with nothing for anyone is "none", not "unavailable".
    expect(buildSessionThreads(await liveList(), { sessionsRead: true, bus: bus([]), activity: none }, NOW).sources).toMatchObject({ bus: 'none', owner: 'none', replies: 'none' });
  });

  it('carries where the Leader routed a message into the leader\'s thread and the serving worker\'s', async () => {
    const ask = wrote('06:20', 'Fix the reply box.', { id: 'desk-0' });
    const jobs = [routedJob('RQ-A', 'launched'), routedJob('RQ-B', 'queued', { lane: null })];
    const list = await liveList(), parts = { sessionsRead: true, bus: bus([]), activity: none, owner: inbox([ask]) };
    const read = buildSessionThreads(list, { ...parts, orders: trace([[ask, jobs]]) }, NOW);
    const [leader, worker, quiet] = read.threads as [SessionThreadsV1['threads'][number], SessionThreadsV1['threads'][number], SessionThreadsV1['threads'][number]];
    expect(leader.messages.map(m => [m.key, m.kind, m.side])).toEqual([['owner:desk-0', 'owner', 'other'], ['routing:desk-0', 'routing', 'record']]);
    expect(leader.messages[1]!.text.split('\n')).toEqual(['RQ-A, on claude: launched', 'RQ-B, lane unknown: queued']);
    expect(worker.messages.map(m => m.key)).toEqual(['order:desk-0', 'routing:desk-0']);
    expect(worker.summary.join(' ')).toContain('Serves Mason\'s message of 2026-11-17 06:20 ET');
    expect([read.sources.orders, leader.sources.orders, worker.sources.orders, quiet.sources.orders]).toEqual(['available', 'available', 'available', 'none']);
    // Each entry is the single thread built from the same trace, so the two reads cannot disagree about routing.
    for (const entry of [leader, worker]) {
      expect(entry.sources).toEqual(buildSessionThread(list, entry.session.id, { sessionsRead: true, bus: parts.bus, owner: parts.owner, orders: trace([[ask, jobs]]) }, NOW).sources);
    }
    // A trace that could not be read is unknown routing, named once for the read; the conversations stay.
    for (const orders of [null, trace([[ask, jobs]], { inbox: 'degraded' })]) {
      const blind = buildSessionThreads(list, { ...parts, orders }, NOW);
      expect(blind.sources.orders).toBe('unavailable');
      expect(blind.gaps).toContain('Routing unknown: the order trace could not be read.');
      expect(blind.threads.map(entry => entry.messages.filter(m => m.kind === 'routing' || m.kind === 'order').length)).toEqual([0, 0, 0]);
      expect(blind.threads[0]!.messages.map(m => m.key)).toEqual(['owner:desk-0']);
    }
    // Not asked for, or nothing routed: none, and no gap.
    for (const orders of [undefined, trace([[ask, []]])]) {
      const plain = buildSessionThreads(list, { ...parts, ...(orders ? { orders } : {}) }, NOW);
      expect([plain.sources.orders, plain.gaps.some(gap => gap.startsWith('Routing'))]).toEqual(['none', false]);
    }
  });

  it('holds at most THREADS_MAX sessions and counts the rest', async () => {
    const many = Array.from({ length: THREADS_MAX + 4 }, (_, index) => session(`RQ-N${String(index).padStart(2, '0')}`));
    const list = await liveList(many);
    expect(threadSessions(list)).toMatchObject({ total: THREADS_MAX + 5 });
    const read = buildSessionThreads(list, { sessionsRead: true, bus: bus([]), activity: none }, NOW);
    expect(read.counts).toMatchObject({ sessions: THREADS_MAX + 5, shown: THREADS_MAX });
    expect(read.threads).toHaveLength(THREADS_MAX);
    expect(read.gaps).toContain(`5 more sessions not shown: the read holds ${THREADS_MAX}. Narrow it with a lane or repo, or ask for running ones only.`);
  });

  it('renders every session for people on a few lines each', async () => {
    const text = renderSessionThreadsText(buildSessionThreads(await liveList(), { sessionsRead: true, activity: new Map([['RQ-A', activity()]]),
      bus: bus([message('m1', 'leader', 'RQ-A', { summary: 'please\nrebase' })]) }, NOW));
    const lines = text.split('\n');
    expect(lines[0]).toBe('3 sessions: 1 running, 1 quiet, 1 state unknown.');
    expect(text).toContain('\nRQ-A | worker | running\n  Worker on claude, fixture-model, in phantom. Running for 30m; spoke 2m ago.');
    expect(text).toContain('  (2 earlier)\n');
    expect(text).toContain(`  > leader to RQ-A, status [${ago(5)}]: please rebase`);
    expect(text).toContain('\nRQ-QUIET | worker | quiet\n  Worker on codex, fixture-model, in phantom. Quiet: no output for 25m.\n  Nothing is recorded for this session yet.');
    expect(lines.at(-1)).toBe(`Open one: phm sessions thread <id>. Updated ${ago(0)}.`);
    const empty = renderSessionThreadsText({ ...buildSessionThreads(await liveList([]), { sessionsRead: true, bus: bus([]), activity: none }, NOW), threads: [],
      counts: { sessions: 0, shown: 0, states: { running: 0, quiet: 0, idle: 0, done: 0, failed: 0, unknown: 0 } }, filter: { lane: 'codex', repo: null, live: true } });
    expect(empty.split('\n')[0]).toBe('No sessions (lane codex, running only).');
  });
});

describe('readSessionThreads', () => {
  const reads = () => ({
    readMap: vi.fn(() => fleetMap()), readSubagents: vi.fn(async () => []), readLeader: vi.fn(async () => null),
    readActivity: vi.fn(async (job: string) => activity(job)), readBus: vi.fn(() => bus([message('m1', 'leader', 'RQ-A')])), readReplies: vi.fn(async () => replies(['hello'])),
    readOwner: vi.fn(async () => inbox([wrote('06:55', '@RQ-A keep the draft', { id: 'desk-2' })])),
    readOrders: vi.fn(async () => trace([[wrote('06:55', '@RQ-A keep the draft', { id: 'desk-2' }), [routedJob('RQ-A', 'launched'), routedJob('RQ-B', 'queued')]]])),
  });

  it('reads the list, the bus, the inbox and the replies once, and each shown job once', async () => {
    const all = reads();
    const read = await readSessionThreads({ now: NOW, ...all });
    expect(read.threads.map(entry => entry.session.id)).toEqual(['leader', 'RQ-A', 'RQ-QUIET']);
    expect(all.readMap).toHaveBeenCalledTimes(1);
    expect(all.readBus).toHaveBeenCalledTimes(1);
    expect(all.readReplies).toHaveBeenCalledTimes(1);
    expect(all.readOwner).toHaveBeenCalledTimes(1);
    expect(all.readOrders).toHaveBeenCalledTimes(1);
    expect([read.sources.orders, read.threads[0]!.messages.at(-1)?.kind]).toEqual(['available', 'routing']);
    expect(read.sources.owner).toBe('available');
    expect(read.threads[1]!.messages.map(m => m.key)).toContain('owner:desk-2');
    expect(read.threads[2]!.messages.some(m => m.kind === 'owner')).toBe(false);
    expect(all.readActivity.mock.calls.map(call => call[0]).sort()).toEqual(['RQ-A', 'RQ-QUIET']);
    expect(read.threads[1]!.sources.activity).toBe('available');
  });

  it('applies the lane filter and skips the leader replies when the leader is not listed', async () => {
    const codex = reads();
    const read = await readSessionThreads({ now: NOW, lane: 'codex', ...codex });
    expect(read.filter).toEqual({ lane: 'codex', repo: null, live: false });
    expect(read.threads.map(entry => entry.session.id).filter(id => id !== 'leader')).toEqual(['RQ-QUIET']);
    expect(codex.readActivity.mock.calls.map(call => call[0])).toEqual(['RQ-QUIET']);
    if (!read.threads.some(entry => entry.session.kind === 'leader')) expect(codex.readReplies).not.toHaveBeenCalled();
    expect((await readSessionThreads({ now: NOW, live: true, ...reads() })).filter.live).toBe(true);
  });

  it('keeps the other threads when one read fails, and reads an unreadable list as unknown', async () => {
    const read = await readSessionThreads({ now: NOW, ...reads(), readBus: () => { throw new Error('y'); },
      readActivity: async job => { if (job === 'RQ-A') throw new Error('x'); return activity(job); } });
    expect(read.sources.bus).toBe('unavailable');
    expect(read.sources.owner).toBe('available');
    const noInbox = await readSessionThreads({ now: NOW, ...reads(), readOwner: async () => { throw new Error('z'); } });
    expect([noInbox.sources.owner, noInbox.sources.bus, noInbox.threads.length]).toEqual(['unavailable', 'available', 3]);
    expect(noInbox.gaps).toContain('Messages from Mason unknown: the Leader inbox could not be read.');
    const noTrace = await readSessionThreads({ now: NOW, ...reads(), readOrders: async () => { throw new Error('t'); } });
    expect([noTrace.sources.orders, noTrace.sources.owner, noTrace.threads.length]).toEqual(['unavailable', 'available', 3]);
    expect(noTrace.gaps).toContain('Routing unknown: the order trace could not be read.');
    expect(read.threads.map(entry => [entry.session.id, entry.sources.activity])).toEqual([['leader', 'none'], ['RQ-A', 'unavailable'], ['RQ-QUIET', 'available']]);
    const down = reads();
    const unread = await readSessionThreads({ now: NOW, ...down, readMap: async () => { throw new Error('runs dir unreadable'); } });
    expect(unread).toMatchObject({ threads: [], sources: { sessions: 'unavailable' } });
    expect(down.readBus).not.toHaveBeenCalled();
    expect(down.readOwner).not.toHaveBeenCalled();
    expect(down.readOrders).not.toHaveBeenCalled();
    expect(down.readActivity).not.toHaveBeenCalled();
  });

  it('scrubs secret-shaped text', async () => {
    const secret = `ghp_${'a'.repeat(36)}`;
    const read = await readSessionThreads({ now: NOW, ...reads(), readBus: () => bus([message('m1', 'leader', 'RQ-A', { summary: `token ${secret}` })]),
      readOwner: async () => inbox([wrote('06:55', `@RQ-A use ${secret}`)]) });
    expect(read.threads[1]!.messages.some(m => m.kind === 'owner')).toBe(true);
    expect(JSON.stringify(read)).not.toContain(secret);
  });
});

describe('GET /api/verse/fleet/control/session-threads', () => {
  const PATH = '/api/verse/fleet/control/session-threads';
  const built = async () => buildSessionThreads(await liveList(), { sessionsRead: true, bus: bus([]), activity: none }, NOW);
  const call = async (url: string, opts: { session?: boolean; method?: string; read?: () => Promise<unknown> } = {}) => {
    const read = vi.fn(opts.read ?? built);
    let status = 0, body = '';
    const res = { writeHead: (code: number) => { status = code; return res; }, setHeader: () => res, end: (chunk?: string) => { body = chunk ?? ''; } } as unknown as ServerResponse;
    const ctx = { readSession: opts.session === false ? undefined : { expiresAt: Date.now() + 60_000 } } as never;
    const handled = await createFleetSessionThreadsApi(read as never)(ctx, { url } as IncomingMessage, res, url.split('?')[0]!, opts.method ?? 'GET');
    return { handled, status, body: body ? JSON.parse(body) : null, read };
  };

  it('serves the threads with a read session and validates the query', async () => {
    const ok = await call(PATH);
    expect(ok).toMatchObject({ handled: true, status: 200, body: { schema: 'fleet.session-threads.v1', counts: { shown: 3 } } });
    expect(ok.read).toHaveBeenCalledWith({ lane: null, repo: null });
    expect((await call(`${PATH}?lane=codex&repo=phantom&live=1`)).read).toHaveBeenCalledWith({ lane: 'codex', repo: 'phantom', live: true });
    expect((await call(PATH, { session: false })).status).toBe(401);
    expect((await call(PATH, { method: 'POST' })).status).toBe(405);
    for (const bad of ['?id=RQ-A', '?lane=a&lane=b', '?live=yes', '?lane=..%2Fetc', '?repo=']) {
      const refused = await call(`${PATH}${bad}`);
      expect([bad, refused.status]).toEqual([bad, 400]);
      expect(refused.read).not.toHaveBeenCalled();
    }
    expect((await call('/api/verse/fleet/control/session-thread')).handled).toBe(false);
  });

  it('answers 503 when the session list cannot be read', async () => {
    expect((await call(PATH, { read: async () => buildSessionThreads(buildLiveSessions(null, NOW), { sessionsRead: false, bus: null, activity: none }, NOW) })))
      .toMatchObject({ status: 503, body: { error: 'Sessions unavailable.' } });
    expect((await call(PATH, { read: async () => { throw new Error('x'); } })).status).toBe(503);
  });

  it('is routed by the fleet control API and refuses a caller with no read session', async () => {
    let status = 0;
    const res = { writeHead: (code: number) => { status = code; return res; }, setHeader: () => res, end: () => {} } as unknown as ServerResponse;
    expect(await handleFleetControlApi({} as never, { url: PATH } as IncomingMessage, res, PATH, 'GET')).toBe(true);
    expect(status).toBe(401);
    expect(typeof defaultSessionThreadsRead()).toBe('function');
  });
});

describe('phm sessions threads', () => {
  const run = async (args: string[], read: Parameters<typeof cmdSessionThreads>[1] = async () => buildSessionThreads(await liveList(), { sessionsRead: true, bus: bus([]), activity: none }, NOW)) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await cmdSessionThreads(args, read);
    return { code, out: log.mock.calls.map(call => String(call[0])).join('\n'), err: stderr.mock.calls.map(call => String(call[0])).join('') };
  };

  it('prints every session as text or JSON and passes the filters on', async () => {
    const text = await run([]);
    expect(text.code).toBe(0);
    expect(text.out.split('\n')[0]).toBe('3 sessions: 1 running, 1 quiet, 1 state unknown.');
    vi.restoreAllMocks();
    const read = vi.fn(async () => buildSessionThreads(await liveList(), { sessionsRead: true, bus: bus([]), activity: none }, NOW));
    const json = await run(['--lane', 'codex', '--repo', 'phantom', '--live', '--json'], read);
    expect(read).toHaveBeenCalledWith({ lane: 'codex', repo: 'phantom', live: true });
    expect(JSON.parse(json.out)).toMatchObject({ schema: 'fleet.session-threads.v1', threads: [{ session: { id: 'leader' } }, { session: { id: 'RQ-A' } }, { session: { id: 'RQ-QUIET' } }] });
  });

  it('exits 2 for bad usage and 1 when sessions cannot be read', async () => {
    for (const args of [['RQ-A'], ['--follow'], ['--lane', '../etc'], ['--repo', '']]) {
      vi.restoreAllMocks();
      const read = vi.fn();
      const result = await run(args, read as never);
      expect([args, result.code]).toEqual([args, 2]);
      expect(result.err).toContain('Usage: phm sessions threads');
      expect(read).not.toHaveBeenCalled();
    }
    vi.restoreAllMocks();
    const down = await run([], async () => buildSessionThreads(buildLiveSessions(null, NOW), { sessionsRead: false, bus: null, activity: none }, NOW));
    expect(down).toMatchObject({ code: 1, out: '', err: 'Sessions unknown: the session list could not be read.\n' });
    vi.restoreAllMocks();
    const json = await run(['--json'], async () => buildSessionThreads(buildLiveSessions(null, NOW), { sessionsRead: false, bus: null, activity: none }, NOW));
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out).sources.sessions).toBe('unavailable');
  });

  it('is listed in the sessions help', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await cmdSessions(['threads', '--help'])).toBe(0);
    expect(String(out.mock.calls[0]![0])).toContain('phm sessions threads [--lane <lane>] [--repo <repo>] [--live] [--json]');
  });
});

describe('what a running session wrote, in the short threads', () => {
  const log = (lines: string[]): SessionThreadOutputRead => ({ source: 'live', truncated: false, lines });
  const entryOf = (read: SessionThreadsV1, id: string) => read.threads.find(entry => entry.session.id === id)!;

  it('carries the newest lines of the output, cut from the front', async () => {
    const output = new Map<string, SessionThreadOutputRead | null>([['RQ-A', log(Array.from({ length: 6 }, (_, index) => `step ${index + 1}`))], ['RQ-QUIET', null]]);
    const read = buildSessionThreads(await liveList(), { sessionsRead: true, bus: bus([]), activity: none, output }, NOW);
    const worker = entryOf(read, 'RQ-A'), quiet = entryOf(read, 'RQ-QUIET');
    expect(worker.messages.at(-1)).toMatchObject({ key: 'output', kind: 'output', side: 'session', text: 'step 4\nstep 5\nstep 6', truncated: true });
    expect([worker.sources.output, worker.messageCount]).toEqual(['available', 1]);
    expect([quiet.sources.output, quiet.gaps]).toEqual(['unavailable', ['Output unknown: this session\'s log could not be read.']]);
    expect(entryOf(read, 'leader').sources.output).toBe('none');
    const whole = buildSessionThreads(await liveList(), { sessionsRead: true, bus: bus([]), activity: none, output: new Map([['RQ-A', log(['only line'])]]) }, NOW);
    expect(entryOf(whole, 'RQ-A').messages.at(-1)).toMatchObject({ text: 'only line', truncated: false });
    const wide = buildSessionThreads(await liveList(), { sessionsRead: true, bus: bus([]), activity: none, output: new Map([['RQ-A', log(['a'.repeat(230), 'b'.repeat(230), 'the end'])]]) }, NOW);
    const cut = entryOf(wide, 'RQ-A').messages.at(-1)!;
    expect([cut.truncated, cut.text.length <= THREADS_TEXT_CHARS, cut.text.startsWith('…'), cut.text.endsWith('the end')]).toEqual([true, true, true, true]);
    expect(renderSessionThreadsText(read)).toContain('  < Output, last 3 lines of its log: step 4 step 5 step 6');
    expect(entryOf(whole, 'RQ-A').messages.at(-1)!.label).toBe('Output, 1 line');
  });

  it('reads the log of each running session shown once, and one failed read leaves the others', async () => {
    const readOutput = vi.fn(async (job: string) => { if (job === 'RQ-QUIET') throw new Error('log unreadable'); return log([`${job} is compiling`]); });
    const read = await readSessionThreads({ now: NOW, readMap: () => fleetMap(), readSubagents: async () => [], readLeader: async () => null, readActivity: async job => activity(job),
      readBus: () => bus([]), readReplies: async () => replies([]), readOwner: async () => inbox([]), readOrders: async () => trace([]), readOutput });
    expect(readOutput.mock.calls.map(call => call[0]).sort()).toEqual(['RQ-A', 'RQ-QUIET']);
    expect(entryOf(read, 'RQ-A').messages.at(-1)).toMatchObject({ kind: 'output', text: 'RQ-A is compiling' });
    expect([entryOf(read, 'RQ-QUIET').sources.output, entryOf(read, 'RQ-QUIET').sources.activity]).toEqual(['unavailable', 'available']);
    expect(threadSessions(await liveList()).shown.map(entry => [entry.id, entry.running])).toEqual([['leader', false], ['RQ-A', true], ['RQ-QUIET', true]]);
  });
});
