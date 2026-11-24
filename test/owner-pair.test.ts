/** RQ-PAIRIMSGN22YQ8: `phm owner pair imessage`. Temp config dir and a fake bridge: nothing real is sent or read. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdOwnerPair } from '../src/cli/owner-pair.js';
import { cmdFleetOwnerLive } from '../src/cli/fleet-owner-live.js';
import { parseCommsConfirmation } from '../src/core/agents/channel-policy.js';
import { ensureOwnerAdaptersFile } from '../src/core/comms/owner-adapters-file.js';
import { loadOwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { readOwnerLiveStatus } from '../src/core/comms/owner-live-status.js';
import {
  PAIR_TEXT, PAIR_TTL_MS, checkOwnerPair, pairTick, readOwnerPairStatus, startOwnerPair, unpairOwner,
  type PairBridge, type PairDeps, type PairInbound,
} from '../src/core/comms/owner-pair.js';

// The first YES loads the owner-gated confirm route (the web layer) on demand; a cold transform is slow.
vi.setConfig({ testTimeout: 30_000 });

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });

const NETWORK = '[mason]\nidentities = [{ channel = "telegram", id = "telegram:keep" }]\n\n[team]\nidentities = [\n  { channel = "telegram", id = "telegram:keep" },\n]\n';

function setup(opts: { handles?: string[]; network?: string | null; comms?: string | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'owner-pair-'));
  roots.push(dir);
  ensureOwnerAdaptersFile(dir);
  if (opts.network !== null) writeFileSync(join(dir, 'agent-network.toml'), opts.network ?? NETWORK);
  if (opts.comms !== null) writeFileSync(join(dir, 'comms.toml'), opts.comms ?? 'confirmedByMason = false\n');
  const sent: { handle: string; text: string }[] = [];
  let inbound: PairInbound[] = [];
  let readable = true;
  const bridge: PairBridge = {
    async ownHandles() { return opts.handles ?? ['mason-test']; },
    async baseline() { return 10; },
    async send(handle, text) { sent.push({ handle, text }); return true; },
    async replies(after, handles) { return readable ? inbound.filter(m => m.rowid > after && handles.some(h => h.toLowerCase() === m.handle.toLowerCase())) : null; },
  };
  let t = Date.UTC(2026, 10, 21, 14, 0);
  const deps: PairDeps = { configDir: dir, bridge, now: () => t };
  return {
    dir, deps, sent,
    reply: (text: string, handle = 'mason-test', fromMe = false) => { inbound = [...inbound, { rowid: 11 + inbound.length, text, handle, fromMe }]; },
    advance: (ms: number) => { t += ms; },
    unreadable: () => { readable = false; },
    file: (name: string) => readFileSync(join(dir, name), 'utf8'),
  };
}

describe('start', () => {
  it('one detected handle: exactly one pairing text and a pending record', async () => {
    const s = setup();
    const r = await startOwnerPair(s.deps);
    expect(r.status).toBe('pending');
    expect(s.sent).toEqual([{ handle: 'mason-test', text: PAIR_TEXT }]);
    expect(PAIR_TEXT).toBe('Phantom: reply YES to get fleet updates here.');
    expect(readOwnerPairStatus(s.dir).state).toBe('waiting');
    // Asking again while pending sends nothing more.
    expect((await startOwnerPair(s.deps)).status).toBe('already-pending');
    expect(s.sent).toHaveLength(1);
  });

  it('none found sends nothing', async () => {
    const none = setup({ handles: [] });
    expect((await startOwnerPair(none.deps)).status).toBe('none-found');
    expect(none.sent).toHaveLength(0);
  });

  it('--handle overrides detection', async () => {
    const s = setup({ handles: ['mason-test', 'other-test'] });
    expect((await startOwnerPair(s.deps, { handle: 'pick-me' })).status).toBe('pending');
    expect(s.sent[0]!.handle).toBe('pick-me');
    expect((await startOwnerPair(setup().deps, { handle: 'bad handle' })).status).toBe('bad-handle');
  });
});

describe('YES', () => {
  it('YES from the pending handle binds [mason] and [team]; an already-confirmed comms.toml reads confirmed', async () => {
    const s = setup({ comms: 'confirmedByMason = true\n' });
    await startOwnerPair(s.deps);
    s.reply('  yes \n');
    expect(await checkOwnerPair(s.deps)).toEqual({ status: 'bound', confirmed: true });
    const settings = loadOwnerThreadSettings(s.dir);
    expect(settings.owners.imessage).toBe('mason-test');
    expect(settings.owners.telegram).toBe('telegram:keep');
    expect(settings.team.map(t => `${t.channel}:${t.id}`).sort()).toEqual(['imessage:mason-test', 'telegram:telegram:keep']);
    expect(settings.confirmed).toBe(true);
    expect(readOwnerPairStatus(s.dir)).toMatchObject({ state: 'paired', line: 'paired (**st)', confirmed: true });
    const live = readOwnerLiveStatus(settings, { halted: false, paused: false });
    expect(live.channels.find(c => c.channel === 'imessage')!.state).toBe('on');
  });

  it('creates agent-network.toml when it is missing', async () => {
    const s = setup({ network: null });
    await startOwnerPair(s.deps);
    s.reply('YES');
    expect((await checkOwnerPair(s.deps)).status).toBe('bound');
    expect(loadOwnerThreadSettings(s.dir).owners.imessage).toBe('mason-test');
  });

  it('NO, other words, or a different handle bind nothing', async () => {
    const s = setup();
    await startOwnerPair(s.deps);
    const before = s.file('agent-network.toml');
    s.reply('NO');
    s.reply('yes please');
    s.reply('YES', 'other-test');
    expect((await checkOwnerPair(s.deps)).status).toBe('waiting');
    expect(s.file('agent-network.toml')).toBe(before);
    expect(s.file('comms.toml')).toBe('confirmedByMason = false\n');
    expect(readOwnerPairStatus(s.dir).state).toBe('waiting');
  });

  it('an existing iMessage binding is never overwritten', async () => {
    const network = '[mason]\nidentities = [{ channel = "imessage", id = "first-one" }]\n[team]\nidentities = [{ channel = "imessage", id = "first-one" }]\n';
    const s = setup({ network });
    expect((await startOwnerPair(s.deps)).status).toBe('already-paired');
    expect((await startOwnerPair(s.deps, { handle: 'mason-test' })).status).toBe('already-paired');
    expect(s.sent).toHaveLength(0);
    expect(s.file('agent-network.toml')).toBe(network);
  });

  it('a YES that arrives after a binding appeared elsewhere leaves the file alone', async () => {
    const s = setup();
    await startOwnerPair(s.deps);
    const network = '[mason]\nidentities = [{ channel = "imessage", id = "first-one" }]\n[team]\nidentities = [{ channel = "imessage", id = "first-one" }]\n';
    writeFileSync(join(s.dir, 'agent-network.toml'), network);
    s.reply('YES');
    await checkOwnerPair(s.deps);
    expect(s.file('agent-network.toml')).toBe(network);
  });

  it('unconfirmed comms.toml: the YES is an owner proof and confirms through the route function', async () => {
    const s = setup();
    await startOwnerPair(s.deps);
    s.reply('YES');
    expect(await checkOwnerPair(s.deps)).toEqual({ status: 'bound', confirmed: true });
    expect(parseCommsConfirmation(s.file('comms.toml'))).toBe(true);
    expect(readOwnerPairStatus(s.dir)).toMatchObject({ state: 'paired', confirmed: true });
    const missing = setup({ comms: null });
    await startOwnerPair(missing.deps);
    missing.reply('YES');
    expect(await checkOwnerPair(missing.deps)).toMatchObject({ status: 'bound', confirmed: false, reason: expect.stringContaining('missing') });
    expect(() => missing.file('comms.toml')).toThrow();
  });

  it('an unreadable Messages keeps the pair waiting', async () => {
    const s = setup();
    await startOwnerPair(s.deps);
    s.unreadable();
    expect((await checkOwnerPair(s.deps)).status).toBe('unreadable');
    expect(readOwnerPairStatus(s.dir).state).toBe('waiting');
  });
});

describe('self-tick', () => {
  it('starts once, waits, restarts at most once per 24 h after expiry', async () => {
    const s = setup();
    expect((await pairTick(s.deps)).action).toBe('started');
    s.advance(60 * 60 * 1000);
    expect((await pairTick(s.deps)).action).toBe('waiting');
    expect(s.sent).toHaveLength(1);
    s.advance(PAIR_TTL_MS);                       // expired
    expect((await pairTick(s.deps)).action).toBe('started');
    expect(s.sent).toHaveLength(2);
    s.advance(60 * 1000);
    expect((await pairTick(s.deps)).action).toBe('waiting');
    expect(s.sent).toHaveLength(2);
  });

  it('a failed send is not recorded as a start', async () => {
    const s = setup();
    s.deps.bridge.send = async () => false;
    expect((await pairTick(s.deps)).detail).toBe('send-failed');
    expect(readOwnerPairStatus(s.dir).state).toBe('not-paired');
  });

  it('binds on the YES and does nothing once paired', async () => {
    const s = setup();
    await pairTick(s.deps);
    s.reply('Yes');
    expect((await pairTick(s.deps)).action).toBe('bound');
    expect((await pairTick(s.deps)).action).toBe('none');
    expect(s.sent).toHaveLength(1);
  });

  it('after unpair it does not pair again by itself', async () => {
    const s = setup();
    await pairTick(s.deps);
    s.reply('YES');
    await pairTick(s.deps);
    expect(unpairOwner(s.dir).status).toBe('unpaired');
    s.advance(3 * PAIR_TTL_MS);
    expect((await pairTick(s.deps)).detail).toBe('too-soon');
    expect(s.sent).toHaveLength(1);
    // Mason can pair again by hand.
    expect((await startOwnerPair(s.deps)).status).toBe('pending');
  });

  it('apply mode through fleet owner-live starts the pair; the status line says waiting', async () => {
    const s = setup();
    const out: string[] = [];
    const options = { runsDir: s.dir, settings: loadOwnerThreadSettings(s.dir), now: s.deps.now, halted: false, paused: false };
    const code = await cmdFleetOwnerLive(['--apply', '--json', '--runs-dir', s.dir], { options, pair: s.deps, output: t => out.push(t), error: t => out.push(t) });
    expect(code).toBe(0);
    expect(s.sent).toHaveLength(1);
    expect(JSON.parse(out[0]!).pair.action).toBe('started');
    // Plan-only mode never starts a pair.
    const s2 = setup();
    await cmdFleetOwnerLive(['--json', '--runs-dir', s2.dir], { options: { ...options, runsDir: s2.dir, settings: loadOwnerThreadSettings(s2.dir) }, pair: s2.deps, output: () => {} });
    expect(s2.sent).toHaveLength(0);

    const status = readOwnerLiveStatus(loadOwnerThreadSettings(s.dir), { halted: false, paused: false }, readOwnerPairStatus(s.dir));
    expect(status.line).toBe('Phone updates: waiting for your YES (sent to 1)');
    expect(status.pair?.state).toBe('waiting');
  });
});

describe('unpair and status', () => {
  it('removes only the iMessage key', async () => {
    const s = setup({ comms: 'confirmedByMason = true\n' });
    await startOwnerPair(s.deps);
    s.reply('YES');
    await checkOwnerPair(s.deps);
    expect(unpairOwner(s.dir).status).toBe('unpaired');
    const settings = loadOwnerThreadSettings(s.dir);
    expect(settings.owners.imessage).toBeUndefined();
    expect(settings.owners.telegram).toBe('telegram:keep');
    expect(settings.team).toEqual([{ channel: 'telegram', id: 'telegram:keep' }]);
    expect(parseCommsConfirmation(s.file('comms.toml'))).toBe(true);
    expect(readOwnerPairStatus(s.dir).line).toBe('not paired');
    expect(unpairOwner(s.dir).status).toBe('not-paired');
  });

  it('status lines use the plain wording', async () => {
    const s = setup();
    expect(readOwnerPairStatus(s.dir).line).toBe('not paired');
    await startOwnerPair(s.deps);
    expect(readOwnerPairStatus(s.dir).line).toBe('waiting for YES (sent to 1)');
    s.reply('YES');
    await checkOwnerPair(s.deps);
    expect(readOwnerPairStatus(s.dir).line).toBe('paired (**st)');
  });
});

describe('cli', () => {
  it('pair, status, several handles and unpair print plain words', async () => {
    const s = setup();
    const out: string[] = [];
    const run = (args: string[]) => cmdOwnerPair(args, { pair: s.deps, output: t => out.push(t), error: t => out.push(t) });
    expect(await run(['pair', 'status'])).toBe(0);
    expect(await run(['pair', 'imessage'])).toBe(0);
    expect(await run(['pair', 'status'])).toBe(0);
    s.reply('YES');
    expect(await run(['pair', 'imessage'])).toBe(0);       // finishes the pairing
    expect(await run(['pair', 'status', '--json'])).toBe(0);
    expect(out[0]).toBe('not paired');
    expect(out[1]).toContain('Reply YES');
    expect(out[1]).not.toContain('mason-test');             // masked
    expect(out[2]).toBe('waiting for YES (sent to 1)');
    expect(out[3]).toContain('Paired.');
    expect(JSON.parse(out[4]!)).toMatchObject({ state: 'paired', line: 'paired (**st)' });
    expect(await run(['unpair', 'imessage'])).toBe(0);
    expect(await run(['bogus'])).toBe(2);

    const many = setup({ handles: ['mason-test', 'other-test'] });
    const out2: string[] = [];
    const code = await cmdOwnerPair(['pair', 'imessage'], { pair: many.deps, output: t => out2.push(t) });
    expect(code).toBe(0);
    expect(out2[0]).toContain('Sent a text to 2 handles (**st, **st)');
    expect(many.sent).toHaveLength(2);
    const none = setup({ handles: [] });
    await cmdOwnerPair(['pair', 'imessage', '--json'], { pair: none.deps, output: t => out2.push(t) });
    expect(JSON.parse(out2[1]!).status).toBe('none-found');
  });
});

describe('several own handles (RQ-PAIRMULTIN22ZQ8)', () => {
  const two = ['mason-a', 'mason-b'];

  it('2 own handles: exactly 2 planned sends and one pending record; the tick says so', async () => {
    const s = setup({ handles: two });
    const r = await pairTick(s.deps);
    expect(r).toEqual({ action: 'started', detail: 'sent to 2 handles, waiting for YES' });
    expect(s.sent).toEqual(two.map(handle => ({ handle, text: PAIR_TEXT })));
    expect(JSON.parse(s.file('comms/owner-pair.json')).pending.handles).toEqual(two);
    expect(readOwnerPairStatus(s.dir)).toMatchObject({ state: 'waiting', line: 'waiting for YES (sent to 2)', sent: 2 });
    expect(await pairTick(s.deps)).toEqual({ action: 'waiting', detail: 'sent to 2 handles, waiting for YES' });
    expect(s.sent).toHaveLength(2);
  });

  it('the first handle to say YES binds and confirms; a later YES from the other binds nothing new', async () => {
    const s = setup({ handles: two });
    await startOwnerPair(s.deps);
    s.reply('yes', 'mason-b');
    s.reply('YES', 'mason-a');
    expect(await checkOwnerPair(s.deps)).toEqual({ status: 'bound', confirmed: true });
    expect(loadOwnerThreadSettings(s.dir).owners.imessage).toBe('mason-b');
    const network = s.file('agent-network.toml');
    expect(await checkOwnerPair(s.deps)).toEqual({ status: 'none' });
    expect(s.file('agent-network.toml')).toBe(network);
    expect(readOwnerPairStatus(s.dir).line).toBe('paired (**-b)');
  });

  it('a sent-by-me YES in the self-chat after the send binds', async () => {
    const s = setup({ handles: two });
    await startOwnerPair(s.deps);
    s.reply(' Yes ', 'mason-a', true);
    expect(await checkOwnerPair(s.deps)).toMatchObject({ status: 'bound', confirmed: true });
    expect(loadOwnerThreadSettings(s.dir).owners.imessage).toBe('mason-a');
  });

  it('a sent-by-me YES older than the send, or the pairing text echoed back, binds nothing', async () => {
    const s = setup({ handles: two });
    await startOwnerPair(s.deps);
    // The fake bridge baseline is 10: row 5 is older than the send and is never returned for this pair.
    (s.deps.bridge as { replies: PairBridge['replies'] }).replies = async () => [
      { rowid: 5, text: 'YES', handle: 'mason-a', fromMe: true },
      { rowid: 11, text: PAIR_TEXT, handle: 'mason-a', fromMe: true },
      { rowid: 12, text: PAIR_TEXT, handle: 'mason-b', fromMe: false },
    ];
    expect(await checkOwnerPair(s.deps)).toEqual({ status: 'waiting' });
    expect(loadOwnerThreadSettings(s.dir).owners.imessage).toBeUndefined();
  });

  it('a non-own handle YES binds nothing', async () => {
    const s = setup({ handles: two });
    await startOwnerPair(s.deps);
    s.reply('YES', 'stranger');
    s.reply('YES', 'stranger', true);
    expect(await checkOwnerPair(s.deps)).toEqual({ status: 'waiting' });
    expect(loadOwnerThreadSettings(s.dir).owners.imessage).toBeUndefined();
  });

  it('caps at 4 handles; --handle narrows to one', async () => {
    const s = setup({ handles: ['a-1', 'b-2', 'c-3', 'd-4', 'e-5', 'f-6'] });
    await startOwnerPair(s.deps);
    expect(s.sent.map(x => x.handle)).toEqual(['a-1', 'b-2', 'c-3', 'd-4']);
    const one = setup({ handles: two });
    await startOwnerPair(one.deps, { handle: 'mason-b' });
    expect(one.sent.map(x => x.handle)).toEqual(['mason-b']);
  });

  it('only the handles that sent are recorded; all failing is send-failed', async () => {
    const s = setup({ handles: two });
    s.deps.bridge.send = async handle => handle === 'mason-b';
    expect(await startOwnerPair(s.deps)).toMatchObject({ status: 'pending', handles: ['mason-b'] });
    const f = setup({ handles: two });
    f.deps.bridge.send = async () => false;
    expect((await startOwnerPair(f.deps)).status).toBe('send-failed');
  });
});
