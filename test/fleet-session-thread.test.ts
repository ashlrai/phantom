/**
 * `fleet.session-thread.v1`: one session as a conversation, behind
 * `phm sessions thread <id>` and GET /api/verse/fleet/control/session-thread.
 * Fixtures only: no runs directory, bus or plan log is read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentMessage, AgentMessages } from '../src/core/fleet/agent-messages.js';
import type { FleetCompute } from '../src/core/fleet/compute-view.js';
import type { JobControlLedgerRow } from '../src/core/fleet/job-control-types.js';
import type { InboxEntry } from '../src/core/fleet/mason-inbox.js';
import type { LeaderRepliesV1 } from '../src/core/fleet/mason-outbox.js';
import type { OrderTraceJob, OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { FleetJobActivityV1 } from '../src/core/fleet/runs-job-activity.js';
import type { FleetSessionV1, FleetSessionsV1 } from '../src/core/fleet/runs-sessions.js';
import { buildLiveSessions, flatTree } from '../src/core/fleet/live-sessions.js';
import { buildSessionThread, THREAD_LIMITS, renderSessionThreadText, sessionBusMessages, sessionOutputLines, sessionOwnerMessages, sessionReply, THREAD_BUS_SHOWN, THREAD_CONTROLS_SHOWN, THREAD_ORDERS_SHOWN, THREAD_OUTPUT_LINES, THREAD_OUTPUT_LINE_CHARS, THREAD_OWNER_SHOWN, THREAD_ROUTED_SHOWN, type SessionThreadOutputRead, type SessionThreadOwnerRead } from '../src/core/fleet/session-thread.js';
import { readSessionThread } from '../src/core/fleet/session-thread-read.js';
import { readFleetSessionMap } from '../src/core/fleet/sessions-view.js';
import { createFleetSessionThreadApi } from '../src/core/verse/fleet-session-thread-api.js';
import { AGENT_COMMANDS } from '../src/cli/help.js';
import { cmdSessions, cmdSessionThread } from '../src/cli/sessions.js';

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
const fleetMap = () => readFleetSessionMap({
  compute, now: NOW, readDetail: async () => { throw new Error('no details'); },
  sessions: inventory([session('RQ-A', { prUrl: 'https://github.com/ashlrai/phantom/pull/9' }), session('RQ-QUIET', { lastOutputAt: ago(25) })]),
});

const activity = (over: Partial<FleetJobActivityV1> = {}): FleetJobActivityV1 => ({
  schema: 'fleet.job.activity.v1', generatedAt: ago(0), job: 'RQ-A', state: 'running', lane: 'claude', tier: 'frontier', model: 'fixture-model',
  sources: { events: 'healthy', commands: 'healthy', files: 'healthy', reports: 'healthy' }, counts: { events: 2, commands: 10, files: 1, reports: 2 }, truncated: false,
  entries: [
    { kind: 'report', name: 'brief', state: 'ok', source: 'prompt', bytes: 20, truncated: false, text: 'Fix the reply box.' },
    { kind: 'event', at: ago(30), event: 'launch', summary: 'lane=claude' },
    { kind: 'event', at: null, event: 'publish', summary: 'pr=9' },
    ...Array.from({ length: 10 }, (_, index) => ({ kind: 'command' as const, text: `npm run step-${index}`, line: index + 1 })),
    { kind: 'files', state: 'ok', baseSha: 'abc', truncated: false, refusals: [], totals: { files: 1, added: 12, removed: 3 },
      files: [{ path: 'src/a.ts', added: 12, removed: 3, status: 'modified' }] },
    { kind: 'report', name: 'notes', state: 'ok', source: 'notes', bytes: 9, truncated: true, text: 'Done.' },
  ] as FleetJobActivityV1['entries'],
  ...over,
});
const message = (id: string, from: string, to: string, over: Partial<AgentMessage> = {}): AgentMessage => ({
  id, ts: ago(5), from: { name: from, lane: null }, to: { name: to, lane: null }, kind: 'status', summary: `${from} says ${id}`, conversation: 'c', job: null, pr: null, ...over,
});
const bus = (messages: AgentMessage[], source: AgentMessages['source'] = 'available'): AgentMessages => ({ schema: 'agent-messages.v1', source, messages, matched: messages.length, skipped: 0 });
const replies = (texts: string[], sourceState: LeaderRepliesV1['sourceState'] = 'healthy'): LeaderRepliesV1 => ({
  schema: 'leader.replies.v1', version: 1, sourceState, entries: [], replies: texts.map((text, index) => ({ at: index === 0 ? 'unknown' : '2026-11-17 06:5' + index, text, source: 'plan-log' })),
});
/** Inbox entries as the reader returns them: newest first, Eastern wall time to the minute (06:40 ET is 11:40Z on this day). */
const wrote = (at: string, text: string, over: Partial<InboxEntry> = {}): InboxEntry => ({ at: `2026-11-17 ${at}`, source: 'desktop', priority: null, text, ...over });
const inbox = (entries: InboxEntry[], sourceState: SessionThreadOwnerRead['sourceState'] = 'healthy'): SessionThreadOwnerRead => ({ sourceState, entries });
const routedJob = (id: string, state: OrderTraceJob['state'], over: Partial<OrderTraceJob> = {}): OrderTraceJob => ({ id, lane: 'claude', state, url: null, ...over });
/** The order trace as `readOrderTrace` returns it: one order per inbox entry, newest first, with the jobs whose prompts cite it. */
const trace = (orders: Array<[entry: InboxEntry, jobs: OrderTraceJob[]]>, sources: Partial<OrderTraceV1['sources']> = {}): OrderTraceV1 => ({
  v: 1, generatedAt: ago(0), sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy', queue: 'healthy', ...sources },
  orders: orders.map(([entry, jobs]) => ({ at: entry.at, source: entry.source, key: entry.at.slice(5), jobs })),
});
const liveList = async () => buildLiveSessions(await fleetMap(), NOW, { subagents: [] });

afterEach(() => vi.restoreAllMocks());

