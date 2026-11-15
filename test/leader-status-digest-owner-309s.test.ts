import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlackLeaderAdapter, readSlackDeliveryPolicy } from '../src/core/agents/slack-leader.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { buildStatusDigest } from '../src/core/leader/status-digest.js';
import { gatherStatusDigestInput, type StatusDigestSources } from '../src/core/leader/status-digest-sources.js';

vi.setConfig({ testTimeout: 30_000 });
const WAIT_MS = 15_000;
const FIXED_NOW = Date.parse('2026-11-06T02:00:00Z');
let root: string;
let options: { configDir: string; runsDir: string; busRoot: string; now: () => number };
const configText = `[mason]\nidentities=[{channel="slack",id="U000TEST"}]\n[team]\nidentities=[{channel="slack",id="U000TEST"},{channel="slack",id="U0FAKEPEER"}]\n[slack]\nbridge_id="slack"\nteam_id="T0FAKETEAM"\nown_user_id="U0FAKEBOT"\nown_bot_id="B0FAKEBOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="D000TEST"\n`;
const THREAD_TS = '1793920000.000001';

function slackEvent(text: string, eventId: string, ts: string, user = 'U000TEST') {
  return { type: 'events_api', envelope_id: `${eventId}-delivery`, payload: { team_id: 'T0FAKETEAM', event_id: eventId, event: {
    type: 'message', user, channel: 'D000TEST', ts, thread_ts: THREAD_TS, text } } };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'status-digest-owner-309s-'));
  options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => FIXED_NOW };
  mkdirSync(options.configDir, { mode: 0o700 });
  writeFileSync(join(options.configDir, 'agent-network.toml'), configText, { mode: 0o600 });
  writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function fakeCall(): SlackCall {
  return vi.fn(async (method, body = {}) => {
    if (method === 'auth.test') return { team_id: 'T0FAKETEAM', user_id: 'U0FAKEBOT', bot_id: 'B0FAKEBOT' };
    if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
    if (method === 'conversations.info') return { channel: { id: body.channel, is_im: true, context_team_id: 'T0FAKETEAM' } };
    if (method === 'conversations.members') return { members: ['U0FAKEBOT', 'U000TEST'], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: body.user, team_id: 'T0FAKETEAM', is_bot: body.user === 'U0FAKEBOT' } };
    if (method === 'chat.postMessage') return { channel: body.channel, ts: '1793920002.000001' };
    if (method === 'conversations.replies' || method === 'conversations.history') return { messages: [] };
    throw new Error('unexpected-synthetic-method');
  });
}
const posts = (call: SlackCall) => vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage');

/** Real openSlackSocket -> createSlackLeaderAdapter -> ownerStatusReply ->
 * gatherStatusDigestInput -> buildStatusDigest. Only the Slack network (SlackCall)
 * and the external fact readers (StatusDigestSources) are synthetic. */
async function connect(call: SlackCall, sources: StatusDigestSources, seen: { runsDir: string; nowMs: number }[]) {
  const policy = readSlackDeliveryPolicy(options)!;
  const brief = async (runsDir: string, now: Date) => {
    seen.push({ runsDir, nowMs: now.getTime() });
    return ['Morning leader brief', ...buildStatusDigest(await gatherStatusDigestInput(runsDir, now, sources))].join('\n');
  };
  const adapter = createSlackLeaderAdapter({ ...options, call, statusReply: ownerStatusReply({ brief }) });
  const handlers: Record<string, (event: { data?: unknown }) => void> = {};
  const socket = { readyState: 1, addEventListener: (type: string, callback: (event: { data?: unknown }) => void) => { handlers[type] = callback; }, send: vi.fn(), close: vi.fn() };
  await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: options.runsDir, busRoot: options.busRoot },
    leaderAdapter: adapter, connect: () => socket });
  return { socket, handlers };
}

const lane = (lane: string, running: number, target: number) => ({ lane, running, target, held: false, heldReason: null, queued: 0, floor: null, ceiling: null, tokensLastHour: null, merged24h: null, mergeRate24h: null });
const healthyRuns = (lanes: ReturnType<typeof lane>[]) => async () => ({ runsDirPresent: true, sources: { status: 'healthy' } as never, lanes });

