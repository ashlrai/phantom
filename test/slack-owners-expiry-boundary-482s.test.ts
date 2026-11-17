/** Real durable claim expiry -> owner composer -> socket/Leader -> Slack delivery; no live I/O.
 * Qualifies the exact lease boundary (claim.expiresAt): the advisory owner must
 * stop being named at expiresAt, reads must not mutate the coordination ledger
 * once expiry is durable, a fresh claim must recover the answer, and a live
 * foreign-repository claim must never become Phantom ownership. The one
 * sanctioned ledger write is readFleetBoard's own lease reap at expiresAt —
 * the durable boundary itself — asserted line-by-line below. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlackLeaderAdapter, readSlackDeliveryPolicy, type SlackStatusAnswer } from '../src/core/agents/slack-leader.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { defaultOwnersReply, ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { claimFleetWork, readFleetBoard, type FleetCoordinationResult } from '../src/core/fleet/coordination.js';
import { readSurfaceOwner } from '../src/core/fleet/surface-owner.js';

vi.setConfig({ testTimeout: 30_000 });
const WAIT_MS = 15_000;
const OPERATOR = 'U000TEST', CHANNEL = 'D000TEST', TEAM = 'T0FAKETEAM';
const POST_TS = '1793920002.000001';
const ASK = 'who owns the bridge';
const ALPHA = 'fake-agent-alpha', BETA = 'fake-agent-beta', FOREIGN = 'fake-agent-foreign';
const TASK_A = 'fake private task naming slack-bridge';
const TASK_F = 'fake foreign task naming slack-bridge';
const TASK_B = 'fake successor task naming slack-bridge';
const FOREIGN_REPO = 'otherorg/foreignrepo';
const TTL_MS = 120_000;
const configText = `[mason]\nidentities=[{channel="slack",id="${OPERATOR}"}]\n` +
  `[team]\nidentities=[{channel="slack",id="${OPERATOR}"},{channel="slack",id="U0FAKEPEER"}]\n` +
  `[slack]\nbridge_id="slack"\nteam_id="${TEAM}"\nown_user_id="U0FAKEBOT"\nown_bot_id="B0FAKEBOT"\n` +
  `bot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n` +
  `[[slack.map]]\ntopic="leaders"\nchannel="${CHANNEL}"\n`;

let root: string;
let now = 0;
let path: string;
let options: { configDir: string; runsDir: string; busRoot: string; now: () => number };
const owners = vi.fn((date: Date) => defaultOwnersReply(date, {
  read: surface => readSurfaceOwner(surface, {
    board: opts => readFleetBoard({ path, now: opts?.now }),
    log: async () => [], now: () => date.getTime(),
  }),
}));
function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`fixture write failed: ${result.error}`);
  return result.value;
}
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function fakeCall(): SlackCall {
  return vi.fn(async (method, body = {}) => {
    if (method === 'auth.test') return { team_id: TEAM, user_id: 'U0FAKEBOT', bot_id: 'B0FAKEBOT' };
    if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
    if (method === 'conversations.info') return { channel: { id: body.channel, is_im: true, context_team_id: TEAM } };
    if (method === 'conversations.members') return { members: ['U0FAKEBOT', OPERATOR], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: body.user, team_id: TEAM, is_bot: body.user === 'U0FAKEBOT' } };
    if (method === 'chat.postMessage') return { channel: body.channel, ts: POST_TS };
    if (method === 'conversations.replies' || method === 'conversations.history') return { messages: [] };
    throw new Error('unexpected-synthetic-method');
  });
}
const posts = (call: SlackCall) => vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage');
const postBody = (call: SlackCall, index: number) => posts(call)[index]?.[1] as { channel: string; thread_ts: string; text: string };

interface SendReceiptRow { state: string; channel: string; thread?: string; ts?: string }
/** The transport's durable delivery receipts; a 'sent' row is the proof a post landed. */
function sentReceipts(): SendReceiptRow[] {
  const store = JSON.parse(readFileSync(join(options.runsDir, 'slack-transport', 'messages.json'), 'utf8')) as { messages: Record<string, SendReceiptRow> };
  return Object.values(store.messages).filter(row => row.state === 'sent');
}

