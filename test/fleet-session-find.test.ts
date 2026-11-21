/**
 * `fleet.session-find.v1`: words looked for in every session's whole
 * conversation, behind `phm sessions find` and GET
 * /api/verse/fleet/control/session-find. Fixtures only: no runs directory,
 * bus, inbox or plan log is read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentMessage, AgentMessages } from '../src/core/fleet/agent-messages.js';
import type { FleetCompute } from '../src/core/fleet/compute-view.js';
import type { FleetJobActivityV1 } from '../src/core/fleet/runs-job-activity.js';
import type { FleetSessionV1, FleetSessionsV1 } from '../src/core/fleet/runs-sessions.js';
import { buildLiveSessions } from '../src/core/fleet/live-sessions.js';
import { buildSessionFind, FIND_HITS_SHOWN, FIND_SESSIONS_MAX, FIND_TEXT_CHARS, findWords, renderSessionFindText } from '../src/core/fleet/session-find.js';
import type { SessionThreadOutputRead } from '../src/core/fleet/session-thread.js';
import { buildSessionThreads, type SessionThreadsParts } from '../src/core/fleet/session-threads.js';
import { readSessionFind, readSessionFindParts } from '../src/core/fleet/session-threads-read.js';
import { readFleetSessionMap } from '../src/core/fleet/sessions-view.js';
import { createFleetSessionFindApi, defaultSessionFindRead } from '../src/core/verse/fleet-session-find-api.js';
import { handleFleetControlApi } from '../src/core/verse/fleet-control-api.js';
import { AGENT_COMMANDS } from '../src/cli/help.js';
import { cmdSessionFind, cmdSessions } from '../src/cli/sessions.js';

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
const TWO = [session('RQ-A'), session('RQ-B', { lane: 'codex' })];
const fleetMap = (sessions: FleetSessionV1[] = TWO) => readFleetSessionMap({ compute, now: NOW, readDetail: async () => { throw new Error('no details'); }, sessions: inventory(sessions) });
const liveList = async (sessions?: FleetSessionV1[]) => buildLiveSessions(await fleetMap(sessions), NOW, { subagents: [] });
/** Twelve recorded steps, so the one that names the keychain is far above the newest three a short thread carries. */
const activity = (job: string, early: string): FleetJobActivityV1 => ({
  schema: 'fleet.job.activity.v1', generatedAt: ago(0), job, state: 'running', lane: 'claude', tier: 'frontier', model: 'fixture-model',
  sources: { events: 'healthy', commands: 'healthy', files: 'healthy', reports: 'healthy' }, counts: { events: 12, commands: 0, files: 0, reports: 1 }, truncated: false,
  entries: [
    { kind: 'report', name: 'brief', state: 'ok', source: 'prompt', bytes: 20, truncated: false, text: `Brief for ${job}.` },
    ...Array.from({ length: 12 }, (_, n) => ({ kind: 'event', at: ago(30 - n), event: n === 1 ? 'note' : 'verify', summary: n === 1 ? early : `pass ${n}` })),
  ] as FleetJobActivityV1['entries'],
});
const message = (id: string, to: string, summary: string): AgentMessage => ({
  id, ts: ago(5), from: { name: 'reviewer', lane: null }, to: { name: to, lane: null }, kind: 'status', summary, conversation: 'c', job: to, pr: null,
});
const bus = (messages: AgentMessage[]): AgentMessages => ({ schema: 'agent-messages.v1', source: 'available', messages, matched: messages.length, skipped: 0 });
const LONG = `${'alpha '.repeat(80)}the Keychain prompt blocked the signing step ${'omega '.repeat(80)}`;
const parts = (over: Partial<SessionThreadsParts> = {}): SessionThreadsParts => ({
  sessionsRead: true, bus: bus([message('m1', 'RQ-B', 'Please rebase onto master first.')]),
  activity: new Map([['RQ-A', activity('RQ-A', LONG)], ['RQ-B', activity('RQ-B', 'Read the brief.')]]), ...over,
});
/** The list's own gap in these fixtures: nothing records the leader session. A search carries the list's gaps first. */
const LEADER_GAP = 'Leader state, model and messages unknown: no source records the leader session yet.';
const find = async (query: string, over: Partial<SessionThreadsParts> = {}) => buildSessionFind(await liveList(), parts(over), findWords(query), NOW);

afterEach(() => vi.restoreAllMocks());

describe('the words of a query', () => {
  it('lowers case, drops one-letter words and repeats, and keeps eight', () => {
    expect(findWords('  Keychain a KEYCHAIN  prompt ')).toEqual(['keychain', 'prompt']);
    expect(findWords('x y')).toEqual([]);
    expect(findWords('aa bb cc dd ee ff gg hh ii jj')).toHaveLength(8);
  });
});

