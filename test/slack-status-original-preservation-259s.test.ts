/**
 * RQ-PHX-SLACKSTATUSORIGINAL259S: executable preservation evidence for original
 * PR #4280 (RQ-PHX-SLACKSTATUSREPLY09, pinned source
 * f886dd8f0288871923276ff7c10102725d5063dd). The original
 * leader-status-reply.ts module and its flush-time status composition are gone;
 * their descendants are owner-status-reply.ts, leader/status-digest*.ts,
 * comms/leader-status-snapshot.ts and the slack-leader.ts statusReply seam.
 *
 * What is still uncovered elsewhere and proven here through real exports:
 *  - a pure status ask that is pending with no reply text gets one
 *    model-independent same-thread answer from the queued Leader pass
 *    (tickLeaderNetwork -> generateLeaderReply's snapshot fallback -> the
 *    journaled Slack transport), and is not answered twice;
 *  - missing state posts "unknown", never a fabricated 0;
 *  - an ordinary ask waits for the model, and a delivered model reply is never
 *    overwritten by a different text (the network's reply fingerprint refusal);
 *  - "update pending" is still gated on both versions being known AND the
 *    published one being newer, through the real gather->build->compose chain.
 *
 * Fake filesystem state, fake Slack transport, no credentials, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlackLeaderAdapter, readSlackDeliveryPolicy } from '../src/core/agents/slack-leader.js';
import { createLeaderNetwork } from '../src/core/agents/leader-network.js';
import { generateLeaderReply, tickLeaderNetwork, type LeaderReplySeatModule } from '../src/core/agents/leader-network-runtime.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { composeOwnerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { buildStatusDigest } from '../src/core/leader/status-digest.js';
import { gatherStatusDigestInput, type StatusDigestSources } from '../src/core/leader/status-digest-sources.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

vi.setConfig({ testTimeout: 30_000 });
const WAIT_MS = 15_000;
const NOW = Date.parse('2026-11-06T02:00:00Z');
const OWNER = 'U0FAKEOWNER', CHANNEL = 'D0FAKELEADER', TEAM = 'T0FAKETEAM', THREAD = '1793920000.000001';
const configText = `[mason]\nidentities=[{channel="slack",id="${OWNER}"}]\n[team]\nidentities=[{channel="slack",id="${OWNER}"},{channel="slack",id="U0FAKEPEER"}]\n[slack]\nbridge_id="slack"\nteam_id="${TEAM}"\nown_user_id="U0FAKEBOT"\nown_bot_id="B0FAKEBOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="${CHANNEL}"\n`;

let root: string;
let options: { configDir: string; runsDir: string; busRoot: string; now: () => number };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slack-status-259s-'));
  options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => NOW };
  mkdirSync(options.configDir, { mode: 0o700 });
  writeFileSync(join(options.configDir, 'agent-network.toml'), configText, { mode: 0o600 });
  writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fakeCall(): SlackCall {
  return vi.fn(async (method, body = {}) => {
    if (method === 'auth.test') return { team_id: TEAM, user_id: 'U0FAKEBOT', bot_id: 'B0FAKEBOT' };
    if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
    if (method === 'conversations.info') return { channel: { id: body.channel, is_im: true, context_team_id: TEAM } };
    if (method === 'conversations.members') return { members: ['U0FAKEBOT', OWNER], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: body.user, team_id: TEAM, is_bot: body.user === 'U0FAKEBOT' } };
    if (method === 'chat.postMessage') return { channel: body.channel, ts: '1793920002.000001' };
    if (method === 'conversations.replies' || method === 'conversations.history') return { messages: [] };
    throw new Error('unexpected-synthetic-method');
  });
}
const posts = (call: SlackCall) => vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage');

/** Ingests through the real authenticated socket mapper with NO statusReply
 * seam, so the ask stays pending exactly like the original flush scenario. */
async function receive(call: SlackCall, text: string) {
  const policy = readSlackDeliveryPolicy(options)!;
  const adapter = createSlackLeaderAdapter({ ...options, call });
  let routed: { owned: boolean; durable: boolean } | undefined;
  const handlers: Record<string, (event: { data?: unknown }) => void> = {};
  const socket = { readyState: 1, addEventListener: (type: string, cb: (event: { data?: unknown }) => void) => { handlers[type] = cb; }, send: vi.fn(), close: vi.fn() };
  await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: options.runsDir, busRoot: options.busRoot },
    leaderAdapter: { ...adapter, route: async envelope => { const result = await adapter.route(envelope); routed = result; return result; } }, connect: () => socket });
  handlers.message!({ data: JSON.stringify({ type: 'events_api', envelope_id: 'Ev-delivery', payload: { team_id: TEAM, event_id: 'Ev-ask', event: {
    type: 'message', user: OWNER, channel: CHANNEL, ts: '1793920001.000001', thread_ts: THREAD, text } } }) });
  await vi.waitFor(() => expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ envelope_id: 'Ev-delivery' })), { timeout: WAIT_MS });
  return routed!;
}