describe('buildSessionThread', () => {
  it('reads a worker as a conversation in order, with a summary from its records', async () => {
    const thread = buildSessionThread(await liveList(), 'RQ-A', { sessionsRead: true, activity: activity(), bus: bus([
      message('m2', 'RQ-A', 'leader', { ts: ago(3) }), message('m1', 'leader', 'rq-a', { ts: ago(8), kind: 'ask' }),
      message('m3', 'codex-1', 'leader', { job: 'RQ-A', ts: ago(1) }), message('m4', 'codex-1', 'leader'),
    ]) }, NOW);
    expect(thread).toMatchObject({ schema: 'fleet.session-thread.v1', generatedAt: ago(0), id: 'RQ-A',
      session: { id: 'RQ-A', kind: 'worker', lane: 'claude', model: 'fixture-model', repo: 'phantom', jobId: 'RQ-A', parentId: 'leader', state: 'running',
        ageSeconds: 1800, prUrl: 'https://github.com/ashlrai/phantom/pull/9', helpers: { below: 0, running: 0, failed: 0 } },
      sources: { sessions: 'available', activity: 'available', bus: 'available', owner: 'none', replies: 'none' }, gaps: [] });
    expect(thread.summary).toEqual([
      'Worker on claude, fixture-model, in phantom.', 'Running for 30m; spoke 2m ago.', 'Pull request: https://github.com/ashlrai/phantom/pull/9',
      '10 commands seen, 1 file changed (+12 −3).', 'Latest step: publish pr=9.',
    ]);
    expect(thread.messages.map(m => `${m.key}|${m.side}`)).toEqual([
      'brief|other', 'step:0|record', 'step:1|record', 'commands|session', 'files|session', 'notes|session', 'bus:m1|other', 'bus:m2|session', 'bus:m3|other',
    ]);
    const byKey = Object.fromEntries(thread.messages.map(m => [m.key, m]));
    expect(byKey['step:0']).toMatchObject({ label: 'launch', at: ago(30), text: 'lane=claude' });
    expect(byKey['step:1']!.at).toBeNull();
    expect(byKey.commands).toMatchObject({ label: 'Ran 10 commands, last 8 shown', format: 'mono' });
    expect(byKey.commands!.text.split('\n')).toHaveLength(8);
    expect(byKey.commands!.text).not.toContain('step-1\n');
    expect(byKey.files).toMatchObject({ label: 'Changed 1 file, +12 −3', text: 'src/a.ts' });
    expect(byKey.notes!.label).toBe('Notes (truncated)');
    expect(byKey['bus:m1']!.label).toBe('leader to rq-a, ask');
  });

  it('marks a quiet session and says "unknown" for what no record holds', async () => {
    const thread = buildSessionThread(await liveList(), 'RQ-QUIET', { sessionsRead: true, activity: null, bus: null }, NOW);
    expect(thread.session!.state).toBe('quiet');
    expect(thread.summary).toEqual(['Worker on claude, fixture-model, in phantom.', 'Quiet: no output for 25m.']);
    expect(thread.messages).toEqual([]);
    expect(thread.sources).toEqual({ sessions: 'available', activity: 'unavailable', bus: 'unavailable', owner: 'none', replies: 'none', orders: 'none', output: 'none', controls: 'none' });
    expect(thread.gaps).toEqual(['Activity unknown: this session\'s recorded activity could not be read.', 'Bus messages unknown: the agent bus could not be read.']);
    const partial = buildSessionThread(await liveList(), 'RQ-QUIET', { sessionsRead: true, bus: bus([], 'missing'),
      activity: activity({ truncated: true, sources: { events: 'missing', commands: 'missing', files: 'missing', reports: 'missing' }, counts: { events: 0, commands: 0, files: 0, reports: 0 }, entries: [] }) }, NOW);
    expect(partial.summary.at(-1)).toBe('Commands unknown, changed files unknown.');
    expect(partial.sources).toMatchObject({ activity: 'none', bus: 'none' });
    expect(partial.gaps).toEqual(['Older activity is outside the recorded window.']);
  });

  it('gives the leader its replies oldest first and the bus messages to it', async () => {
    const thread = buildSessionThread(await liveList(), 'leader', { sessionsRead: true, bus: bus([message('m1', 'RQ-A', 'Leader')]), replies: replies(['newest', 'older']) }, NOW);
    expect(thread.session).toMatchObject({ kind: 'leader', parentId: null, jobId: null, helpers: { below: 2, running: 2, failed: 0 } });
    expect(thread.summary).toContain('2 of 2 helpers running.');
    expect(thread.messages.map(m => [m.key, m.side, m.text, m.at])).toEqual([
      ['bus:m1', 'other', 'RQ-A says m1', ago(5)], ['reply:0', 'session', 'older', '2026-11-17 06:51'], ['reply:1', 'session', 'newest', null],
    ]);
    expect(thread.sources.replies).toBe('available');
    const unread = buildSessionThread(await liveList(), 'leader', { sessionsRead: true, bus: bus([]), replies: replies([], 'unknown') }, NOW);
    expect(unread.sources.replies).toBe('unavailable');
    expect(unread.gaps).toEqual(['Leader replies unknown: the plan log could not be read.']);
  });

  it('shows a worker the messages Mason aimed at it in the Leader inbox, and no others', async () => {
    const entries = [
      wrote('06:55', '@RQ-A also keep the draft', { channel: 'desktop', id: 'desk-2' }), wrote('06:50', 'How is the fleet?', { channel: 'telegram', id: 'tg-1' }),
      wrote('06:45', 'for @RQ-AB only'), wrote('06:40', 'Stop, @RQ-A. Use the shared form.', { channel: 'desktop', id: 'desk-1' }), wrote('06:30', 'mail me@RQ-A'),
    ];
    const thread = buildSessionThread(await liveList(), 'RQ-A', { sessionsRead: true, bus: bus([message('m1', 'leader', 'RQ-A')]), owner: inbox(entries) }, NOW);
    expect(thread.messages.map(m => [m.key, m.kind, m.side, m.label, m.at, m.text])).toEqual([
      ['bus:m1', 'bus', 'other', 'leader to RQ-A, status', ago(5), 'leader says m1'],
      ['owner:desk-1', 'owner', 'other', 'Mason to the Leader, aimed at RQ-A, from desktop', '2026-11-17T11:40:00.000Z', 'Stop, @RQ-A. Use the shared form.'],
      ['owner:desk-2', 'owner', 'other', 'Mason to the Leader, aimed at RQ-A, from desktop', '2026-11-17T11:55:00.000Z', '@RQ-A also keep the draft'],
    ]);
    expect(thread.sources.owner).toBe('available');
    expect(thread.summary.at(-1)).toBe('Mason aimed 2 messages at it through the Leader inbox, the newest at 2026-11-17T11:55:00.000Z.');
    expect(renderSessionThreadText(thread)).toContain('> Mason to the Leader, aimed at RQ-A, from desktop [2026-11-17T11:40:00.000Z]\n    Stop, @RQ-A. Use the shared form.');

    const other = buildSessionThread(await liveList(), 'RQ-QUIET', { sessionsRead: true, bus: bus([]), owner: inbox(entries) }, NOW);
    expect(other.messages).toEqual([]);
    expect(other.sources.owner).toBe('none');
    expect(other.summary.join(' ')).not.toContain('Mason');
    // A helper has no job id a message can be aimed at.
    expect(sessionOwnerMessages({ kind: 'subagent', jobId: 'RQ-A' }, entries)).toEqual([]);
    expect(sessionOwnerMessages({ kind: 'worker', jobId: null }, entries)).toEqual([]);
  });

  it('tells an unreadable inbox from an empty one, and counts what it leaves out', async () => {
    for (const owner of [null, inbox([wrote('06:40', '@RQ-A hi')], 'degraded')]) {
      const thread = buildSessionThread(await liveList(), 'RQ-A', { sessionsRead: true, bus: bus([]), owner }, NOW);
      expect(thread.sources.owner).toBe('unavailable');
      expect(thread.messages).toEqual([]);
      expect(thread.gaps).toEqual(['Messages from Mason unknown: the Leader inbox could not be read.']);
    }
    const absent = buildSessionThread(await liveList(), 'RQ-A', { sessionsRead: true, bus: bus([]), owner: inbox([], 'missing') }, NOW);
    expect([absent.sources.owner, absent.gaps]).toEqual(['none', []]);

    // Newest first, as the inbox reader returns them; an entry with no id and no readable time still gets its own key.
    const many = Array.from({ length: THREAD_OWNER_SHOWN + 2 }, (_, index) => wrote('06:40', `@RQ-A note ${index}`, index === 0 ? { at: 'Tuesday' } : {}));
    const thread = buildSessionThread(await liveList(), 'RQ-A', { sessionsRead: true, bus: bus([]), owner: inbox(many) }, NOW);
    expect(thread.messages).toHaveLength(THREAD_OWNER_SHOWN);
    expect(new Set(thread.messages.map(m => m.key)).size).toBe(THREAD_OWNER_SHOWN);
    expect(thread.messages.at(-1)).toMatchObject({ key: `owner:Tuesday#${THREAD_OWNER_SHOWN - 1}`, at: null, text: '@RQ-A note 0', label: 'Mason to the Leader, aimed at RQ-A' });
    expect(thread.gaps).toEqual(['2 earlier messages from Mason not shown.']);
    expect(thread.summary.at(-1)).toBe(`Mason aimed ${THREAD_OWNER_SHOWN + 2} messages at it through the Leader inbox.`);
  });

  it('reads the leader as question then answer when every line is dated', async () => {
    const dated: LeaderRepliesV1 = { schema: 'leader.replies.v1', version: 1, sourceState: 'healthy', entries: [], replies: [
      { at: '2026-11-17 06:58', text: 'Draft kept.', source: 'plan-log' }, { at: '2026-11-17T11:45:00Z', text: 'Fleet is fine.', source: 'outbox' },
    ] };
    const entries = [wrote('06:55', '@RQ-A also keep the draft', { channel: 'desktop', id: 'desk-2' }), wrote('06:40', 'How is the fleet?', { channel: 'telegram', id: 'tg-1' })];
    const thread = buildSessionThread(await liveList(), 'leader', { sessionsRead: true, bus: bus([]), owner: inbox(entries), replies: dated }, NOW);
    expect(thread.messages.map(m => [m.key, m.side, m.label])).toEqual([
      ['owner:tg-1', 'other', 'Mason to Leader, from telegram'], ['reply:0', 'session', 'Leader to Mason'],
      ['owner:desk-2', 'other', 'Mason to Leader, from desktop'], ['reply:1', 'session', 'Leader to Mason'],
    ]);
    expect(thread.sources).toMatchObject({ owner: 'available', replies: 'available' });
    expect(thread.summary.join(' ')).not.toContain('aimed');

    // One undated reply: no order is invented, each side keeps its own.
    const mixed = buildSessionThread(await liveList(), 'leader', { sessionsRead: true, bus: bus([]), owner: inbox(entries), replies: replies(['newest', 'older']) }, NOW);
    expect(mixed.messages.map(m => m.key)).toEqual(['owner:tg-1', 'owner:desk-2', 'reply:0', 'reply:1']);
    const long = buildSessionThread(await liveList(), 'leader', { sessionsRead: true, bus: bus([]),
      owner: inbox(Array.from({ length: THREAD_OWNER_SHOWN + 1 }, (_, index) => wrote('06:40', `note ${index}`))) }, NOW);
    expect(long.gaps).toEqual(['Earlier messages from Mason are not shown here; the Leader chat holds them.']);
  });

  it('opens a worker with the message of Mason\'s it serves and where that message was routed', async () => {
    const ask = wrote('06:20', 'Fix the reply box and the draft.', { channel: 'desktop', id: 'desk-0' }), other = wrote('06:10', 'Unrelated.', { id: 'desk-x' });
    const orders = trace([[ask, [routedJob('RQ-A', 'published', { url: 'https://github.com/ashlrai/phantom/pull/9' }), routedJob('RQ-B', 'queued', { lane: null }),
      routedJob('RQ-C', 'launched', { lane: 'codex', endedEmptyAt: ago(4) })]], [other, [routedJob('RQ-Z', 'merged')]]]);
    const thread = buildSessionThread(await liveList(), 'RQ-A', { sessionsRead: true, activity: activity(), bus: bus([]), owner: inbox([ask, other]), orders }, NOW);
    expect(thread.messages.slice(0, 3).map(m => [m.key, m.kind, m.side, m.label, m.at])).toEqual([
      ['order:desk-0', 'order', 'other', 'Mason to the Leader, served by RQ-A, from desktop', '2026-11-17T11:20:00.000Z'],
      ['routing:desk-0', 'routing', 'record', 'Routed to 3 jobs', null],
      ['brief', 'brief', 'other', 'Brief', null],
    ]);
    expect(thread.messages[0]!.text).toBe('Fix the reply box and the draft.');
    expect(thread.messages[1]!.text.split('\n')).toEqual([
      'RQ-A (this session), on claude: published https://github.com/ashlrai/phantom/pull/9', 'RQ-B, lane unknown: queued',
      'RQ-C, on codex: launched, then ended with nothing to publish',
    ]);
    expect(thread.summary.slice(0, 2)).toEqual(['Worker on claude, fixture-model, in phantom.', 'Serves Mason\'s message of 2026-11-17 06:20 ET, with 2 other jobs.']);
    expect([thread.sources.orders, thread.sources.owner, thread.gaps]).toEqual(['available', 'none', []]);
    expect(renderSessionThreadText(thread)).toContain('- Routed to 3 jobs\n    RQ-A (this session), on claude: published');

    // The only job of its order needs no routing line; a session no prompt ties to a message gets nothing invented.
    const alone = buildSessionThread(await liveList(), 'RQ-A', { sessionsRead: true, bus: bus([]), owner: inbox([ask]), orders: trace([[ask, [routedJob('RQ-A', 'launched')]]]) }, NOW);
    expect(alone.messages.map(m => m.key)).toEqual(['order:desk-0']);
    expect(alone.summary[1]).toBe('Serves Mason\'s message of 2026-11-17 06:20 ET.');
    const untied = buildSessionThread(await liveList(), 'RQ-QUIET', { sessionsRead: true, bus: bus([]), owner: inbox([ask, other]), orders }, NOW);
    expect([untied.messages, untied.sources.orders, untied.summary.join(' ').includes('Serves')]).toEqual([[], 'none', false]);
  });

  it('names a served message whose text it did not read, and keeps to the newest few', async () => {
    const ask = wrote('06:20', 'Fix the reply box.');
    const blind = buildSessionThread(await liveList(), 'RQ-A', { sessionsRead: true, bus: bus([]), owner: null, orders: trace([[ask, [routedJob('RQ-A', 'launched')]]]) }, NOW);
    expect(blind.messages).toEqual([{ key: 'order:2026-11-17 06:20#desktop', kind: 'order', side: 'record', label: 'Serves Mason\'s message of 2026-11-17 06:20 ET, from desktop',
      at: '2026-11-17T11:20:00.000Z', text: 'Its text is not among the inbox messages this thread read.', format: 'plain' }]);
    expect(JSON.stringify(blind)).not.toContain('Fix the reply box.');

    const asks = Array.from({ length: THREAD_ORDERS_SHOWN + 2 }, (_, index) => wrote(`06:1${index}`, `ask ${index}`, { id: `d-${index}` })).reverse();
    const many = buildSessionThread(await liveList(), 'RQ-A', { sessionsRead: true, bus: bus([]), owner: inbox(asks),
      orders: trace(asks.map(entry => [entry, [routedJob('RQ-A', 'launched')]])) }, NOW);
    expect(many.messages.map(m => m.text)).toEqual(['ask 2', 'ask 3', 'ask 4']);
    expect(many.gaps).toEqual(['2 earlier messages from Mason that this session serves not shown.']);
    expect(many.summary[1]).toBe('Serves 5 of Mason\'s messages, the newest of 2026-11-17 06:14 ET.');
  });

  it('shows the leader where each of Mason\'s messages was routed', async () => {
    const dated: LeaderRepliesV1 = { schema: 'leader.replies.v1', version: 1, sourceState: 'healthy', entries: [], replies: [{ at: '2026-11-17T11:45:00Z', text: 'On it.', source: 'outbox' }] };
    const first = wrote('06:40', 'Fix the reply box.', { id: 'desk-1' }), chat = wrote('06:50', 'Thanks.', { id: 'desk-2' }), second = wrote('06:55', 'And the draft.', { id: 'desk-3' });
    const jobs = Array.from({ length: THREAD_ROUTED_SHOWN + 2 }, (_, index) => routedJob(`RQ-N${index}`, 'queued'));
    const orders = trace([[second, jobs], [chat, []], [first, [routedJob('RQ-A', 'merged', { url: 'https://github.com/ashlrai/phantom/pull/9' }), routedJob('RQ-N0', 'queued')]]]);
    const thread = buildSessionThread(await liveList(), 'leader', { sessionsRead: true, bus: bus([]), owner: inbox([second, chat, first]), replies: dated, orders }, NOW);
    expect(thread.messages.map(m => `${m.key}|${m.side}`)).toEqual([
      'owner:desk-1|other', 'routing:desk-1|record', 'reply:0|session', 'owner:desk-2|other', 'owner:desk-3|other', 'routing:desk-3|record',
    ]);
    expect(thread.messages[1]).toMatchObject({ label: 'Routed to 2 jobs', text: 'RQ-A, on claude: merged https://github.com/ashlrai/phantom/pull/9\nRQ-N0, on claude: queued' });
    expect(thread.messages.at(-1)!.text.split('\n')).toHaveLength(THREAD_ROUTED_SHOWN + 1);
    expect(thread.messages.at(-1)!.text).toMatch(/\nand 2 more$/);
    // RQ-N0 serves both messages and is counted once.
    expect(thread.summary[1]).toBe(`Routed 2 of the 3 messages shown from Mason to ${THREAD_ROUTED_SHOWN + 3} jobs: 1 merged, ${THREAD_ROUTED_SHOWN + 2} queued.`);
    expect(thread.sources.orders).toBe('available');

    const none = buildSessionThread(await liveList(), 'leader', { sessionsRead: true, bus: bus([]), owner: inbox([chat]), orders: trace([[chat, []]]) }, NOW);
    expect([none.messages.map(m => m.key), none.sources.orders, none.summary.join(' ').includes('Routed')]).toEqual([['owner:desk-2'], 'none', false]);
  });

  it('tells unread routing from no routing', async () => {
    const ask = wrote('06:20', 'Fix the reply box.', { id: 'desk-0' }), served = [[ask, [routedJob('RQ-A', 'launched')]]] as Array<[InboxEntry, OrderTraceJob[]]>;
    for (const orders of [null, trace(served, { inbox: 'degraded' })]) {
      const thread = buildSessionThread(await liveList(), 'RQ-A', { sessionsRead: true, bus: bus([]), owner: inbox([ask]), orders }, NOW);
      expect([thread.messages, thread.sources.orders, thread.gaps]).toEqual([[], 'unavailable', ['Routing unknown: the order trace could not be read.']]);
    }
    const partial = buildSessionThread(await liveList(), 'RQ-A', { sessionsRead: true, bus: bus([]), owner: inbox([ask]), orders: trace(served, { prompts: 'degraded' }) }, NOW);
    expect([partial.sources.orders, partial.gaps]).toEqual(['available', ['Routing may be incomplete: not every job prompt could be read.']]);
    const notAsked = buildSessionThread(await liveList(), 'RQ-A', { sessionsRead: true, bus: bus([]), owner: inbox([ask]) }, NOW);
    expect([notAsked.messages, notAsked.sources.orders, notAsked.gaps]).toEqual([[], 'none', []]);
  });

  it('shows only the newest bus messages and says how many are left out', async () => {
    const many = Array.from({ length: THREAD_BUS_SHOWN + 3 }, (_, index) => message(`m${index}`, 'RQ-A', 'leader', { ts: ago(200 - index) }));
    const thread = buildSessionThread(await liveList(), 'RQ-A', { sessionsRead: true, bus: bus(many) }, NOW);
    expect(thread.messages.filter(m => m.kind === 'bus')).toHaveLength(THREAD_BUS_SHOWN);
    expect(thread.messages[0]!.key).toBe('bus:m3');
    expect(thread.gaps).toEqual(['3 earlier bus messages not shown.']);
    expect(sessionBusMessages({ id: 'RQ-A', jobId: 'RQ-A' }, many)).toHaveLength(THREAD_BUS_SHOWN + 3);
  });

  it('never invents a session: an unknown id and an unreadable list are told apart', async () => {
    const missing = buildSessionThread(await liveList(), 'RQ-NOPE', { sessionsRead: true, bus: null }, NOW);
    expect(missing).toMatchObject({ session: null, summary: [], messages: [], sources: { sessions: 'available' }, gaps: ['No session RQ-NOPE in the list. Finished sessions stay for an hour.'] });
    const unreadable = buildSessionThread(buildLiveSessions(null, NOW), 'RQ-A', { sessionsRead: false, bus: null }, NOW);
    expect(unreadable).toMatchObject({ session: null, sources: { sessions: 'unavailable' }, gaps: ['Sessions unknown: the session list could not be read.'] });
    expect(buildSessionThread(await liveList(), 'unknown parent', { sessionsRead: true, bus: null }, NOW).session).toBeNull();
  });

  it('says where a message to the session goes, and that a finished, jobless or unknown session takes none', async () => {
    const list = await liveList(), read = (id: string) => buildSessionThread(list, id, { sessionsRead: true, bus: bus([]) }, NOW);
    const worker = read('RQ-A');
    expect(worker.reply).toEqual({ to: 'job', mention: '@RQ-A', hint: 'Goes to the Leader\'s inbox with @RQ-A in front, so the Leader knows which session you mean.' });
    expect(Object.keys(worker).slice(-4)).toEqual(['reply', 'control', 'depth', 'deeper']);
    expect(read('RQ-QUIET').reply).toMatchObject({ to: 'job', mention: '@RQ-QUIET' });
    expect(read('leader').reply).toEqual({ to: 'leader', mention: null, hint: 'Goes to the Leader\'s inbox, the same as the Leader chat.' });
    expect(read('RQ-NOPE').reply).toEqual({ to: 'none', mention: null, hint: 'There is no session to write to. Write to the Leader in the Leader chat.' });
    for (const state of ['idle', 'done', 'failed', 'unknown']) {
      expect([state, sessionReply({ kind: 'worker', jobId: 'RQ-A', state })]).toEqual([state,
        { to: 'none', mention: null, hint: 'This session is not running, so there is nothing to steer. Write to the Leader in the Leader chat.' }]);
    }
    for (const jobId of [null, 'job-7', 'RQ-a b']) {
      expect([jobId, sessionReply({ kind: 'subagent', jobId, state: 'running' })]).toEqual([jobId,
        { to: 'none', mention: null, hint: 'This session has no job id a message can be aimed at. Write to the Leader in the Leader chat.' }]);
    }
    // The mention the thread hands out is the one it later reads back as "aimed at" this session.
    expect(sessionOwnerMessages({ kind: 'worker', jobId: 'RQ-A' }, [wrote('06:40', `${worker.reply.mention} hold the tests`), wrote('06:41', 'for everyone')])).toHaveLength(1);
    expect(renderSessionThreadText(worker).split('\n').at(-2)).toBe('To write to it: Goes to the Leader\'s inbox with @RQ-A in front, so the Leader knows which session you mean.');
  });

  it('renders the thread for people', async () => {
    const text = renderSessionThreadText(buildSessionThread(await liveList(), 'RQ-A', { sessionsRead: true, activity: activity(), bus: bus([message('m1', 'leader', 'RQ-A')]) }, NOW));
    const lines = text.split('\n');
    expect(lines[0]).toBe('RQ-A | worker | running');
    expect(lines[1]).toBe('  Worker on claude, fixture-model, in phantom.');
    expect(text).toContain('> Brief\n    Fix the reply box.');
    expect(text).toContain(`- launch [${ago(30)}]\n    lane=claude`);
    expect(text).toContain(`> leader to RQ-A, status [${ago(5)}]\n    leader says m1`);
    expect(lines.at(-1)).toBe(`Full log: phm sessions tail RQ-A. Every session: phm sessions. Updated ${ago(0)}.`);
    const empty = renderSessionThreadText(buildSessionThread(await liveList(), 'leader', { sessionsRead: true, bus: bus([]), replies: replies([]) }, NOW));
    expect(empty).toContain('Nothing is recorded for this session yet.');
    expect(empty).not.toContain('Full log');
  });
});