function slackEvent(text: string, eventId: string, ts: string, threadTs: string) {
  return { type: 'events_api', envelope_id: `${eventId}-delivery`, payload: { team_id: TEAM, event_id: eventId, event: {
    type: 'message', user: OPERATOR, channel: CHANNEL, ts, thread_ts: threadTs, text } } };
}

/** One inbound event through the real socket handler; a fresh adapter instance
 * per call, and the detached in-thread answer awaited to completion. */
async function receive(call: SlackCall, payload: unknown) {
  const policy = readSlackDeliveryPolicy(options)!;
  const adapter = createSlackLeaderAdapter({ ...options, call, statusReply: ownerStatusReply({ owners }) });
  let routed: { owned: boolean; durable: boolean; statusAnswer?: Promise<SlackStatusAnswer> } | undefined;
  let settled = false;
  const handlers: Record<string, (event: { data?: unknown }) => void> = {};
  const socket = { readyState: 1, addEventListener: (type: string, callback: (event: { data?: unknown }) => void) => { handlers[type] = callback; }, send: vi.fn(), close: vi.fn() };
  await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: options.runsDir, busRoot: options.busRoot },
    leaderAdapter: { ...adapter, route: async envelope => { try { return routed = await adapter.route(envelope); } finally { settled = true; } } }, connect: () => socket });
  handlers.message!({ data: JSON.stringify(payload) });
  await vi.waitFor(() => expect(settled).toBe(true), { timeout: WAIT_MS });
  const answer = routed?.statusAnswer ? await routed.statusAnswer : undefined;
  return { routed, answer, socket };
}

const ledgerEvents = (text: string): Array<Record<string, unknown>> =>
  text.length === 0 ? [] : text.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);

