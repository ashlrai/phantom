/**
 * RQ-PHX-STATUSDIGESTDISK478S: recovers the persisted-source proof still
 * missing from original PR #4885 (head
 * 3e2d0d6c6e6de2efddbd1c865830176a9df1f338; the status slice was recut by
 * #4907). The existing leader-status-reply-path test composes the digest from
 * injected fakeSources, including a fake runsState. This test leaves the real
 * gatherStatusDigestInput -> buildStatusDigest -> composeSlackStatusReply
 * chain in place and lets the production readers (readFleetRunsDirState,
 * readNeedsMason, readInboxEntries) hit real temporary files under a
 * synthetic runs dir. External installed/published/GitHub-merge readers and
 * the Windows ACL adapter are replaced at their lowest boundary; runsState, needs, inbox, the
 * owner composer and the adapter routing are never stubbed.
 *
 * Drive: real openSlackSocket handler -> slackEventToBus ->
 * ingestSlackLeaderEnvelope -> createLeaderNetwork ingest/reply ->
 * deliverSlackLeaderMessage -> deliverSlackEnvelope. A verified fake owner
 * asks "Phantom status"; the answer must carry the lane facts on disk at
 * compose time, land on the request channel and thread, and leave a durable
 * MASON-OUTBOX record plus a 'sent' transport receipt — the socket envelope
 * ack is transport bookkeeping, never delivery proof. Rewriting
 * queue/status.json and re-asking through a new adapter instance must yield
 * the fresh facts; breaking the file must yield "Lanes: unknown (...)",
 * never an invented zero or healthy line. No chmod or other permission games.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlackLeaderAdapter, readSlackDeliveryPolicy, type SlackStatusAnswer } from '../src/core/agents/slack-leader.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { buildStatusDigest } from '../src/core/leader/status-digest.js';
import { gatherStatusDigestInput, type StatusDigestSources } from '../src/core/leader/status-digest-sources.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { PRIVATE_STORAGE_TEST_CONTROL, _setPrivateStorageTestControlForTest } from '../src/core/util/private-storage.js';
import { createSemanticPrivateStorageHarness, trustedWindowsSystemRootForTest, type SemanticPrivateStorageHarness } from './helpers/semantic-private-storage.js';

vi.setConfig({ testTimeout: 30_000 });
// Ingest awaits the unified owner-thread receipt (~1-2 s cold); poll past it.
const WAIT_MS = 15_000;
const OPERATOR = 'U000TEST', CHANNEL = 'D000TEST', TEAM = 'T0FAKETEAM';
const THREAD_TS = '1793920000.000001', SECOND_THREAD_TS = '1793920050.000001';
const POST_TS = '1793920002.000001';
const configText = `[mason]\nidentities=[{channel="slack",id="${OPERATOR}"}]\n` +
  `[team]\nidentities=[{channel="slack",id="${OPERATOR}"},{channel="slack",id="U0FAKEPEER"}]\n` +
  `[slack]\nbridge_id="slack"\nteam_id="${TEAM}"\nown_user_id="U0FAKEBOT"\nown_bot_id="B0FAKEBOT"\n` +
  `bot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n` +
  `[[slack.map]]\ntopic="leaders"\nchannel="${CHANNEL}"\n`;

let root: string;
let privateStorage: SemanticPrivateStorageHarness | undefined;
let options: { configDir: string; runsDir: string; busRoot: string; now: () => number };
const statusPath = () => join(options.runsDir, 'queue', 'status.json');

/** One lane row in the on-disk dispatchd shape that
 * test/fixtures/runs-dir/queue/status.json and readFleetRunsDirState's guarded
 * status parse agree on. */
const lane = (running: number, target: number, extra: { queued?: number; held?: boolean; heldReason?: string } = {}) => ({
  running, target, queued: extra.queued ?? 0, floor: null, ceiling: null,
  held: extra.held ?? false, ...(extra.heldReason !== undefined ? { held_reason: extra.heldReason } : {}),
});

/** Write a real queue/status.json the production runs reader rates healthy. */
function writeQueueStatus(lanes: Record<string, ReturnType<typeof lane>>): void {
  mkdirSync(join(options.runsDir, 'queue'), { recursive: true, mode: 0o700 });
  writeFileSync(statusPath(), JSON.stringify({
    last_tick: '2026-11-06T01:59:58Z', paused: false, mem_free_pct: 42,
    lanes, autopilot: { disk: { free_gb: 64 } },
  }), { mode: 0o600 });
}