describe('readSessionThread', () => {
  const reads = () => ({
    readMap: vi.fn(fleetMap), readSubagents: vi.fn(async () => []), readActivity: vi.fn(async () => activity()),
    readBus: vi.fn(() => bus([message('m1', 'leader', 'RQ-A')])), readReplies: vi.fn(async () => replies(['hello'])),
    readOwner: vi.fn(async () => inbox([wrote('06:40', '@RQ-A use the shared form', { id: 'desk-1', channel: 'desktop' })])),
    readOrders: vi.fn(async () => trace([])),
  });

  it('reads only what the session needs', async () => {
    const worker = reads();
    const thread = await readSessionThread('RQ-A', { now: NOW, ...worker });
    expect(thread.messages.map(m => m.kind)).toEqual(['brief', 'step', 'step', 'commands', 'files', 'notes', 'bus', 'owner']);
    expect(worker.readActivity).toHaveBeenCalledWith('RQ-A');
    expect(worker.readOwner).toHaveBeenCalledTimes(1);
    expect(worker.readReplies).not.toHaveBeenCalled();
    const leader = reads();
    expect((await readSessionThread('leader', { now: NOW, ...leader })).messages.map(m => `${m.kind}|${m.side}`)).toEqual(['bus|session', 'owner|other', 'reply|session']);
    expect(leader.readActivity).not.toHaveBeenCalled();
    const unknown = reads();
    expect((await readSessionThread('RQ-NOPE', { now: NOW, ...unknown })).session).toBeNull();
    expect(unknown.readBus).not.toHaveBeenCalled();
    expect([worker.readOrders.mock.calls.length, leader.readOrders.mock.calls.length, unknown.readOrders.mock.calls.length]).toEqual([1, 1, 0]);
  });

  it('joins the order trace, and keeps the thread when it cannot be read', async () => {
    const ask = wrote('06:20', 'Fix the reply box.', { id: 'desk-0' });
    const served = { readOwner: async () => inbox([ask]), readOrders: async () => trace([[ask, [routedJob('RQ-A', 'launched'), routedJob('RQ-B', 'queued')]]]) };
    const thread = await readSessionThread('RQ-A', { now: NOW, ...reads(), ...served });
    expect(thread.messages.slice(0, 2).map(m => m.key)).toEqual(['order:desk-0', 'routing:desk-0']);
    expect((await readSessionThread('leader', { now: NOW, ...reads(), ...served })).messages.map(m => m.key)).toEqual(['bus:m1', 'owner:desk-0', 'routing:desk-0', 'reply:0']);
    const down = await readSessionThread('RQ-A', { now: NOW, ...reads(), readOrders: async () => { throw new Error('trace unreadable'); } });
    expect(down.messages.map(m => m.kind)).toEqual(['brief', 'step', 'step', 'commands', 'files', 'notes', 'bus', 'owner']);
    expect([down.sources.orders, down.gaps]).toEqual(['unavailable', ['Routing unknown: the order trace could not be read.']]);
  });

  it('keeps the thread when one read fails, and reads an unreadable list as unknown', async () => {
    const thread = await readSessionThread('RQ-A', { now: NOW, ...reads(), readActivity: async () => { throw new Error('x'); }, readBus: () => { throw new Error('y'); } });
    expect(thread.session!.id).toBe('RQ-A');
    expect(thread.sources).toMatchObject({ activity: 'unavailable', bus: 'unavailable', owner: 'available' });
    const noInbox = await readSessionThread('RQ-A', { now: NOW, ...reads(), readOwner: async () => { throw new Error('z'); } });
    expect(noInbox.sources).toMatchObject({ activity: 'available', bus: 'available', owner: 'unavailable' });
    expect(noInbox.gaps).toEqual(['Messages from Mason unknown: the Leader inbox could not be read.']);
    const down = await readSessionThread('RQ-A', { now: NOW, ...reads(), readMap: async () => { throw new Error('runs dir unreadable'); } });
    expect(down).toMatchObject({ session: null, sources: { sessions: 'unavailable' } });
  });

  it('scrubs secret-shaped text from the thread', async () => {
    const secret = `ghp_${'a'.repeat(36)}`;
    const thread = await readSessionThread('RQ-A', { now: NOW, ...reads(), readBus: () => bus([message('m1', 'leader', 'RQ-A', { summary: `token ${secret}` })]) });
    expect(JSON.stringify(thread)).not.toContain(secret);
    const typed = await readSessionThread('RQ-A', { now: NOW, ...reads(), readOwner: async () => inbox([wrote('06:40', `@RQ-A use ${secret}`)]) });
    expect(typed.messages.at(-1)!.kind).toBe('owner');
    expect(JSON.stringify(typed)).not.toContain(secret);
  });
});