/** Real generateLeaderReply with a seat plan that finds no seat: the answer is
 * composed only from local state — the model-independent path. */
const noSeat = { calls: 0,
  loadDefaultLeaderSeatDeps: async () => ({}),
  planLeaderSeats: async () => { noSeat.calls++; return { ok: false as const, reason: 'synthetic no seat' }; },
} as unknown as LeaderReplySeatModule & { calls: number };
const cfg = {} as AshlrConfig;
const tickWithGenerator = (call: SlackCall) => tickLeaderNetwork(cfg, { ...options, slackCall: call },
  { reply: input => generateLeaderReply(input, cfg, options, { seat: noSeat }) });

const pad = (n: number) => String(n).padStart(2, '0');
/** 'YYYY-MM-DD HH:MM:SS' in this machine's local time, the format the guardian reader parses. */
const localStamp = (ms: number): string => { const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };

/** The original fixture facts, in the files the snapshot readers really read. */
function writeStatusFixture(runsDir: string): void {
  for (const dir of ['queue', 'supervisor', 'leader']) mkdirSync(join(runsDir, dir), { recursive: true });
  writeFileSync(join(runsDir, 'queue', 'status.json'), JSON.stringify({ last_tick: new Date(NOW - 30_000).toISOString(),
    rollup_24h: { by_lane: { claude: { merged: 9, median_ttm_s: 1500 }, 'codex-personal': { merged: 3, median_ttm_s: 2400 }, devin: { merged: 0 } } } }));
  writeFileSync(join(runsDir, 'supervisor', 'status-main-guardian.md'), [
    `# Main guardian status (${localStamp(NOW - 60_000)})`, '',
    '| repo | branch | sha | state | checked | failing | fixes | nightly |', '|---|---|---|---|---|---|---|---|',
    `| phantom | master | abcdef1 | green | ${localStamp(NOW - 60_000)} | | | |`,
    `| locus | main | abcdef2 | green | ${localStamp(NOW - 60_000)} | | | |`,
    `| lexicon | main | abcdef3 | red | ${localStamp(NOW - 60_000)} | ci | FIXUP-1 | |`].join('\n'));
  writeFileSync(join(runsDir, 'leader', 'PLAN-LOG.md'), `## ${localStamp(NOW - 300_000).slice(0, 16)}\n**CEO summary**\n- Release train is steady.\n`);
}

describe('a pending pure status ask is answered once from local state (original flush scenario)', () => {
  it('posts the snapshot reply in the same thread with no model, then never again', async () => {
    const call = fakeCall();
    expect(await receive(call, 'Phantom status')).toMatchObject({ owned: true, durable: true });
    writeStatusFixture(options.runsDir);
    expect(await tickWithGenerator(call)).toMatchObject({ status: 'completed', replies: 1 });
    expect(noSeat.calls).toBe(1); // the real generator ran; no seat means no model call exists to make
    expect(posts(call)).toHaveLength(1);
    const posted = posts(call)[0]![1] as { channel: string; thread_ts: string; text: string };
    expect(posted).toMatchObject({ channel: CHANNEL, thread_ts: THREAD });
    expect(posted.text).toContain('Leader: Merged PRs in the last 24h: 12');
    expect(posted.text).toContain('By lane: claude 9 (median 25 min), codex-personal 3 (median 40 min)');
    expect(posted.text).toContain('Mains green: 2 of 3. Red: lexicon.');
    expect(posted.text).not.toContain('stale');
    expect(posted.text).toContain('CEO summary: Release train is steady.');
    // Bounded plain text like the original <=8-line readable reply.
    expect(posted.text.split('\n').length).toBeLessThanOrEqual(8);
    expect(posted.text.length).toBeLessThanOrEqual(1500);
    expect(posted.text).not.toContain('|');
    expect(posted.text).not.toContain('\u001b');
    // Once: the delivered route is no longer pending and nothing re-posts.
    expect(await tickWithGenerator(call)).toMatchObject({ replies: 0 });
    expect(posts(call)).toHaveLength(1);
  });

  it('posts unknown, never a fabricated zero, when the sources are missing', async () => {
    const call = fakeCall();
    expect(await receive(call, 'status?')).toMatchObject({ owned: true, durable: true });
    expect(await tickWithGenerator(call)).toMatchObject({ replies: 1 });
    expect(posts(call)).toHaveLength(1);
    const text = String(posts(call)[0]![1]!.text);
    expect(text).toContain('Merged PRs in the last 24h: unknown');
    expect(text).toContain('Mains: unknown');
    expect(text).not.toMatch(/\b0\b|up to date|update pending|none waiting/);
  });

  it('leaves an ordinary ask for the model and posts its reply verbatim once', async () => {
    const call = fakeCall();
    expect(await receive(call, 'please review PR 4245')).toMatchObject({ owned: true, durable: true });
    // Not status-shaped: no model-independent fallback exists, so nothing posts.
    expect(await tickWithGenerator(call)).toMatchObject({ replies: 0 });
    expect(posts(call)).toHaveLength(0);
    // The model pass supplies text; it is delivered verbatim in the same thread.
    expect(await tickLeaderNetwork(cfg, { ...options, slackCall: call }, { reply: async () => 'Model wrote this.' })).toMatchObject({ replies: 1 });
    expect(posts(call)).toHaveLength(1);
    expect(posts(call)[0]![1]).toMatchObject({ channel: CHANNEL, thread_ts: THREAD, text: 'Leader: Model wrote this.' });
    // A later pass cannot replace the delivered reply.
    expect(await tickLeaderNetwork(cfg, { ...options, slackCall: call }, { reply: async () => 'A different status text' })).toMatchObject({ replies: 0 });
    expect(posts(call)).toHaveLength(1);
  });
});

