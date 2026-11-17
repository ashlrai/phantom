/** RQ-PHX-SLACKPEERPAIR404S: an exact "peer budget from <a> to <b>" ask is
 * answered in the originating Slack thread with that pair's own ledger row —
 * remaining budget and projected retry — even when 64+ live pairs would push
 * it past the aggregate display cap. Metadata only; grants nothing. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ledger from '../src/core/agentnet/peer-ledger.js';
import type { PeerLedgerReport } from '../src/core/agentnet/peer-ledger.js';
import { ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { createSlackLeaderAdapter, readSlackDeliveryPolicy } from '../src/core/agents/slack-leader.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { isPeersAsk, parsePeersAsk } from '../src/core/fleet/peers-ask.js';
import { formatPeerLedgerReply } from '../src/core/fleet/peer-ledger-reply.js';
import { useAccountHomeForTest, useProcessHomeForTest } from '../src/core/real-home.js';

vi.setConfig({ testTimeout: 60_000 });
const WAIT_MS = 15_000;
const NOW_ISO = '2026-11-15T06:00:00.000Z';
const PAIR_FOOTER = 'Read-only ledger metadata; grants no send, claim or dispatch authority.';
const DIGEST = 'a'.repeat(64);
const THREAD = 'fake-private-thread-404s';
const PAIR_LIMIT = 6, DECOYS = 70, ROWS_PER_PAIR = PAIR_LIMIT;

const report = (over: Partial<PeerLedgerReport> = {}): PeerLedgerReport => ({
  v: 1, authority: 'none', status: 'ok', asOf: NOW_ISO, liveRows: 426,
  capacity: 1024, windowMs: 60_000, pairLimit: 6, maxHops: 8,
  pairs: [], origins: [], truncated: { pairs: true, origins: false }, ...over,
});

describe('parsePeersAsk', () => {
  it.each([
    'peers', 'peer budget', 'peer ledger', 'Peers?', '  PEER BUDGET!  ',
    'peer budget from dot to leader', 'Peer Budget From Dot To Leader?',
    'peer ledger from dot to leader', 'peer budget from a-b to c-1',
    `peer budget from ${'a'.repeat(32)} to ${'b'.repeat(32)}`,
  ])('accepts %j', text => expect(isPeersAsk(text)).toBe(true));

  it('returns the aggregate kind for the short asks', () => {
    expect(parsePeersAsk('Peers?')).toEqual({ kind: 'aggregate' });
    expect(parsePeersAsk('peer ledger')).toEqual({ kind: 'aggregate' });
  });

  it('returns the validated pair selector for an exact pair ask', () => {
    expect(parsePeersAsk('peer budget from dot to leader'))
      .toEqual({ kind: 'pair', pair: { fromAgent: 'dot', target: 'leader' } });
    expect(parsePeersAsk('Peer Ledger From Dot To Leader?'))
      .toEqual({ kind: 'pair', pair: { fromAgent: 'dot', target: 'leader' } });
  });

  it.each([
    'peer budget from dot', 'peer budget from dot to', 'peer budget from to leader',
    'peer budget from dot to leader please', 'peer budget too dot to leader',
    'peers from dot to leader', 'peer budget from dot to leader and everyone',
    'peer budget from dot to ../../etc', 'peer budget from DOT_NAME to leader',
    'peer budget from dot to leader; status', '', '   ', 'peer budget from dot to leader\nplease',
  ])('rejects %j', text => {
    expect(isPeersAsk(text)).toBe(false);
    expect(parsePeersAsk(text)).toBeUndefined();
  });
});

describe('formatPeerLedgerReply with a selection', () => {
  const pair = { fromAgent: 'dot', target: 'leader', inWindow: 6, remaining: 0,
    lastAt: NOW_ISO, retryAt: '2026-11-15T06:01:00.000Z' };

  it('renders the selected blocked pair with observation time, remaining and projected retry', () => {
    const out = formatPeerLedgerReply(report({
      selection: { fromAgent: 'dot', target: 'leader', match: 'exact' }, pairs: [pair],
    }));
    expect(out).toContain(`Peers pair dot → leader (as of ${NOW_ISO}): ok`);
    expect(out).toContain('Live rows 426/1024');
    expect(out).toContain('dot → leader: 6/6 in window, 0 left RATE-LIMITED · projected retry 2026-11-15T06:01:00.000Z');
    expect(out).not.toContain('a00 →');
    expect(out.endsWith(PAIR_FOOTER)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(1500);
  });

  it('says no live evidence for an absent or reversed pair, never a quota reading', () => {
    for (const sel of [
      { fromAgent: 'leader', target: 'dot', match: 'none' as const },
      { fromAgent: 'dot', target: 'nobody', match: 'none' as const },
    ]) {
      const out = formatPeerLedgerReply(report({ status: 'empty', liveRows: 0, pairs: [], selection: sel }));
      expect(out).toContain(`${sel.fromAgent} → ${sel.target}: no live evidence — absence is not a quota reading`);
      expect(out).not.toContain('RATE-LIMITED');
      expect(out).not.toContain('in window');
      expect(out.endsWith(PAIR_FOOTER)).toBe(true);
    }
  });

  it('keeps an unavailable ledger unknown for a selected pair', () => {
    const out = formatPeerLedgerReply(report({
      status: 'unavailable', reason: 'peer-ledger-unreadable', liveRows: 0, pairs: [],
      selection: { fromAgent: 'dot', target: 'leader', match: 'none' },
    }));
    expect(out).toBe(`Peers pair dot → leader unknown: peer-ledger-unreadable\n${PAIR_FOOTER}`);
    expect(out).not.toContain('no live evidence');
    expect(out).not.toContain('RATE-LIMITED');
  });
});

describe('peer pair ask end to end', () => {
  let home = '', previousHome: string | undefined, ledgerBase = 0, rowSeq = 0;

  /** 70 decoy pairs that all sort before dot→leader, each fully debited, plus
   * the requested pair — 426 live rows, so the aggregate report truncates it. */
  function seedPeerLedger(): void {
    const dir = join(home, '.ashlr', 'fleet', 'agentnet');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    ledgerBase = Date.now() - 1_000;
    rowSeq = 0;
    const row = (fromAgent: string, target: string, at: number) => ({
      id: `peer-123e4567-e89b-12d3-a456-426614${(rowSeq++).toString(16).padStart(6, '0')}`,
      fromAgent, target, origin: 'peer-123e4567-e89b-12d3-a456-426614174000',
      digest: DIGEST, hopCount: 1, threadId: THREAD, at });
    const rows: unknown[] = [];
    for (let i = 0; i < DECOYS; i++) {
      const from = `a${String(i).padStart(2, '0')}`, to = `b${String(i).padStart(2, '0')}`;
      for (let k = 0; k < ROWS_PER_PAIR; k++) rows.push(row(from, to, ledgerBase - k));
    }
    for (let k = 0; k < ROWS_PER_PAIR; k++) rows.push(row('dot', 'leader', ledgerBase - k));
    writeFileSync(join(dir, 'coordination.json'), JSON.stringify(rows), { mode: 0o600 });
  }

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'peer-pair-home-'));
    process.env.HOME = home;
    useProcessHomeForTest();
    seedPeerLedger();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useAccountHomeForTest();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (home) rmSync(home, { recursive: true, force: true });
  });

  const expectedRetry = () => new Date(ledgerBase - (ROWS_PER_PAIR - 1) + 60_000).toISOString();

  it('hands the exact selector to the real private ledger reader', async () => {
    const spy = vi.spyOn(ledger, 'readPeerLedger');
    const reply = ownerStatusReply();
    expect(reply.ask('peer budget from dot to leader')).toBe(true);
    const out = await reply.compose('/fake-runs', new Date(), 'peer budget from dot to leader');
    expect(spy).toHaveBeenCalledWith({ pair: { fromAgent: 'dot', target: 'leader' } });
    expect(out).toContain('Peers pair dot → leader');
    expect(out).toContain(`projected retry ${expectedRetry()}`);
    expect(out.endsWith(PAIR_FOOTER)).toBe(true);
  });

  it('never lets a malformed or prose selector reach the ledger reader', async () => {
    const spy = vi.spyOn(ledger, 'readPeerLedger');
    const reply = ownerStatusReply({
      brief: async () => 'Morning leader brief\nShipped (last 12h): none',
      board: () => { throw new Error('no board'); },
      snapshot: async () => { throw new Error('no snapshot'); },
    });
    for (const text of [
      'peer budget from dot', 'peer budget from dot to leader please',
      'peer budget from dot to ../../etc', 'peer budget from dot to leader and everyone',
      'peers from dot to leader',
    ]) {
      expect(reply.ask(text)).toBe(false);
      await reply.compose('/fake-runs', new Date(), text);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('peer pair ask over Slack', () => {
  let root = '', home = '', previousHome: string | undefined, ledgerBase = 0, rowSeq = 0;
  const configText = `[mason]\nidentities=[{channel="slack",id="U0FAKEOWNER"}]\n[team]\nidentities=[{channel="slack",id="U0FAKEOWNER"}]\n[slack]\nbridge_id="slack"\nteam_id="T0FAKETEAM"\nown_user_id="U0FAKEBOT"\nown_bot_id="B0FAKEBOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="D0FAKELEADER"\n`;

  function seedPeerLedger(): void {
    const dir = join(home, '.ashlr', 'fleet', 'agentnet');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    ledgerBase = Date.now() - 1_000;
    rowSeq = 0;
    const row = (fromAgent: string, target: string, at: number) => ({
      id: `peer-123e4567-e89b-12d3-a456-426614${(rowSeq++).toString(16).padStart(6, '0')}`,
      fromAgent, target, origin: 'peer-123e4567-e89b-12d3-a456-426614174000',
      digest: DIGEST, hopCount: 1, threadId: THREAD, at });
    const rows: unknown[] = [];
    for (let i = 0; i < DECOYS; i++) {
      const from = `a${String(i).padStart(2, '0')}`, to = `b${String(i).padStart(2, '0')}`;
      for (let k = 0; k < ROWS_PER_PAIR; k++) rows.push(row(from, to, ledgerBase - k));
    }
    for (let k = 0; k < ROWS_PER_PAIR; k++) rows.push(row('dot', 'leader', ledgerBase - k));
    writeFileSync(join(dir, 'coordination.json'), JSON.stringify(rows), { mode: 0o600 });
  }

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'peer-pair-home-'));
    root = mkdtempSync(join(tmpdir(), 'peer-pair-slack-'));
    process.env.HOME = home;
    useProcessHomeForTest();
    seedPeerLedger();
    mkdirSync(join(root, 'config'), { mode: 0o700 });
    writeFileSync(join(root, 'config', 'agent-network.toml'), configText, { mode: 0o600 });
    writeFileSync(join(root, 'config', 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useAccountHomeForTest();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (home) rmSync(home, { recursive: true, force: true });
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const options = () => ({ configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => Date.now() });
  const slackEvent = (text: string, n: number) => ({ type: 'events_api', envelope_id: `Ev-pair-${n}`, payload: { team_id: 'T0FAKETEAM', event_id: `Ev-pair-${n}`, event: {
    type: 'message', user: 'U0FAKEOWNER', channel: 'D0FAKELEADER', ts: `179392000${n}.000001`, thread_ts: '1793920000.000001', text } } });

  function fakeCall(): SlackCall {
    return vi.fn(async (method, body = {}) => {
      if (method === 'auth.test') return { team_id: 'T0FAKETEAM', user_id: 'U0FAKEBOT', bot_id: 'B0FAKEBOT' };
      if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
      if (method === 'conversations.info') return { channel: { id: body.channel, is_im: true, context_team_id: 'T0FAKETEAM' } };
      if (method === 'conversations.members') return { members: ['U0FAKEBOT', 'U0FAKEOWNER'], response_metadata: { next_cursor: '' } };
      if (method === 'users.info') return { user: { id: body.user, team_id: 'T0FAKETEAM', is_bot: body.user === 'U0FAKEBOT' } };
      if (method === 'chat.postMessage') return { channel: body.channel, ts: '1793920002.000001' };
      if (method === 'conversations.replies' || method === 'conversations.history') return { messages: [] };
      throw new Error('unexpected-synthetic-method');
    });
  }
  const posts = (call: SlackCall) => vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage');
  const postText = (call: SlackCall, i: number) => (posts(call)[i]?.[1] as { text?: string } | undefined)?.text ?? '';

  async function receive(call: SlackCall, statusReply: ReturnType<typeof ownerStatusReply>, payload: unknown): Promise<void> {
    let settled = false;
    const opts = options();
    const policy = readSlackDeliveryPolicy(opts)!;
    const adapter = createSlackLeaderAdapter({ ...opts, call, statusReply });
    const handlers: Record<string, (event: { data?: unknown }) => void> = {};
    const socket = { readyState: 1, addEventListener: (type: string, callback: (event: { data?: unknown }) => void) => { handlers[type] = callback; }, send: vi.fn(), close: vi.fn() };
    await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: opts.runsDir, busRoot: opts.busRoot },
      leaderAdapter: { ...adapter, route: async envelope => { try { return await adapter.route(envelope); } finally { settled = true; } } }, connect: () => socket });
    handlers.message!({ data: JSON.stringify(payload) });
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: WAIT_MS });
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce(), { timeout: WAIT_MS });
  }

  it('answers the exact blocked pair in-thread once; aggregate, absent and malformed asks stay honest', async () => {
    const call = fakeCall();
    const reply = ownerStatusReply();
    const retry = new Date(ledgerBase - (ROWS_PER_PAIR - 1) + 60_000).toISOString();

    // The requested pair sorts past the 64-row aggregate cap but the exact ask finds it.
    await receive(call, reply, slackEvent('peer budget from dot to leader', 1));
    await vi.waitFor(() => expect(posts(call)).toHaveLength(1), { timeout: WAIT_MS });
    expect(posts(call)[0]?.[1]).toMatchObject({ channel: 'D0FAKELEADER', thread_ts: '1793920000.000001' });
    const pairText = postText(call, 0);
    expect(pairText).toContain('Leader: Peers pair dot → leader');
    expect(pairText).toContain('dot → leader: 6/6 in window, 0 left RATE-LIMITED');
    expect(pairText).toContain(`projected retry ${retry}`);
    expect(pairText).toContain('grants no send, claim or dispatch authority');
    expect(pairText).not.toContain('a00 →');
    expect(pairText).not.toContain(THREAD);
    expect(pairText).not.toContain(DIGEST);

    // Replaying the same delivery produces no second reply.
    await receive(call, reply, slackEvent('peer budget from dot to leader', 1));
    expect(posts(call)).toHaveLength(1);

    // The reversed pair has no live evidence — never a quota reading.
    await receive(call, reply, slackEvent('peer budget from leader to dot', 2));
    await vi.waitFor(() => expect(posts(call)).toHaveLength(2), { timeout: WAIT_MS });
    const absentText = postText(call, 1);
    expect(absentText).toContain('leader → dot: no live evidence — absence is not a quota reading');
    expect(absentText).not.toContain('RATE-LIMITED');
    expect(absentText).not.toContain('in window');

    // The aggregate ask still works and still cannot see the pair past the cap.
    await receive(call, reply, slackEvent('peer budget', 3));
    await vi.waitFor(() => expect(posts(call)).toHaveLength(3), { timeout: WAIT_MS });
    const aggText = postText(call, 2);
    expect(aggText).toContain('Peers (as of');
    expect(aggText).toContain('Live rows 426/1024');
    expect(aggText).toContain('(list truncated)');
    expect(aggText).not.toContain('dot → leader');

    // A malformed selector is not an ask at all: nothing is posted for it.
    await receive(call, reply, slackEvent('peer budget from dot to leader please', 4));
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(posts(call)).toHaveLength(3);
  });
});