describe('GET /api/verse/fleet/control/session-thread', () => {
  const call = async (url: string, opts: { session?: boolean; method?: string; read?: (id: string) => Promise<unknown> } = {}) => {
    const read = vi.fn(opts.read ?? (async (id: string) => buildSessionThread(await liveList(), id, { sessionsRead: true, bus: bus([]) }, NOW)));
    let status = 0, body = '';
    const res = { writeHead: (code: number) => { status = code; return res; }, setHeader: () => res, end: (chunk?: string) => { body = chunk ?? ''; } } as unknown as ServerResponse;
    const ctx = { readSession: opts.session === false ? undefined : { expiresAt: Date.now() + 60_000 } } as never;
    const handled = await createFleetSessionThreadApi(read as never)(ctx, { url } as IncomingMessage, res, url.split('?')[0]!, opts.method ?? 'GET');
    return { handled, status, body: body ? JSON.parse(body) : null, read };
  };
  const PATH = '/api/verse/fleet/control/session-thread';

  it('serves one thread with a read session and validates the query', async () => {
    const ok = await call(`${PATH}?id=RQ-A`);
    expect(ok).toMatchObject({ handled: true, status: 200, body: { schema: 'fleet.session-thread.v1', id: 'RQ-A' } });
    expect(ok.read).toHaveBeenCalledWith('RQ-A');
    // The read is told a depth only when the caller asked for the full one.
    expect((await call(`${PATH}?id=RQ-A&depth=recent`)).read.mock.calls).toEqual([['RQ-A']]);
    const all = await call(`${PATH}?depth=full&id=RQ-A`);
    expect([all.status, all.read.mock.calls]).toEqual([200, [['RQ-A', 'full']]]);
    expect((await call(`${PATH}?id=leader`)).body.session.kind).toBe('leader');
    expect((await call(`${PATH}?id=RQ-A`, { session: false })).status).toBe(401);
    expect((await call(`${PATH}?id=RQ-A`, { method: 'POST' })).status).toBe(405);
    for (const bad of ['', '?id=a&id=b', '?id=RQ-A&lane=x', '?id=RQ-A&depth=all', '?id=RQ-A&depth=', '?id=RQ-A&depth=full&depth=full', '?depth=full', '?id=..%2Fetc', '?id=', `?id=${'a'.repeat(129)}`]) {
      const refused = await call(`${PATH}${bad}`);
      expect([bad, refused.status]).toEqual([bad, 400]);
      expect(refused.read).not.toHaveBeenCalled();
    }
    expect((await call('/api/verse/fleet/control/live-sessions')).handled).toBe(false);
  });

  it('answers 404 for an unknown session and 503 when sessions cannot be read', async () => {
    expect(await call(`${PATH}?id=RQ-NOPE`)).toMatchObject({ status: 404, body: { error: 'No session RQ-NOPE in the list. Finished sessions stay for an hour.' } });
    expect((await call(`${PATH}?id=RQ-A`, { read: async id => buildSessionThread(buildLiveSessions(null, NOW), id, { sessionsRead: false, bus: null }, NOW) })).status).toBe(503);
    expect((await call(`${PATH}?id=RQ-A`, { read: async () => { throw new Error('x'); } })).status).toBe(503);
  });
});