describe('an already-written model reply is not overwritten by a status answer', () => {
  it('refuses a different second reply for the same request', async () => {
    const sent: BusEnvelope[] = [];
    const network = createLeaderNetwork({ configSource: configText, commsSource: 'confirmedByMason=true\n',
      runsDir: options.runsDir, busRoot: options.busRoot, now: options.now,
      deliver: async (_identity, envelope) => { sent.push(envelope); return { status: 'sent' as const, reason: 'synthetic delivery' }; } });
    const ingest = await network.ingest({ message: { id: 'slack-evt-259s', from: 'mason', to: 'leader', priority: 'P0', ttl: 60_000,
      channel: 'slack', channel_ref: `slack:${TEAM}:${CHANNEL}:${THREAD}`, external: false,
      sender: { agent_id: 'mason', vendor: 'phantom', human: true, team: true }, body: { text: 'Phantom status' } },
      verifiedSender: { channel: 'slack', id: OWNER }, receivedAt: NOW });
    expect(ingest.status).toBe('accepted');
    const requestId = ingest.requestId!;
    // The model's reply lands first, exactly like the original disconnect case.
    expect((await network.reply(requestId, 'Model wrote this.')).status).toBe('sent');
    expect(sent).toHaveLength(1);
    expect((sent[0]!.body as { text: string }).text).toBe('Leader: Model wrote this.');
    // The status answer composed for the same request cannot displace it.
    const overwrite = await network.reply(requestId, 'Merged PRs in the last 24h: 12.');
    expect(overwrite.status).toBe('refused');
    expect(String(overwrite.reason)).toContain('different reply already owns');
    expect(sent).toHaveLength(1);
  });
});

describe('the update-pending gate through the real gather -> build -> compose chain', () => {
  const base: Partial<StatusDigestSources> = {
    mergeFacts: async () => ({ shipped: [], mergeCountUnavailable: false }),
    runsState: async () => ({ runsDirPresent: true, sources: { status: 'healthy' } as never, lanes: [] }),
    needs: () => ({ status: 'missing', items: [] }),
    inbox: async () => ({ sourceState: 'healthy', entries: [] }),
  };
  const appLine = async (installed: string | null, published: string | null) => {
    const brief = async (runsDir: string, at: Date) => ['Morning leader brief', ...buildStatusDigest(await gatherStatusDigestInput(runsDir, at, {
      ...base,
      installedVersion: () => installed,
      publishedVersion: async () => { if (published === null) throw new Error('synthetic release read failure'); return published; },
    }))].join('\n');
    return (await composeOwnerStatusReply('/fake-runs-259s', new Date(NOW), { brief })).split('\n')[1]!;
  };

  it('shows update pending only when both versions are known and the published one is newer', async () => {
    expect(await appLine('3.29.15', '3.30.32')).toBe('App: installed 3.29.15 · published 3.30.32 · update pending');
    // Equal never reads as pending — and an installed build already ahead is
    // "up to date" (the original's `installed !== latest` was refined to a
    // strictly-newer published release).
    expect(await appLine('3.30.32', '3.30.32')).toBe('App: installed 3.30.32 · published 3.30.32 · up to date');
    expect(await appLine('3.31.0', '3.30.32')).toBe('App: installed 3.31.0 · published 3.30.32 · up to date');
    // Missing data stays unknown with no verdict at all — never pending, never 0.
    expect(await appLine(null, '3.30.32')).toBe('App: installed unknown (installed app version not readable) · published 3.30.32');
    expect(await appLine('3.29.15', null)).toBe('App: installed 3.29.15 · published unknown (published release not readable)');
  });
});