describe('fleet.session-find.v1', () => {
  it('finds a word the newest messages of the short threads do not carry, cut to the words around it', async () => {
    const short = buildSessionThreads(await liveList(), parts(), NOW);
    expect(JSON.stringify(short.threads.map(entry => entry.messages)).toLowerCase()).not.toContain('keychain');
    const read = await find('KEYCHAIN');
    expect(read).toMatchObject({ schema: 'fleet.session-find.v1', generatedAt: ago(0), words: ['keychain'], filter: { lane: null, repo: null, live: false },
      counts: { sessions: 3, searched: 3, found: 1 }, sources: { sessions: 'available', bus: 'available', owner: 'none', orders: 'none' }, gaps: [LEADER_GAP] });
    expect(Object.keys(read)).toEqual(['schema', 'generatedAt', 'words', 'filter', 'counts', 'results', 'sources', 'gaps']);
    const [result] = read.results;
    expect(Object.keys(result!)).toEqual(['session', 'summary', 'hits', 'hitCount', 'messageCount']);
    expect([result!.session.id, result!.hitCount, result!.hits.length]).toEqual(['RQ-A', 1, 1]);
    const hit = result!.hits[0]!;
    expect(Object.keys(hit)).toEqual(['key', 'kind', 'side', 'label', 'at', 'text', 'truncated']);
    expect(hit.text).toMatch(/^….*the Keychain prompt blocked the signing step.*…$/);
    expect([hit.truncated, hit.text.length <= FIND_TEXT_CHARS + 2]).toEqual([true, true]);
    expect(result!.messageCount).toBeGreaterThan(result!.hitCount);
  });

  it('wants every word somewhere in the session, and lists only the messages that hold one', async () => {
    expect((await find('keychain rebase')).results).toEqual([]);
    // "codex" is the lane of RQ-B and "rebase" is in a bus message to it: the two together are one result with one hit.
    const both = await find('codex rebase');
    expect(both.results.map(result => [result.session.id, result.hits.map(hit => hit.kind)])).toEqual([['RQ-B', ['bus']]]);
    // Words that are only in a session's facts give the session with no hit.
    expect((await find('codex')).results.map(result => [result.session.id, result.hitCount])).toEqual([['RQ-B', 0]]);
    // Every step of both workers says "pass": the newest five of each, oldest first.
    const many = await find('pass');
    expect(many.results.map(result => [result.session.id, result.hits.length, result.hitCount > FIND_HITS_SHOWN])).toEqual([['RQ-A', FIND_HITS_SHOWN, true], ['RQ-B', FIND_HITS_SHOWN, true]]);
    expect(many.results[0]!.hits.at(-1)!.text).toContain('pass 11');
  });

  it('says what it could not look through, and never reads an unreadable list as nothing found', async () => {
    const down = await find('pass', { bus: null, owner: null, orders: null, activity: new Map([['RQ-A', null]]) });
    expect(down.sources).toEqual({ sessions: 'available', bus: 'unavailable', owner: 'unavailable', orders: 'unavailable' });
    expect(down.gaps).toEqual([LEADER_GAP, 'Bus messages not searched: the agent bus could not be read.', 'Messages from Mason not searched: the Leader inbox could not be read.',
      'Routing not searched: the order trace could not be read.', 'Some sessions\' recorded steps not searched: their activity could not be read.']);
    expect((await find('a')).gaps).toEqual([LEADER_GAP, 'Nothing to search for: give at least one word of two characters or more.']);
    const unread = buildSessionFind(buildLiveSessions(null, NOW), { sessionsRead: false, bus: null, activity: new Map() }, ['pass'], NOW);
    expect(unread).toMatchObject({ results: [], counts: { sessions: 0, searched: 0, found: 0 }, sources: { sessions: 'unavailable' }, gaps: ['Sessions unknown: the session list could not be read.'] });
    const crowd = Array.from({ length: FIND_SESSIONS_MAX + 2 }, (_, n) => session(`RQ-N${n}`));
    const capped = buildSessionFind(await liveList(crowd), { sessionsRead: true, bus: bus([]), activity: new Map() }, ['rq-n1'], NOW);
    expect(capped.counts).toMatchObject({ sessions: FIND_SESSIONS_MAX + 3, searched: FIND_SESSIONS_MAX });
    expect(capped.gaps.at(-1)).toBe(`3 more sessions not searched: a search reads ${FIND_SESSIONS_MAX}. Narrow it with a lane or repo, or ask for running ones only.`);
  });

  it('prints one block per session for people', async () => {
    const lines = renderSessionFindText(await find('rebase')).split('\n');
    expect(lines[0]).toBe('1 of 3 sessions holds "rebase".');
    expect(lines[2]).toMatch(/^RQ-B \| worker \| running \| 1 of \d+ messages$/);
    expect(lines[3]).toMatch(/^ {2}> .*: Please rebase onto master first\.$/);
    expect(lines.at(-1)).toBe(`Open one: phm sessions thread <id> --all. Updated ${ago(0)}.`);
    expect(renderSessionFindText(await find('nowhere'))).toContain('0 of 3 sessions hold "nowhere".');
  });
});