describe('slack owners answer at the durable lease boundary', () => {
  it('drops the advisory owner at expiresAt, keeps reads write-free, and recovers on a fresh claim', async () => {
    root = mkdtempSync(join(tmpdir(), 'fake-owners-expiry-482s-'));
    path = join(root, 'fake-ledger.jsonl');
    now = Date.parse('2026-11-16T12:00:00.000Z');
    options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => now };
    mkdirSync(options.configDir, { mode: 0o700 });
    writeFileSync(join(options.configDir, 'agent-network.toml'), configText, { mode: 0o600 });
    writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
    const call = fakeCall();
    const forbidden = [root, path, TASK_A, TASK_F, TASK_B, 'leaseHash', FOREIGN];
    const alpha = must(claimFleetWork({ repo: 'ashlrai/phantom', task: TASK_A, agent: ALPHA, ttlMs: TTL_MS }, { path, now }));
    // A live foreign-repository claim naming the same surface rides along the
    // whole scenario: it must never become Phantom ownership.
    const foreign = must(claimFleetWork({ repo: FOREIGN_REPO, task: TASK_F, agent: FOREIGN, ttlMs: 5 * TTL_MS }, { path, now }));
    forbidden.push(alpha.lease, alpha.claim.id, foreign.lease, foreign.claim.id);
    const expiresAt = alpha.claim.expiresAt;

    let askCount = 0, stampSeq = 0;
    const stamp = (): string => `179392${String(1000 + ++stampSeq).padStart(4, '0')}.000001`;
    /** One owners ask through a brand-new adapter; asserts the durable sent
     * receipt, the as-of clock, the advisory footer, no leaks, and — the
     * qualification's core — that the read left the ledger byte-identical. */
    const ask = async (expected: string, absent: string[] = []) => {
      const bytes = readFileSync(path);
      const index = ++askCount;
      const thread = stamp();
      const event = slackEvent(ASK, `Ev-expiry-${index}`, stamp(), thread);
      const result = await receive(call, event);
      expect(result.routed).toMatchObject({ owned: true, durable: true });
      expect(result.answer).toEqual({ answered: true, reason: 'answered in-thread' });
      expect(posts(call)).toHaveLength(index);
      const body = postBody(call, index - 1);
      expect(body).toMatchObject({ channel: CHANNEL, thread_ts: thread });
      expect(body.text).toContain(expected);
      expect(body.text).toContain(`Phantom owners, as of ${new Date(now).toISOString()}`);
      expect(body.text.endsWith('Claims are advisory; this reply assigns nothing.')).toBe(true);
      expect(body.text.length).toBeLessThanOrEqual(900);
      for (const value of [...forbidden, ...absent]) expect(body.text).not.toContain(value);
      expect(readFileSync(path)).toEqual(bytes);
      const receipts = sentReceipts();
      expect(receipts).toHaveLength(index);
      expect(receipts.filter(row => row.channel === CHANNEL && row.thread === thread && row.ts === POST_TS)).toHaveLength(1);
      expect(readFileSync(join(options.runsDir, 'leader', 'MASON-OUTBOX.md'), 'utf8')).toContain(body.text);
      await vi.waitFor(() => expect(result.socket.send).toHaveBeenCalledWith(JSON.stringify({ envelope_id: `Ev-expiry-${index}-delivery` })), { timeout: WAIT_MS });
      expect(owners).toHaveBeenCalledTimes(index);
      return { event, thread, text: body.text };
    };

    // Just before expiry the synthetic owner is still the advisory answer.
    now = expiresAt - 1;
    const first = await ask(`slack-bridge: ${ALPHA} (advisory claim`, [BETA]);

    // The exact durable boundary: at expiresAt the real board reader persists
    // the lease reap — the only coordination write this scenario allows — and
    // the foreign claim is the sole live claim left on the ledger.
    const beforeBoundary = readFileSync(path, 'utf8');
    now = expiresAt;
    const boundary = readFleetBoard({ path, now });
    expect(boundary.state).toBe('known');
    expect(boundary.expiredClaims).toBe(1);
    expect(boundary.claims.map(claim => claim.agent)).toEqual([FOREIGN]);
    const afterBoundary = readFileSync(path, 'utf8');
    expect(afterBoundary.startsWith(beforeBoundary)).toBe(true);
    expect(ledgerEvents(afterBoundary.slice(beforeBoundary.length))).toEqual([
      expect.objectContaining({ version: 1, kind: 'reap', at: expiresAt, id: alpha.claim.id, owner: ALPHA, state: 'RELEASED', reason: 'lease-expired' }),
    ]);

    // At and after expiresAt the reply must not report the expired owner as
    // live; each ask is a fresh adapter and leaves the durable ledger untouched.
    await ask('slack-bridge: no live owner', [ALPHA, BETA]);
    now = expiresAt + 30_000;
    await ask('slack-bridge: no live owner', [ALPHA, BETA]);

    // Replaying the original pre-expiry request is fenced: durable ack, no
    // second post, no new receipt, no owner recomputation, no ledger write.
    const beforeReplay = readFileSync(path);
    const replayed = await receive(call, first.event);
    expect(replayed.routed).toMatchObject({ owned: true, durable: true });
    expect(replayed.answer).toBeUndefined();
    await vi.waitFor(() => expect(replayed.socket.send).toHaveBeenCalledWith(JSON.stringify({ envelope_id: 'Ev-expiry-1-delivery' })), { timeout: WAIT_MS });
    expect(posts(call)).toHaveLength(askCount);
    expect(sentReceipts()).toHaveLength(askCount);
    expect(readFileSync(path)).toEqual(beforeReplay);
    expect(owners).toHaveBeenCalledTimes(askCount);

    // A fresh legitimate claim through the public helper recovers the answer:
    // the next new request names the successor, still advisory, still silent
    // on the foreign claim.
    const beta = must(claimFleetWork({ repo: 'ashlrai/phantom', task: TASK_B, agent: BETA, ttlMs: TTL_MS }, { path, now }));
    forbidden.push(beta.lease, beta.claim.id);
    await ask(`slack-bridge: ${BETA} (advisory claim`, [ALPHA, FOREIGN]);

    // The boundary is not a one-off: the successor's own expiresAt reaps the
    // same way and the surface falls back to no live owner once more.
    now = beta.claim.expiresAt;
    const successorBoundary = readFleetBoard({ path, now });
    expect(successorBoundary.expiredClaims).toBe(1);
    expect(successorBoundary.claims.map(claim => claim.agent)).toEqual([FOREIGN]);
    await ask('slack-bridge: no live owner', [ALPHA, BETA]);
    expect(askCount).toBe(5);
  });
});