/** Real NEEDS-MASON.md the production reader scans for hard-limit asks. */
function writeNeeds(items: string[]): void {
  mkdirSync(options.runsDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(options.runsDir, 'NEEDS-MASON.md'), `# Needs Mason\n${items.map(item => `- [ ] ${item}`).join('\n')}\n`, { mode: 0o600 });
}

/** External readers replaced at their lowest boundary (installed bundle,
 * published release, GitHub merge truth). The disk readers — runsState,
 * needs, inbox — keep production. workClaims/peers/nodeRuns stay undefined so
 * the reply keeps exactly the original five digest facts. */
const externalSeam: Partial<StatusDigestSources> = {
  installedVersion: () => '3.29.15',
  publishedVersion: async () => '3.30.32',
  mergeFacts: async (sinceMs, nowMs) => ({
    shipped: nowMs - sinceMs <= 3_600_000
      ? [{ text: 'ashlrai/phantom#6100: synthetic hourly merge' }]
      : [{ text: 'ashlrai/phantom#6100: a' }, { text: 'ashlrai/phantom#6101: b' },
         { text: 'ashlrai/phantom#6102: c' }, { text: 'ashlrai/other#9: not phantom' }],
    mergeCountUnavailable: false,
  }),
  workClaims: undefined,
  peers: undefined,
  nodeRuns: undefined,
};

/** The production composer seam: real gather + digest over the injected runs dir. */
const diskBrief = async (runsDir: string, now: Date): Promise<string> =>
  ['Morning leader brief', ...buildStatusDigest(await gatherStatusDigestInput(runsDir, now, externalSeam))].join('\n');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'status-digest-disk-478s-'));
  if (process.platform === 'win32') {
    privateStorage = createSemanticPrivateStorageHarness({ systemRoot: trustedWindowsSystemRootForTest() });
    _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, { runner: privateStorage.runner });
  }
  options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => Date.parse('2026-11-06T02:00:00Z') };
  mkdirSync(options.configDir, { mode: 0o700 });
  writeFileSync(join(options.configDir, 'agent-network.toml'), configText, { mode: 0o600 });
  writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
});
afterEach(() => {
  _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, undefined);
  privateStorage = undefined;
  rmSync(root, { recursive: true, force: true });
});