function counted(sources: StatusDigestSources, calls: Record<string, number>, args: Record<string, unknown[][]>): StatusDigestSources {
  const wrap = <A extends unknown[], R>(name: string, fn: (...a: A) => R) => (...a: A): R => {
    calls[name] = (calls[name] ?? 0) + 1; args[name] = [...(args[name] ?? []), a]; return fn(...a);
  };
  return {
    installedVersion: wrap('installedVersion', sources.installedVersion),
    publishedVersion: wrap('publishedVersion', sources.publishedVersion),
    mergeFacts: wrap('mergeFacts', sources.mergeFacts),
    runsState: wrap('runsState', sources.runsState),
    needs: wrap('needs', sources.needs),
    inbox: wrap('inbox', sources.inbox),
  };
}

describe('status digest owner reply over the real Slack path (RQ-PHX-STATUSDIGESTOWNER309S)', () => {
  it('re-reads every source per ask: a second status event in the same thread posts the new facts', async () => {
    const calls: Record<string, number> = {};
    const args: Record<string, unknown[][]> = {};
    const seen: { runsDir: string; nowMs: number }[] = [];
    // Mutable fact state: readers resolve through `state` so values can move
    // between the two asks and prove each reply is a fresh read.
    const state: StatusDigestSources = {
      installedVersion: () => '3.29.15',
      publishedVersion: async () => '3.30.32',
      mergeFacts: async () => ({ shipped: [{ text: 'ashlrai/phantom#1: a' }], mergeCountUnavailable: false }),
      runsState: healthyRuns([lane('claude', 4, 8)]),
      needs: () => ({ status: 'available', items: [{ text: 'need the Stripe API key' }] }),
      inbox: async () => ({ sourceState: 'healthy', entries: [{ at: '2026-11-05 21:00', source: 'Slack', priority: 'P0', text: 'first status ask' }] }),
    };
    const sources = counted({
      installedVersion: () => state.installedVersion(),
      publishedVersion: nowMs => state.publishedVersion(nowMs),
      mergeFacts: (sinceMs, nowMs) => state.mergeFacts(sinceMs, nowMs),
      runsState: (runsDir, nowMs) => state.runsState(runsDir, nowMs),
      needs: runsDir => state.needs(runsDir),
      inbox: runsDir => state.inbox(runsDir),
    }, calls, args);
    const call = fakeCall();
    const { handlers } = await connect(call, sources, seen);

    handlers.message!({ data: JSON.stringify(slackEvent('Phantom status', 'Ev-309s-a', '1793920001.000001')) });
    await vi.waitFor(() => expect(posts(call)).toHaveLength(1), { timeout: WAIT_MS });
    const first = posts(call)[0]?.[1] as { channel: string; thread_ts: string; text: string };
    expect(first).toMatchObject({ channel: 'D000TEST', thread_ts: THREAD_TS });
    expect(first.text).toContain('published 3.30.32');
    expect(first.text).toContain('claude 4/8');
    expect(first.text).toContain('Top P0: first status ask');
    const firstCalls = { ...calls };

    // Facts move between the two asks; nothing may be served from the first read.
    state.publishedVersion = async () => '3.31.0';
    state.mergeFacts = async () => ({ shipped: [{ text: 'ashlrai/phantom#1: a' }, { text: 'ashlrai/phantom#2: b' }], mergeCountUnavailable: false });
    state.runsState = healthyRuns([lane('devin', 2, 6)]);
    state.needs = () => ({ status: 'available', items: [] });
    state.inbox = async () => ({ sourceState: 'healthy', entries: [{ at: '2026-11-05 21:30', source: 'Slack', priority: 'P0', text: 'second status ask' }] });

    handlers.message!({ data: JSON.stringify(slackEvent('status', 'Ev-309s-b', '1793920002.000001')) });
    await vi.waitFor(() => expect(posts(call)).toHaveLength(2), { timeout: WAIT_MS });
    const second = posts(call)[1]?.[1] as { channel: string; thread_ts: string; text: string };
    expect(second).toMatchObject({ channel: 'D000TEST', thread_ts: THREAD_TS });
    expect(second.text).toContain('published 3.31.0 · update pending');
    expect(second.text).toContain('Merges: 2 in the last hour · 2 in the last 24h');
    expect(second.text).toContain('Lanes: devin 2/6');
    expect(second.text).toContain('Needs Mason: none waiting');
    expect(second.text).toContain('Top P0: second status ask');
    for (const stale of ['3.30.32', 'claude 4/8', 'first status ask', '1 in the last hour']) expect(second.text).not.toContain(stale);

    // Fresh reads: every reader ran again for the second ask, on the same runsDir and fixed clock.
    for (const name of ['installedVersion', 'publishedVersion', 'mergeFacts', 'runsState', 'needs', 'inbox']) {
      expect(calls[name], name).toBeGreaterThan(firstCalls[name] ?? 0);
    }
    expect(seen).toHaveLength(2);
    for (const read of seen) {
      expect(read.runsDir).toBe(options.runsDir);
      expect(read.nowMs).toBe(FIXED_NOW);
    }
    for (const read of args.runsState ?? []) expect(read[0]).toBe(options.runsDir);
    for (const read of args.inbox ?? []) expect(read[0]).toBe(options.runsDir);
    for (const read of args.needs ?? []) expect(read[0]).toBe(options.runsDir);
    for (const read of args.publishedVersion ?? []) expect(read[0]).toBe(FIXED_NOW);
    expect(posts(call)).toHaveLength(2);
  });

  it('keeps explicit unknown reasons when readers fail after a healthy period', async () => {
    const seen: { runsDir: string; nowMs: number }[] = [];
    const sources: StatusDigestSources = {
      installedVersion: () => '3.29.15',
      publishedVersion: async () => { throw new Error('MARKER-PUBLISHED-7f3a unreadable'); },
      mergeFacts: async () => ({ shipped: [{ text: 'ashlrai/phantom#9: stale' }], mergeCountUnavailable: true }),
      runsState: async () => ({ runsDirPresent: true, sources: { status: 'degraded' } as never, lanes: [lane('claude', 9, 9)] }),
      needs: () => ({ status: 'unavailable', items: [{ text: 'MARKER-NEEDS stale ask' }] }),
      inbox: async () => ({ sourceState: 'degraded', entries: [{ at: '2026-11-05 21:00', source: 'Slack', priority: 'P0', text: 'MARKER-P0 stale entry' }] }),
    };
    const call = fakeCall();
    const { handlers } = await connect(call, sources, seen);
    handlers.message!({ data: JSON.stringify(slackEvent('Phantom status', 'Ev-309s-c', '1793920003.000001')) });
    await vi.waitFor(() => expect(posts(call)).toHaveLength(1), { timeout: WAIT_MS });
    const body = posts(call)[0]?.[1] as { channel: string; thread_ts: string; text: string };
    expect(body).toMatchObject({ channel: 'D000TEST', thread_ts: THREAD_TS });
    expect(body.text).toContain('App: installed 3.29.15 · published unknown (published release not readable)');
    expect(body.text).toContain('Merges: unknown (GitHub merge count unavailable or incomplete) · unknown (GitHub merge count unavailable or incomplete)');
    expect(body.text).toContain('Lanes: unknown (queue/status.json missing or invalid)');
    expect(body.text).toContain('Needs Mason: unknown (NEEDS-MASON.md could not be read)');
    expect(body.text).toContain('Top P0: unknown (MASON-INBOX.md not readable)');
    // No stale or fabricated healthy facts, and raw error markers never escape.
    for (const bad of ['MARKER-', '3.30.32', 'claude 9/9', 'stale', 'up to date', 'update pending', 'none waiting', 'none in the inbox', '0 in the last']) {
      expect(body.text).not.toContain(bad);
    }
    expect(seen[0]?.runsDir).toBe(options.runsDir);
    expect(seen[0]?.nowMs).toBe(FIXED_NOW);
  });
});
