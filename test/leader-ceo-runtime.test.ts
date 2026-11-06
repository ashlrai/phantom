import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { composeLeaderInbox, defaultLeaderDelivery, hasPendingLeaderNetwork, readLeaderInbox, receiptLeaderChannel, tickLeaderNetwork } from '../src/core/agents/leader-network-runtime.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { buildPlannerBrief } from '../src/core/fleet/planner-brief.js';

let root: string;
let options: { runsDir: string; configDir: string; busRoot: string; now: () => number };
const config = '[mason]\nidentities = [{channel="bus",id="local-owner"},{channel="telegram",id="telegram:123456789"}]\n[team]\nidentities = [{channel="bus",id="leader"},{channel="bus",id="local-owner"},{channel="telegram",id="telegram:123456789"}]';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'leader-ceo-runtime-'));
  options = { runsDir: join(root, 'runs'), configDir: join(root, 'config'), busRoot: join(root, 'bus'), now: () => Date.parse('2026-11-01T12:00:00Z') };
  mkdirSync(options.configDir, { mode: 0o700 });
  writeFileSync(join(options.configDir, 'agent-network.toml'), config, { mode: 0o600 });
  writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason = true', { mode: 0o600 });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('CEO runtime integration', () => {
  it('composes into durable inbox, bus, same-channel reply and read projection', async () => {
    const receipt = await composeLeaderInbox('Synthetic build request', options);
    expect(receipt.ok).toBe(true);
    expect(await hasPendingLeaderNetwork(options)).toBe(true);
    const reply = vi.fn(async () => 'Synthetic work is queued.');
    const first = await tickLeaderNetwork({} as AshlrConfig, options, { reply });
    expect(first).toMatchObject({ status: 'completed', replies: 1, away: false });
    expect(await hasPendingLeaderNetwork(options)).toBe(false);
    expect(await tickLeaderNetwork({} as AshlrConfig, options, { reply })).toMatchObject({ replies: 0 });
    expect(reply).toHaveBeenCalledTimes(1);
    const view = await readLeaderInbox(options);
    expect(view.inbox.entries[0]?.text).toBe('Synthetic build request');
    expect(view.outbox.entries[0]?.text).toBe('Leader: Synthetic work is queued.');
    expect(listBusInboxAfter(0, 100, { root: options.busRoot, now: options.now })).toMatchObject({ status: 'ok', messages: [
      { envelope: { to: 'leader', priority: 'P0' } }, { envelope: { from: 'leader', channel: 'bus' } },
    ] });
    const brief = await buildPlannerBrief({ runsRoot: options.runsDir, git: (_program, _args, _options, done) => done(null, '') });
    expect(brief.text).toContain('Synthetic build request');
    expect(brief.text).not.toContain('without a timestamped heading omitted');
  }, 20_000);
  it('does not mutate inbox when team send policy or confirmation refuses compose', async () => {
    writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason = false', { mode: 0o600 });
    expect(await composeLeaderInbox('Synthetic request', options)).toMatchObject({ ok: false, status: 'drafted' });
    expect((await readLeaderInbox(options)).inbox.sourceState).toBe('missing');
    writeFileSync(join(options.configDir, 'agent-network.toml'), '[mason]\nidentities=[]', { mode: 0o600 });
    expect(await composeLeaderInbox('Synthetic request', options)).toMatchObject({ ok: false, status: 'refused' });
  });
  it('acknowledges a durable inbox write when its bus mirror needs recovery', async () => {
    writeFileSync(options.busRoot, 'Synthetic unavailable bus', { mode: 0o600 });
    expect(await composeLeaderInbox('Synthetic recoverable request', options)).toMatchObject({ ok: true, mirror: 'pending' });
    expect((await readLeaderInbox(options)).inbox.entries).toHaveLength(1);
    rmSync(options.busRoot);
    const reply = vi.fn(async () => 'Synthetic recovered reply');
    expect(await tickLeaderNetwork({} as AshlrConfig, options, { reply })).toMatchObject({ replies: 1 });
    expect((await readLeaderInbox(options)).inbox.entries).toHaveLength(1);
    expect(reply).toHaveBeenCalledTimes(1);
  }, 20_000);
  it('bridges trusted channel receipts without duplicating the existing inbox and keeps iMessage local', async () => {
    mkdirSync(join(options.runsDir, 'leader'), { recursive: true, mode: 0o700 });
    writeFileSync(join(options.runsDir, 'leader/MASON-INBOX.md'), 'Original synthetic durable record\n', { mode: 0o600 });
    const message = { channel: 'telegram' as const, verifiedSenderId: 'telegram:123456789', threadId: '123', body: 'Synthetic channel request', receivedAt: new Date(options.now()).toISOString(), dedupeKey: 'a'.repeat(64) };
    expect(await receiptLeaderChannel(message, options)).toBe('published');
    expect(readFileSync(join(options.runsDir, 'leader/MASON-INBOX.md'), 'utf8')).toBe('Original synthetic durable record\n');
    expect(await receiptLeaderChannel({ ...message, channel: 'imessage' }, options)).toBe('ignored');
    expect(await receiptLeaderChannel({ ...message, verifiedSenderId: 'synthetic-outsider' }, options)).toBe('ignored');
  }, 20_000);
  it('reuses saved replies after a refused delivery and serializes overlapping ticks', async () => {
    await composeLeaderInbox('Synthetic request', options);
    const reply = vi.fn(async () => 'Synthetic response');
    const deliver = vi.fn(async () => ({ status: 'drafted' as const, reason: 'Synthetic disabled channel' }));
    await tickLeaderNetwork({} as AshlrConfig, options, { reply, deliver });
    expect(await tickLeaderNetwork({} as AshlrConfig, options, { reply, deliver: async () => ({ status: 'sent', reason: 'Synthetic accepted' }) })).toMatchObject({ replies: 1 });
    expect(reply).toHaveBeenCalledTimes(1);
    await composeLeaderInbox('Another synthetic request', options);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const first = tickLeaderNetwork({} as AshlrConfig, options, { reply: async () => { entered(); await barrier; return 'Synthetic reply'; } });
    await started;
    expect(await tickLeaderNetwork({} as AshlrConfig, options, { reply })).toMatchObject({ status: 'busy' });
    release(); await first;
  }, 20_000);
  it('uses only the latest CEO plan in projection and daily digest', async () => {
    mkdirSync(join(options.runsDir, 'leader'), { recursive: true, mode: 0o700 });
    writeFileSync(join(options.runsDir, 'leader/PLAN-LOG.md'), '## Older pass\n**CEO summary**\n- Obsolete synthetic plan\n## Current pass\n**CEO summary**\n- Current synthetic plan\n', { mode: 0o600 });
    expect((await readLeaderInbox(options)).ceo).toEqual(['Current synthetic plan']);
    await tickLeaderNetwork({} as AshlrConfig, options);
    const result = await tickLeaderNetwork({} as AshlrConfig, { ...options, now: () => options.now() + 72 * 3600000 }, { deliver: async () => ({ status: 'sent', reason: 'Synthetic accepted' }) });
    expect(result).toMatchObject({ away: true, sent: 2 });
    expect((await readLeaderInbox(options)).outbox.entries.every(entry => entry.text === 'Leader: Current synthetic plan')).toBe(true);
  }, 20_000);
  it('does not call transports for unqualified configured channel targets', async () => {
    const message: BusEnvelope = { id: 'synthetic-reply', from: 'leader', to: 'mason', priority: 'P0', ttl: 1000, body: { text: 'Leader: synthetic reply' } };
    const deliver = defaultLeaderDelivery({} as AshlrConfig, options);
    expect(await deliver({ channel: 'telegram', id: 'telegram:999' }, message)).toMatchObject({ status: 'refused' });
    expect(await deliver({ channel: 'email', id: 'email:synthetic@example.invalid' }, message)).toMatchObject({ status: 'refused' });
    expect(await deliver({ channel: 'slack', id: 'synthetic-owner' }, message)).toMatchObject({ status: 'refused' });
  });
  it('honors communication revocation during reply generation and retries the saved reply', async () => {
    await composeLeaderInbox('Synthetic request', options);
    const reply = vi.fn(async () => {
      writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason = false', { mode: 0o600 });
      return 'Synthetic completed response';
    });
    expect(await tickLeaderNetwork({} as AshlrConfig, options, { reply })).toMatchObject({ replies: 0 });
    writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason = true', { mode: 0o600 });
    expect(await tickLeaderNetwork({} as AshlrConfig, options, { reply })).toMatchObject({ replies: 1 });
    expect(reply).toHaveBeenCalledTimes(1);
  }, 20_000);
  it('rotates past unavailable requests instead of starving later work', async () => {
    for (let index = 0; index < 6; index++) await composeLeaderInbox(`Synthetic request ${index}`, options);
    const reply = vi.fn(async (text: string) => text.endsWith('5') ? 'Synthetic ready response' : null);
    await tickLeaderNetwork({} as AshlrConfig, options, { reply });
    expect(reply.mock.calls.map(call => call[0])).not.toContain('Synthetic request 5');
    const result = await tickLeaderNetwork({} as AshlrConfig, options, { reply });
    expect(result).toMatchObject({ replies: 1 });
    expect(reply.mock.calls.map(call => call[0])).toContain('Synthetic request 5');
  }, 30_000);
});