function fakeCall(input: { post?: () => Promise<Record<string, unknown>> } = {}): SlackCall {
  return vi.fn(async (method, body = {}) => {
    if (method === 'auth.test') return { team_id: TEAM, user_id: 'U0FAKEBOT', bot_id: 'B0FAKEBOT' };
    if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
    if (method === 'conversations.info') return { channel: { id: body.channel, is_im: true, context_team_id: TEAM } };
    if (method === 'conversations.members') return { members: ['U0FAKEBOT', OPERATOR], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: body.user, team_id: TEAM, is_bot: body.user === 'U0FAKEBOT' } };
    if (method === 'chat.postMessage') return input.post ? input.post() : { channel: body.channel, ts: POST_TS };
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
  const adapter = createSlackLeaderAdapter({ ...options, call, statusReply: ownerStatusReply({ brief: diskBrief }) });
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

describe('Slack "Phantom status" digest from persisted runs state (PR #4885 disk proof)', () => {
  it('answers with the on-disk lane facts, then the changed facts on a distinct ask', async () => {
    writeQueueStatus({
      claude: lane(4, 8),
      devin: lane(2, 6, { queued: 1 }),
      zai: lane(0, 1, { held: true, heldReason: 'usage cap' }),
    });
    writeNeeds(['rotate the Stripe API key', 'review the docs wording']);
    const call = fakeCall();
    const first = await receive(call, slackEvent('Phantom status', 'Ev-disk-a1', '1793920001.000001', THREAD_TS));
    expect(first.routed).toMatchObject({ owned: true, durable: true });
    expect(first.answer).toEqual({ answered: true, reason: 'answered in-thread' });
    if (process.platform === 'win32') {
      for (const record of ['MASON-INBOX.md', 'MASON-OUTBOX.md']) {
        expect(privateStorage?.requests).toContainEqual({
          operation: 'assure-private-path',
          anchorPath: join(options.runsDir, 'leader'),
          paths: [join(options.runsDir, 'leader', record)],
          kind: 'file',
          mode: 'secure-created',
        });
      }
    }
    expect(posts(call)).toHaveLength(1);
    const body = postBody(call, 0);
    // Same channel and same request thread the verified owner used.
    expect(body).toMatchObject({ channel: CHANNEL, thread_ts: THREAD_TS });
    // All five original digest facts, derived from real persisted state.
    expect(body.text).toContain('Leader: Phantom status, 21:00 ET\n');
    expect(body.text).toContain('App: installed 3.29.15 · published 3.30.32 · update pending');
    expect(body.text).toContain('Merges: 1 in the last hour · 3 in the last 24h');
    expect(body.text).toContain('Lanes: claude 4/8, devin 2/6 · held: zai (usage cap)');
    expect(body.text).toContain('Needs the owner: 1 hard-limit ask waiting');
    expect(body.text).toContain('Top P0: Phantom status (0m ago)');

    // The socket ack is transport bookkeeping, not delivery. The journaled
    // MASON-OUTBOX record, the leader-reply bus publish and the transport's
    // 'sent' receipt are the durable delivery evidence.
    await vi.waitFor(() => expect(first.socket.send).toHaveBeenCalledWith(JSON.stringify({ envelope_id: 'Ev-disk-a1-delivery' })), { timeout: WAIT_MS });
    const outbox = readFileSync(join(options.runsDir, 'leader', 'MASON-OUTBOX.md'), 'utf8');
    expect(outbox).toContain('Leader: Phantom status, 21:00 ET');
    expect(outbox).toContain('Lanes: claude 4/8, devin 2/6 · held: zai (usage cap)');
    const page = listBusInboxAfter(0, 50, { root: options.busRoot, now: options.now });
    expect(page.status === 'ok' && page.messages.some(row => row.envelope.from === 'leader' &&
      (row.envelope.body as { kind?: string; text?: string }).kind === 'leader-reply' &&
      (row.envelope.body as { text?: string }).text?.includes('claude 4/8'))).toBe(true);
    const receipts = sentReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ channel: CHANNEL, thread: THREAD_TS, ts: POST_TS });

    // Rewrite the persisted lane state; a new adapter instance and a distinct
    // event must answer with the fresh disk facts, not the first reply's.
    writeQueueStatus({
      claude: lane(7, 8),
      devin: lane(1, 6),
      'codex-cmp': lane(0, 0, { held: true, heldReason: 'paused for maintenance' }),
    });
    const second = await receive(call, slackEvent('status?', 'Ev-disk-a2', '1793920003.000001', SECOND_THREAD_TS));
    expect(second.answer).toEqual({ answered: true, reason: 'answered in-thread' });
    expect(posts(call)).toHaveLength(2);
    const fresh = postBody(call, 1);
    // The reply follows the second request's thread, not the first's.
    expect(fresh).toMatchObject({ channel: CHANNEL, thread_ts: SECOND_THREAD_TS });
    expect(fresh.text).toContain('Lanes: claude 7/8, devin 1/6 · held: codex-cmp (paused for maintenance)');
    expect(fresh.text).toContain('Top P0: status? (0m ago)');
    for (const stale of ['claude 4/8', 'devin 2/6', 'usage cap', 'Top P0: Phantom status']) expect(fresh.text).not.toContain(stale);
    const next = sentReceipts();
    expect(next).toHaveLength(2);
    expect(next.some(row => row.thread === SECOND_THREAD_TS && row.channel === CHANNEL && row.ts === POST_TS)).toBe(true);
  });

  it('reports the lane source unknown when queue/status.json becomes invalid, never an invented line', async () => {
    writeQueueStatus({ claude: lane(4, 8), devin: lane(2, 6) });
    const call = fakeCall();
    const first = await receive(call, slackEvent('Phantom status', 'Ev-disk-b1', '1793920011.000001', THREAD_TS));
    expect(first.answer?.answered).toBe(true);
    expect(postBody(call, 0).text).toContain('Lanes: claude 4/8, devin 2/6');

    // The persisted source turns unreadable: a syntactically valid JSON file
    // whose shape the runs reader rejects — deterministic and portable, with
    // no reliance on chmod under any user.
    writeFileSync(statusPath(), JSON.stringify({ lanes: 'not-an-object' }), { mode: 0o600 });
    const second = await receive(call, slackEvent('status?', 'Ev-disk-b2', '1793920013.000001', THREAD_TS));
    expect(second.answer?.answered).toBe(true);
    const text = postBody(call, 1).text;
    expect(text).toContain('Lanes: unknown (queue/status.json missing or invalid)');
    for (const stale of ['claude 4/8', 'devin 2/6', 'no lane has a target']) expect(text).not.toContain(stale);
    expect(text).not.toMatch(/Lanes:[^\n]*\d+\/\d+/);
    // The inbox fact is still freshly read, and the degraded answer travels
    // the same durable reply path as the healthy one.
    expect(text).toContain('Top P0: status? (0m ago)');
    expect(posts(call)).toHaveLength(2);
    expect(sentReceipts()).toHaveLength(2);
  });
});
