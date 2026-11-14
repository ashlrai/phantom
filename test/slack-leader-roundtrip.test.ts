import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LeaderInboxAppender } from '../src/core/agents/leader-inbox-writer.js';
import { createSlackLeaderAdapter, readSlackDeliveryPolicy } from '../src/core/agents/slack-leader.js';
import { ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';

// The detached status reply and the unified owner-thread receipt are awaited by
// their observable effects, never by wall-clock sleep.
vi.setConfig({ testTimeout: 30_000 });
const WAIT_MS = 15_000;

let root: string;
let options: { configDir: string; runsDir: string; busRoot: string; now: () => number };
const configText = `[mason]\nidentities=[{channel="slack",id="U0FAKEOWNER"}]\n[team]\nidentities=[{channel="slack",id="U0FAKEOWNER"},{channel="slack",id="U0FAKEPEER"}]\n[slack]\nbridge_id="slack"\nteam_id="T0FAKETEAM"\nown_user_id="U0FAKEBOT"\nown_bot_id="B0FAKEBOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="D0FAKELEADER"\n`;
const briefText = 'Morning leader brief\nShipped (last 12h): synthetic none';

function slackEvent(text: string, user = 'U0FAKEOWNER', eventId = 'Ev-status') {
  return { type: 'events_api', envelope_id: `${eventId}-delivery`, payload: { team_id: 'T0FAKETEAM', event_id: eventId, event: {
    type: 'message', user, channel: 'D0FAKELEADER', ts: '1793920001.000001', thread_ts: '1793920000.000001', text } } };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slack-leader-roundtrip-'));
  options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => Date.parse('2026-11-06T02:00:00Z') };
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
    if (method === 'conversations.members') return { members: ['U0FAKEBOT', 'U0FAKEOWNER'], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: body.user, team_id: 'T0FAKETEAM', is_bot: body.user === 'U0FAKEBOT' } };
    if (method === 'chat.postMessage') return { channel: body.channel, ts: '1793920002.000001' };
    if (method === 'conversations.replies' || method === 'conversations.history') return { messages: [] };
    throw new Error('unexpected-synthetic-method');
  });
}

const posts = (call: SlackCall) => vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage');
const inboxPath = () => join(options.runsDir, 'leader', 'MASON-INBOX.md');
const outboxPath = () => join(options.runsDir, 'leader', 'MASON-OUTBOX.md');
/** MASON-INBOX.md records start on a `## ` heading; escaped bodies never do. */
const entries = (text: string) => text.split('\n').filter(line => line.startsWith('## '));
const requestIdOf = (heading: string) => /\[leader-network:([a-f0-9]{64})\]/.exec(heading)?.[1];

/** One Socket Mode delivery through the production wiring: openSlackSocket ->
 * slackEventToBus -> adapter.route -> ingestSlackLeaderEnvelope -> Leader network. */
async function receive(call: SlackCall, payload: unknown, appendInbox?: LeaderInboxAppender) {
  const policy = readSlackDeliveryPolicy(options)!;
  const adapter = createSlackLeaderAdapter({ ...options, call,
    statusReply: ownerStatusReply({ brief: async () => briefText }),
    ...(appendInbox ? { appendInbox } : {}) });
  const handlers: Record<string, (event: { data?: unknown }) => void> = {};
  const socket = { readyState: 1, addEventListener: (type: string, handler: (event: { data?: unknown }) => void) => { handlers[type] = handler; }, send: vi.fn(), close: vi.fn() };
  await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: options.runsDir, busRoot: options.busRoot },
    leaderAdapter: adapter, connect: () => socket });
  handlers.message!({ data: JSON.stringify(payload) });
  // The socket acks only after the Leader record is durable, or after a
  // deliberate policy rejection; either way this is the settled signal.
  await vi.waitFor(() => expect(socket.send).toHaveBeenCalled(), { timeout: WAIT_MS });
  return socket;
}