describe('the reader', () => {
  const reads = () => ({
    readMap: vi.fn(() => fleetMap([session('RQ-A'), session('RQ-QUIET', { lastOutputAt: ago(25) })])), readSubagents: async () => [],
    readActivity: vi.fn(async (job: string) => activity(job, 'Read the brief.')), readBus: vi.fn(() => bus([])),
    readOwner: vi.fn(async () => ({ sourceState: 'healthy' as const, entries: [] })),
    readReplies: vi.fn(async () => ({ schema: 'leader.replies.v1' as const, version: 1 as const, sourceState: 'healthy' as const, entries: [], replies: [] })),
    readOrders: vi.fn(async () => { throw new Error('no trace'); }), readControls: vi.fn(async () => []),
    readOutput: vi.fn(async (job: string): Promise<SessionThreadOutputRead> => ({ source: 'healthy', truncated: false, lines: [`${job} wrote: compiling the sidecar`] } as SessionThreadOutputRead)),
  });

  it('reads the end of every job log, not only a running session\'s as the short threads do, and searches it', async () => {
    const all = reads();
    const read = await readSessionFind('sidecar', { now: NOW, ...all });
    expect(all.readOutput.mock.calls.map(call => call[0]).sort()).toEqual(['RQ-A', 'RQ-QUIET']);
    expect(read.results.map(result => [result.session.id, result.session.state, result.hits.map(hit => hit.kind)])).toEqual([['RQ-A', 'running', ['output']], ['RQ-QUIET', 'quiet', ['output']]]);
    expect(read.gaps).toContain('Routing not searched: the order trace could not be read.');
    expect(all.readMap).toHaveBeenCalledTimes(1);
  });

  it('searches text that is already scrubbed, so a secret is neither shown nor confirmed', async () => {
    const secret = `ghp_${'a'.repeat(36)}`;
    const withSecret = { ...reads(), readBus: vi.fn(() => bus([message('m1', 'RQ-A', `token ${secret} for the push`)])) };
    const shown = await readSessionFind('token', { now: NOW, ...withSecret });
    expect(shown.results.map(result => result.session.id)).toEqual(['RQ-A']);
    expect(JSON.stringify(shown)).not.toContain(secret);
    expect((await readSessionFind(secret, { now: NOW, ...withSecret })).results).toEqual([]);
  });

  it('reads an unreadable session map as unknown and asks for nothing else', async () => {
    const down = reads();
    const read = await readSessionFind('pass', { now: NOW, ...down, readMap: async () => { throw new Error('runs dir unreadable'); } });
    expect(read).toMatchObject({ results: [], sources: { sessions: 'unavailable' } });
    expect(down.readBus).not.toHaveBeenCalled();
    expect(down.readActivity).not.toHaveBeenCalled();
  });
});