describe('phm sessions thread', () => {
  const run = async (args: string[], read = async (id: string) => buildSessionThread(await liveList(), id, { sessionsRead: true, activity: activity(), bus: bus([]) }, NOW)) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await cmdSessionThread(args, read);
    return { code, out: log.mock.calls.map(call => String(call[0])).join('\n'), err: stderr.mock.calls.map(call => String(call[0])).join('') };
  };

  it('prints the thread as text or JSON', async () => {
    const text = await run(['RQ-A']);
    expect(text.code).toBe(0);
    expect(text.out.split('\n')[0]).toBe('RQ-A | worker | running');
    vi.restoreAllMocks();
    const json = await run(['RQ-A', '--json']);
    expect(JSON.parse(json.out)).toMatchObject({ schema: 'fleet.session-thread.v1', id: 'RQ-A', session: { id: 'RQ-A' } });
  });

  it('exits 2 for an unknown id or bad usage, and 1 when sessions cannot be read', async () => {
    const unknown = await run(['RQ-NOPE']);
    expect(unknown).toMatchObject({ code: 2, out: '' });
    expect(unknown.err).toBe('No session RQ-NOPE in the list. Finished sessions stay for an hour.\nSee every session: phm sessions\n');
    vi.restoreAllMocks();
    expect(JSON.parse((await run(['RQ-NOPE', '--json'])).out).session).toBeNull();
    for (const args of [[], ['a', 'b'], ['../etc'], ['RQ-A', '--follow']]) {
      vi.restoreAllMocks();
      const read = vi.fn();
      expect([args, (await run(args, read)).code]).toEqual([args, 2]);
      expect(read).not.toHaveBeenCalled();
    }
    vi.restoreAllMocks();
    const down = await run(['RQ-A'], async id => buildSessionThread(buildLiveSessions(null, NOW), id, { sessionsRead: false, bus: null }, NOW));
    expect(down).toMatchObject({ code: 1, err: 'Sessions unknown: the session list could not be read.\n' });
  });

  it('is listed in the sessions help', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await cmdSessions(['thread', '--help'])).toBe(0);
    expect(String(out.mock.calls[0]![0])).toContain('phm sessions thread <id> [--all] [--json]');
  });

  it('asks for the full depth with --all, and for nothing more without it', async () => {
    const read = vi.fn(async (id: string, depth?: 'recent' | 'full') => buildSessionThread(await liveList(), id, { sessionsRead: true, activity: activity(), bus: bus([]) }, NOW, depth));
    const recent = await run(['RQ-A'], read);
    // Ten commands are on record and eight are shown, so the text says how to see the rest.
    expect(recent.out).toContain('note: Earlier entries are on record. Show them: phm sessions thread RQ-A --all');
    expect(read.mock.calls).toEqual([['RQ-A']]);
    vi.restoreAllMocks();
    read.mockClear();
    const all = await run(['RQ-A', '--all', '--json'], read);
    expect(read.mock.calls).toEqual([['RQ-A', 'full']]);
    expect(JSON.parse(all.out)).toMatchObject({ depth: 'full', deeper: false });
    vi.restoreAllMocks();
    expect((await run(['RQ-A', '--all'], read)).out).not.toContain('--all');
  });

  it('documents the JSON it prints: every top-level key, and every source the thread names', async () => {
    const doc = AGENT_COMMANDS.find(command => command.usage === 'phm sessions thread <id> [--all] [--json]');
    const shape = doc?.jsonShape ?? '';
    const thread = buildSessionThread(await liveList(), 'RQ-A', { sessionsRead: true, activity: activity(), bus: bus([]) }, NOW);
    // The documented shape lists `sources` as `sources:{a,b,...}`; it must name the keys the builder returns, in order.
    expect(/sources:\{([^}]*)\}/.exec(shape)?.[1]?.split(',')).toEqual(Object.keys(thread.sources));
    for (const key of Object.keys(thread)) expect([key, shape.includes(key)]).toEqual([key, true]);
    expect(doc?.description).toContain('routed');
  });
});