describe('Slack "Phantom status" round trip through the Leader network', () => {
  it('records the verified owner ask once in MASON-INBOX.md and answers it on the same Slack thread', async () => {
    const call = fakeCall();
    const socket = await receive(call, slackEvent('Phantom status'));
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ envelope_id: 'Ev-status-delivery' }));

    // Exactly one inbox record, on the slack channel, keyed by its request id.
    const headings = entries(readFileSync(inboxPath(), 'utf8'));
    expect(headings).toHaveLength(1);
    expect(headings[0]).toMatch(/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} ET \(Operator, slack\) PRIORITY P0 \[leader-network:[a-f0-9]{64}\]$/);
    const requestId = requestIdOf(headings[0]!);
    expect(requestId).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(inboxPath(), 'utf8')).toContain('Phantom status');

    // One answer back on Slack, to the source channel and thread root, and the
    // durable ack record names the same request id as answered.
    await vi.waitFor(() => expect(posts(call)).toHaveLength(1), { timeout: WAIT_MS });
    expect(posts(call)[0]?.[1]).toMatchObject({ channel: 'D0FAKELEADER', thread_ts: '1793920000.000001' });
    expect(String(posts(call)[0]?.[1]?.text)).toContain('Phantom status');
    expect(readFileSync(outboxPath(), 'utf8')).toContain(`[leader-network:reply-${requestId}]`);
    const state = JSON.parse(readFileSync(join(options.runsDir, 'leader', 'network-state.json'), 'utf8')) as { routes: Record<string, { reply?: { delivered: boolean } }> };
    expect(state.routes[requestId!]?.reply?.delivered).toBe(true);

    // A Socket Mode redelivery of the identical event writes no second inbox
    // entry and triggers no second answer.
    await receive(call, slackEvent('Phantom status'));
    expect(entries(readFileSync(inboxPath(), 'utf8'))).toHaveLength(1);
    expect(posts(call)).toHaveLength(1);

    // A team peer who is not the verified owner, and a sender outside the team
    // allowlist entirely, each leave the Leader inbox untouched (#3483 rule:
    // verified [mason] ids only).
    await receive(call, slackEvent('Phantom status', 'U0FAKEPEER', 'Ev-peer'));
    await receive(call, slackEvent('Phantom status', 'U0INTRUDER', 'Ev-intruder'));
    expect(entries(readFileSync(inboxPath(), 'utf8'))).toHaveLength(1);
    expect(posts(call)).toHaveLength(1);
  });

  it.runIf(process.platform === 'darwin')('writes the production sole-writer heading [request-sha256] [leader-network] exactly once', async () => {
    const copy = join(root, 'private-mason-inbox-append');
    copyFileSync(fileURLToPath(new URL('../contrib/mac/mason-inbox-append', import.meta.url)), copy);
    const scrub = join(root, 'approved-scrubber.pl');
    copyFileSync(fileURLToPath(new URL('./fixtures/leader-inbox/approved-scrubber.pl', import.meta.url)), scrub);
    const leader = join(options.runsDir, 'leader');
    mkdirSync(leader, { recursive: true, mode: 0o700 });
    const inbox = join(leader, 'MASON-INBOX.md');
    writeFileSync(inbox, '', { mode: 0o444 });
    const receipts: string[] = [];
    const appendInbox: LeaderInboxAppender = async request => {
      const stdout = execFileSync('/usr/bin/python3', [copy, '--src', 'slack', '--id', request.requestId, '--received-at', String(request.receivedAt)],
        { input: request.text, encoding: 'utf8', timeout: 25_000, maxBuffer: 1024,
          env: { PATH: '/usr/bin:/bin', MASON_INBOX_TEST: '1', MASON_INBOX_PATH: inbox, MASON_INBOX_SCRUB: scrub } });
      const receipt = JSON.parse(stdout) as { status: string };
      receipts.push(receipt.status);
      return receipt;
    };
    try {
      const call = fakeCall();
      await receive(call, slackEvent('Phantom status'), appendInbox);
      await vi.waitFor(() => expect(posts(call)).toHaveLength(1), { timeout: WAIT_MS });

      // The exact heading shape MASON-INBOX.md carries on the installed host.
      const headings = entries(readFileSync(inbox, 'utf8'));
      expect(headings).toHaveLength(1);
      expect(headings[0]).toMatch(/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} ET \(Operator, slack\) PRIORITY P0 \[request-sha256:[a-f0-9]{64}\] \[leader-network:[a-f0-9]{64}\]$/);
      const requestId = requestIdOf(headings[0]!);
      expect(receipts).toEqual(['appended']);

      // Redelivery is deduped by the Leader network before the sole writer is
      // invoked again, and no second answer is posted.
      await receive(call, slackEvent('Phantom status'), appendInbox);
      expect(entries(readFileSync(inbox, 'utf8'))).toHaveLength(1);
      expect(receipts).toEqual(['appended']);
      expect(posts(call)).toHaveLength(1);
      expect(readFileSync(outboxPath(), 'utf8')).toContain(`[leader-network:reply-${requestId}]`);
    } finally {
      chmodSync(inbox, 0o600); // fixture cleanup only; the installed inbox is never touched.
    }
  });
});