describe('GET /api/verse/fleet/control/session-find', () => {
  const PATH = '/api/verse/fleet/control/session-find';
  const call = async (url: string, opts: { session?: boolean; method?: string; read?: (...args: never[]) => Promise<unknown> } = {}) => {
    const read = vi.fn(opts.read ?? (async (words: readonly string[]) => buildSessionFind(await liveList(), parts(), words, NOW)));
    let status = 0, body = '';
    const res = { writeHead: (code: number) => { status = code; return res; }, setHeader: () => res, end: (chunk?: string) => { body = chunk ?? ''; } } as unknown as ServerResponse;
    const ctx = { readSession: opts.session === false ? undefined : { expiresAt: Date.now() + 60_000 } } as never;
    const handled = await createFleetSessionFindApi(read as never)(ctx, { url } as IncomingMessage, res, url.split('?')[0]!, opts.method ?? 'GET');
    return { handled, status, body: body ? JSON.parse(body) : null, read };
  };

  it('serves the results with a read session and validates the query', async () => {
    const ok = await call(`${PATH}?q=Keychain+prompt`);
    expect(ok).toMatchObject({ handled: true, status: 200, body: { schema: 'fleet.session-find.v1', counts: { found: 1 }, results: [{ session: { id: 'RQ-A' } }] } });
    expect(ok.read).toHaveBeenCalledWith(['keychain', 'prompt'], { lane: null, repo: null });
    expect((await call(`${PATH}?q=pass&lane=codex&repo=phantom&live=1`)).read).toHaveBeenCalledWith(['pass'], { lane: 'codex', repo: 'phantom', live: true });
    expect((await call(`${PATH}?q=pass`, { session: false })).status).toBe(401);
    expect((await call(`${PATH}?q=pass`, { method: 'POST' })).status).toBe(405);
    for (const bad of ['', '?q=', '?q=a', '?q=pass&q=more', '?q=pass&id=RQ-A', '?q=pass&lane=..%2Fetc', '?q=pass&live=yes', `?q=${'ab'.repeat(101)}`]) {
      const refused = await call(`${PATH}${bad}`);
      expect([bad, refused.status]).toEqual([bad, 400]);
      expect(refused.read).not.toHaveBeenCalled();
    }
    expect((await call('/api/verse/fleet/control/session-threads')).handled).toBe(false);
  });

  it('answers 503 when the session list cannot be read', async () => {
    const unread = async () => buildSessionFind(buildLiveSessions(null, NOW), { sessionsRead: false, bus: null, activity: new Map() }, ['pass'], NOW);
    expect(await call(`${PATH}?q=pass`, { read: unread })).toMatchObject({ status: 503, body: { error: 'Sessions unavailable.' } });
    expect((await call(`${PATH}?q=pass`, { read: async () => { throw new Error('x'); } })).status).toBe(503);
  });

  it('reads the fleet once for several queries, and is routed by the fleet control API', async () => {
    const readParts = vi.fn(async () => ({ list: await liveList(), parts: parts(), now: NOW }));
    const read = defaultSessionFindRead(readParts);
    const [first, second] = await Promise.all([read(['keychain'], { lane: null, repo: null }), read(['rebase'], { lane: null, repo: null })]);
    expect([first.results[0]!.session.id, second.results[0]!.session.id]).toEqual(['RQ-A', 'RQ-B']);
    expect(readParts).toHaveBeenCalledTimes(1);
    await read(['pass'], { lane: 'codex', repo: null });
    expect(readParts).toHaveBeenCalledTimes(2);
    let status = 0;
    const res = { writeHead: (code: number) => { status = code; return res; }, setHeader: () => res, end: () => {} } as unknown as ServerResponse;
    expect(await handleFleetControlApi({} as never, { url: `${PATH}?q=pass` } as IncomingMessage, res, PATH, 'GET')).toBe(true);
    expect(status).toBe(401);
    expect(typeof readSessionFindParts).toBe('function');
  });
});

describe('phm sessions find', () => {
  const run = async (args: string[], read: Parameters<typeof cmdSessionFind>[1] = async query => buildSessionFind(await liveList(), parts(), findWords(query), NOW)) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await cmdSessionFind(args, read);
    return { code, out: log.mock.calls.map(call => String(call[0])).join('\n'), err: stderr.mock.calls.map(call => String(call[0])).join('') };
  };

  it('prints the results as text or JSON and passes the words and filters on', async () => {
    const text = await run(['rebase']);
    expect([text.code, text.out.split('\n')[0]]).toEqual([0, '1 of 3 sessions holds "rebase".']);
    vi.restoreAllMocks();
    const read = vi.fn(async (query: string) => buildSessionFind(await liveList(), parts(), findWords(query), NOW));
    const json = await run(['Keychain', 'prompt', '--lane', 'claude', '--repo', 'phantom', '--live', '--json'], read);
    expect(read).toHaveBeenCalledWith('Keychain prompt', { lane: 'claude', repo: 'phantom', live: true });
    expect(JSON.parse(json.out)).toMatchObject({ schema: 'fleet.session-find.v1', words: ['keychain', 'prompt'], results: [{ session: { id: 'RQ-A' } }] });
    vi.restoreAllMocks();
    expect((await run(['nowhere'])).code).toBe(0);
  });

  it('exits 2 for bad usage and 1 when sessions cannot be read', async () => {
    for (const args of [[], ['a'], ['pass', '--follow'], ['pass', '--lane', '../etc'], ['ab'.repeat(101)]]) {
      vi.restoreAllMocks();
      const read = vi.fn();
      const result = await run(args, read as never);
      expect([args, result.code]).toEqual([args, 2]);
      expect(result.err).toContain('Usage: phm sessions find <words>');
      expect(read).not.toHaveBeenCalled();
    }
    vi.restoreAllMocks();
    const down = await run(['pass'], async () => buildSessionFind(buildLiveSessions(null, NOW), { sessionsRead: false, bus: null, activity: new Map() }, ['pass'], NOW));
    expect(down).toMatchObject({ code: 1, out: '', err: 'Sessions unknown: the session list could not be read.\n' });
  });

  it('is listed in the sessions help and documented for agents', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await cmdSessions(['find', '--help'])).toBe(0);
    expect(String(out.mock.calls[0]![0])).toContain('phm sessions find <words> [--lane <lane>] [--repo <repo>] [--live] [--json]');
    expect(AGENT_COMMANDS.find(command => command.usage.startsWith('phm sessions find '))).toMatchObject({ safety: 'read' });
  });
});