describe('what the session wrote (output)', () => {
  const log = (lines: string[], over: Partial<SessionThreadOutputRead> = {}): SessionThreadOutputRead => ({ source: 'live', truncated: false, lines, ...over });
  const build = async (output?: SessionThreadOutputRead | null) => buildSessionThread(await liveList(), 'RQ-A',
    { sessionsRead: true, activity: activity(), bus: bus([message('m1', 'leader', 'RQ-A')]), ...(output === undefined ? {} : { output }) }, NOW);

  it('ends the conversation with the newest lines of the log, blank ones dropped and long ones cut', async () => {
    const lines = ['', ...Array.from({ length: 14 }, (_, index) => `line ${index + 1}  `), '   ', 'x'.repeat(THREAD_OUTPUT_LINE_CHARS + 20)];
    const thread = await build(log(lines));
    const said = thread.messages.at(-1)!;
    expect(said).toMatchObject({ key: 'output', kind: 'output', side: 'session', at: null, format: 'mono', label: 'Output, last 12 lines of its log' });
    const shown = said.text.split('\n');
    expect(shown).toHaveLength(THREAD_OUTPUT_LINES);
    expect([shown[0], shown.at(-2)]).toEqual(['line 4', 'line 14']);
    expect([shown.at(-1)!.length, shown.at(-1)!.endsWith('…')]).toEqual([THREAD_OUTPUT_LINE_CHARS, true]);
    expect(sessionOutputLines(lines).earlier).toBe(3);
    expect([thread.sources.output, thread.gaps]).toEqual(['available', []]);
    expect(Object.keys(thread.sources).slice(-2)).toEqual(['output', 'controls']);
    expect((await build(log(['one', 'two']))).messages.at(-1)).toMatchObject({ label: 'Output, 2 lines', text: 'one\ntwo' });
    // A window that clipped the log has earlier lines even when few are shown.
    expect((await build(log(['bye'], { source: 'archived', truncated: true }))).messages.at(-1)!.label).toBe('Output, from its archived log, last 1 line of its log');
    expect(renderSessionThreadText(await build(log(['one', 'two'])))).toContain('< Output, 2 lines\n    one\n    two');
  });

  it('says the output is unknown when the log could not be read, and nothing when nothing was written', async () => {
    for (const unread of [null, log([], { source: 'degraded' })]) {
      const thread = await build(unread);
      expect([thread.sources.output, thread.messages.some(m => m.kind === 'output')]).toEqual(['unavailable', false]);
      expect(thread.gaps).toEqual(['Output unknown: this session\'s log could not be read.']);
    }
    for (const empty of [undefined, log([], { source: 'missing' }), log(['', '   ']), log([], { truncated: true })]) {
      const thread = await build(empty);
      expect([thread.sources.output, thread.messages.some(m => m.kind === 'output'), thread.gaps]).toEqual(['none', false, []]);
    }
    const tooLarge = await build(log([], { source: 'archived', truncated: true }));
    expect([tooLarge.sources.output, tooLarge.gaps]).toEqual(['unavailable', ['Output not shown: the archived log is too large to read here.']]);
    expect(buildSessionThread(await liveList(), 'RQ-NOPE', { sessionsRead: true, bus: null }, NOW).sources.output).toBe('none');
  });

  it('does not say the latest line twice when the output already ends with it', async () => {
    const list = await liveList();
    flatTree(list.tree.roots).map(entry => entry.node).find(node => node.id === 'RQ-A')!.lastMessage = 'Running the tests';
    const keys = (output?: SessionThreadOutputRead) => buildSessionThread(list, 'RQ-A', { sessionsRead: true, bus: bus([]), ...(output ? { output } : {}) }, NOW).messages.map(m => m.key);
    expect(keys()).toEqual(['latest']);
    expect(keys(log(['npm test', 'Running the tests']))).toEqual(['output']);
    expect(keys(log(['npm test', 'Running the tests, 40 of 90 files']))).toEqual(['output']);
    expect(keys(log(['npm test', 'All green']))).toEqual(['output', 'latest']);
  });

  it('is read for a session with a job only, and a failed read leaves the rest of the thread', async () => {
    const reads = () => ({ readMap: vi.fn(fleetMap), readSubagents: vi.fn(async () => []), readActivity: vi.fn(async () => activity()), readBus: vi.fn(() => bus([message('m1', 'leader', 'RQ-A')])),
      readReplies: vi.fn(async () => replies(['hello'])), readOwner: vi.fn(async () => inbox([])), readOrders: vi.fn(async () => trace([])),
      readOutput: vi.fn(async () => log(['compiling', `key ghp_${'a'.repeat(36)}`, 'done'])) });
    const worker = reads(), thread = await readSessionThread('RQ-A', { now: NOW, ...worker });
    expect(worker.readOutput.mock.calls).toEqual([['RQ-A']]);
    expect(thread.messages.at(-1)).toMatchObject({ kind: 'output', label: 'Output, 3 lines' });
    expect(thread.messages.at(-1)!.text.split('\n').filter(line => line === 'compiling' || line === 'done')).toEqual(['compiling', 'done']);
    expect(JSON.stringify(thread)).not.toContain('ghp_');
    const leader = reads();
    expect((await readSessionThread('leader', { now: NOW, ...leader })).sources.output).toBe('none');
    expect(leader.readOutput).not.toHaveBeenCalled();
    const down = await readSessionThread('RQ-A', { now: NOW, ...reads(), readOutput: async () => { throw new Error('log unreadable'); } });
    expect(down.sources).toMatchObject({ activity: 'available', bus: 'available', output: 'unavailable' });
    expect(down.messages.map(m => m.kind)).toEqual(['brief', 'step', 'step', 'commands', 'files', 'notes', 'bus']);
  });
});

describe('what was asked of the session\'s job (control)', () => {
  const asked = (requestId: string, over: Partial<JobControlLedgerRow> = {}): JobControlLedgerRow =>
    ({ requestId, action: 'pause', job: 'RQ-A', lane: null, status: 'requested', reason: null, at: ago(4), by: 'desktop', ...over });
  const build = async (controls?: readonly JobControlLedgerRow[] | null, id = 'RQ-A') => buildSessionThread(await liveList(), id,
    { sessionsRead: true, bus: bus([]), ...(controls === undefined ? {} : { controls }) }, NOW);

  it('shows each request for this job as a record with what became of it, and says which one stands', async () => {
    const thread = await build([
      asked('jc-1', { status: 'applied', at: ago(20) }), asked('jc-2', { action: 'resume', status: 'applied', at: ago(15), by: 'cli' }),
      asked('jc-other', { job: 'RQ-QUIET' }), asked('jc-3', { action: 'move', lane: 'codex', status: 'refused', reason: 'Lane codex is held.', at: ago(9), by: null }),
      asked('jc-4', { at: ago(4) }),
    ]);
    expect(thread.messages.filter(m => m.kind === 'control')).toEqual([
      { key: 'control:jc-1', kind: 'control', side: 'record', label: 'Paused', at: ago(20), format: 'plain', text: 'Asked from desktop. Done.' },
      { key: 'control:jc-2', kind: 'control', side: 'record', label: 'Resumed', at: ago(15), format: 'plain', text: 'Asked from cli. Done.' },
      { key: 'control:jc-3', kind: 'control', side: 'record', label: 'Move to codex refused', at: ago(9), format: 'plain', text: 'Lane codex is held.' },
      { key: 'control:jc-4', kind: 'control', side: 'record', label: 'Pause requested', at: ago(4), format: 'plain', text: 'Asked from desktop. The dispatcher has not applied it yet.' },
    ]);
    // The newest one not refused is what stands.
    expect(thread.messages.at(-1)!.key).toBe('control:jc-4');
    expect(thread.control).toEqual({ action: 'pause', lane: null, status: 'requested', at: ago(4) });
    expect(thread.summary.at(-1)).toBe(`Pause requested at ${ago(4)}. The dispatcher has not applied it yet.`);
    expect([thread.sources.controls, thread.gaps]).toEqual(['available', []]);
    expect(renderSessionThreadText(thread)).toContain(`- Pause requested [${ago(4)}]\n    Asked from desktop. The dispatcher has not applied it yet.`);
    expect(Object.keys(thread).slice(-3)).toEqual(['control', 'depth', 'deeper']);
  });

  it('says an applied request by name, lets a refusal stand for nothing, and keeps the newest few', async () => {
    const moved = await build([asked('jc-1', { action: 'move', lane: 'codex', status: 'applied', at: ago(6) }), asked('jc-2', { action: 'stop', status: 'refused', reason: null, at: ago(2) })]);
    expect(moved.control).toEqual({ action: 'move', lane: 'codex', status: 'applied', at: ago(6) });
    expect(moved.summary.at(-1)).toBe(`Moved to codex by request at ${ago(6)}.`);
    expect(moved.messages.find(m => m.key === 'control:jc-2')).toMatchObject({ label: 'Stop refused', text: 'Asked from desktop. Refused.' });
    const refused = await build([asked('jc-1', { status: 'refused', reason: 'Job has not started yet.' })]);
    expect([refused.control, refused.sources.controls, refused.summary.some(line => line.includes('Pause'))]).toEqual([null, 'available', false]);
    const many = await build(Array.from({ length: THREAD_CONTROLS_SHOWN + 2 }, (_, index) => asked(`jc-${index}`, { action: index % 2 ? 'resume' : 'pause', status: 'applied', at: ago(30 - index) })));
    expect(many.messages.filter(m => m.kind === 'control').map(m => m.key)).toEqual(['control:jc-2', 'control:jc-3', 'control:jc-4', 'control:jc-5', 'control:jc-6']);
    expect(many.gaps).toEqual(['2 earlier control requests not shown.']);
  });

  it('reads none recorded, unknown and not asked apart', async () => {
    const none = await build([asked('jc-other', { job: 'RQ-QUIET' })]);
    expect([none.sources.controls, none.control, none.gaps]).toEqual(['none', null, []]);
    const unread = await build(null);
    expect([unread.sources.controls, unread.control, unread.gaps]).toEqual(['unavailable', null, ['Controls unknown: the job control record could not be read.']]);
    const notAsked = await build();
    expect([notAsked.sources.controls, notAsked.control, notAsked.gaps]).toEqual(['none', null, []]);
    expect(await build([asked('jc-1', { job: 'leader' })], 'leader')).toMatchObject({ control: null, sources: { controls: 'none' } });
    expect(buildSessionThread(await liveList(), 'RQ-NOPE', { sessionsRead: true, bus: null }, NOW)).toMatchObject({ control: null, sources: { controls: 'none' } });
  });

  it('is read for a session with a job only, and a failed read leaves the rest of the thread', async () => {
    const reads = () => ({ readMap: vi.fn(fleetMap), readSubagents: vi.fn(async () => []), readActivity: vi.fn(async () => activity()), readBus: vi.fn(() => bus([])),
      readReplies: vi.fn(async () => replies(['hello'])), readOwner: vi.fn(async () => inbox([])), readOrders: vi.fn(async () => trace([])),
      readOutput: vi.fn(async (): Promise<SessionThreadOutputRead> => ({ source: 'live', truncated: false, lines: ['compiling'] })), readControls: vi.fn(async () => [asked('jc-1')]) });
    const worker = reads(), thread = await readSessionThread('RQ-A', { now: NOW, ...worker });
    expect(worker.readControls).toHaveBeenCalledTimes(1);
    expect([thread.control?.action, thread.sources.controls]).toEqual(['pause', 'available']);
    // The requests come before what the session wrote last.
    expect(thread.messages.map(m => m.kind).slice(-2)).toEqual(['control', 'output']);
    const leader = reads();
    expect((await readSessionThread('leader', { now: NOW, ...leader })).control).toBeNull();
    expect(leader.readControls).not.toHaveBeenCalled();
    const down = await readSessionThread('RQ-A', { now: NOW, ...reads(), readControls: async () => { throw new Error('control file unreadable'); } });
    expect(down.sources).toMatchObject({ activity: 'available', controls: 'unavailable' });
    expect(down.control).toBeNull();
  });
});

describe('depth: the newest few of each record, or as much as the same reads hold', () => {
  const refused = (index: number): JobControlLedgerRow =>
    ({ requestId: `jc-${index}`, action: 'pause', job: 'RQ-A', lane: null, status: 'refused', reason: 'The job had ended.', at: ago(30 - index), by: 'desktop' });
  /** More on record than a recent read shows, for every part a worker's thread limits. */
  const parts = () => ({
    sessionsRead: true, activity: activity(),
    bus: bus(Array.from({ length: THREAD_BUS_SHOWN + 3 }, (_, index) => message(`m${index}`, 'RQ-A', 'leader', { ts: ago(200 - index) }))),
    // Newest first, as the inbox reader returns them.
    owner: inbox(Array.from({ length: THREAD_OWNER_SHOWN + 2 }, (_, index) => wrote(`06:${10 + index}`, `@RQ-A note ${index}`, { id: `desk-${index}` })).reverse()),
    output: { source: 'live', truncated: false, lines: Array.from({ length: 30 }, (_, index) => `line ${index + 1}`) } as SessionThreadOutputRead,
    controls: Array.from({ length: THREAD_CONTROLS_SHOWN + 2 }, (_, index) => refused(index)),
  });
  const count = (thread: { messages: Array<{ kind: string }> }, kind: string) => thread.messages.filter(m => m.kind === kind).length;
  const labelOf = (thread: { messages: Array<{ kind: string; label: string }> }, kind: string) => thread.messages.find(m => m.kind === kind)?.label;

  it('says when a deeper read holds more, and the full read shows it', async () => {
    const list = await liveList();
    const recent = buildSessionThread(list, 'RQ-A', parts(), NOW), full = buildSessionThread(list, 'RQ-A', parts(), NOW, 'full');
    expect([recent.depth, recent.deeper, full.depth, full.deeper]).toEqual(['recent', true, 'full', false]);
    expect(recent.gaps).toEqual(['3 earlier bus messages not shown.', '2 earlier messages from Mason not shown.', '2 earlier control requests not shown.']);
    expect(full.gaps).toEqual([]);
    expect(['bus', 'owner', 'control'].map(kind => [kind, count(recent, kind), count(full, kind)])).toEqual([
      ['bus', THREAD_BUS_SHOWN, THREAD_BUS_SHOWN + 3], ['owner', THREAD_OWNER_SHOWN, THREAD_OWNER_SHOWN + 2], ['control', THREAD_CONTROLS_SHOWN, THREAD_CONTROLS_SHOWN + 2]]);
    expect([labelOf(recent, 'commands'), labelOf(full, 'commands')]).toEqual(['Ran 10 commands, last 8 shown', 'Ran 10 commands']);
    expect([labelOf(recent, 'output'), labelOf(full, 'output')]).toEqual(['Output, last 12 lines of its log', 'Output, 30 lines']);
    // The full read is the recent one with earlier entries added: nothing is renamed, reordered or dropped.
    const fullKeys = full.messages.map(m => m.key);
    expect(recent.messages.every(m => fullKeys.includes(m.key))).toBe(true);
    expect(fullKeys.filter(key => recent.messages.some(m => m.key === key))).toEqual(recent.messages.map(m => m.key));
    expect([full.summary, full.session, full.sources, full.reply]).toEqual([recent.summary, recent.session, recent.sources, recent.reply]);
    expect(renderSessionThreadText(recent)).toContain('note: Earlier entries are on record. Show them: phm sessions thread RQ-A --all');
    expect(renderSessionThreadText(full)).not.toContain('--all');
  });

  it('promises nothing deeper when every record fits, or when the session is not in the list', async () => {
    const list = await liveList();
    const small = buildSessionThread(list, 'RQ-A', { sessionsRead: true, bus: bus([message('m1', 'leader', 'RQ-A')]) }, NOW);
    expect([small.depth, small.deeper]).toEqual(['recent', false]);
    expect(renderSessionThreadText(small)).not.toContain('--all');
    expect(buildSessionThread(list, 'RQ-NOPE', { sessionsRead: true, bus: null }, NOW, 'full')).toMatchObject({ session: null, depth: 'full', deeper: false });
    // Each limited part says so by itself.
    const only = (over: object) => buildSessionThread(list, 'RQ-A', { sessionsRead: true, bus: bus([]), ...over }, NOW).deeper;
    expect([only({ activity: activity() }), only({ output: parts().output }), only({ controls: parts().controls }), only({ owner: parts().owner }), only({ bus: parts().bus })])
      .toEqual([true, true, true, true, true]);
    expect(only({ activity: activity({ entries: activity().entries.filter(entry => entry.kind !== 'command') }) })).toBe(false);
  });

  it('keeps the full read bounded and names what it still leaves out', async () => {
    const many = Array.from({ length: THREAD_LIMITS.full.bus + 5 }, (_, index) => message(`m${index}`, 'RQ-A', 'leader', { ts: ago(2000 - index) }));
    const full = buildSessionThread(await liveList(), 'RQ-A', { sessionsRead: true, bus: bus(many) }, NOW, 'full');
    expect([count(full, 'bus'), full.gaps, full.deeper]).toEqual([THREAD_LIMITS.full.bus, ['5 earlier bus messages not shown.'], false]);
    for (const key of Object.keys(THREAD_LIMITS.recent) as Array<keyof typeof THREAD_LIMITS.recent>) expect([key, THREAD_LIMITS.full[key] > THREAD_LIMITS.recent[key]]).toEqual([key, true]);
  });

  it('gives the leader its earlier replies, and reads through the depth it was asked for', async () => {
    const six = replies(['one', 'two', 'three', 'four', 'five', 'six']), list = await liveList();
    const recent = buildSessionThread(list, 'leader', { sessionsRead: true, bus: bus([]), replies: six }, NOW);
    const full = buildSessionThread(list, 'leader', { sessionsRead: true, bus: bus([]), replies: six }, NOW, 'full');
    expect([count(recent, 'reply'), recent.deeper, count(full, 'reply'), full.deeper]).toEqual([THREAD_LIMITS.recent.replies, true, 6, false]);
    // Newest first in the read, oldest first in the conversation: the earlier reply joins at the top.
    expect([recent.messages[0]!.text, full.messages[0]!.text]).toEqual(['five', 'six']);
    const reads = { readMap: fleetMap, readSubagents: async () => [], readActivity: async () => activity(), readBus: () => parts().bus, readOwner: async () => parts().owner,
      readOrders: async () => trace([]), readOutput: async () => parts().output, readControls: async () => parts().controls };
    const read = await readSessionThread('RQ-A', { now: NOW, ...reads }), deep = await readSessionThread('RQ-A', { now: NOW, depth: 'full', ...reads });
    expect([read.depth, read.deeper, count(read, 'bus'), deep.depth, deep.deeper, count(deep, 'bus')]).toEqual(['recent', true, THREAD_BUS_SHOWN, 'full', false, THREAD_BUS_SHOWN + 3]);
    expect((await readSessionThread('RQ-NOPE', { now: NOW, depth: 'full', ...reads })).depth).toBe('full');
  });
});
