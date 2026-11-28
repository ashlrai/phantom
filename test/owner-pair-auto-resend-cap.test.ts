import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cmdFleetOwnerLive, cmdOwnerLiveStatus } from '../src/cli/fleet-owner-live.js';
import { cmdOwnerPair } from '../src/cli/owner-pair.js';
import { emptyOwnerSettings, loadOwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { PAIR_TEXT, PAIR_TTL_MS, pairTick, readPairState, startOwnerPair, type PairDeps, type PairInbound } from '../src/core/comms/owner-pair.js';

const OWNER = 'owner@example.invalid';
const OTHER = 'other@example.invalid';
const MANUAL = 'phm owner pair imessage';
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function fixture() {
  const configDir = mkdtempSync(join(tmpdir(), 'owner-pair-cap-'));
  roots.push(configDir);
  let now = Date.UTC(2026, 10, 24);
  let rowid = 10;
  const handles = [OWNER];
  const sent: { handle: string; text: string }[] = [];
  const inbox: PairInbound[] = [];
  const network = join(configDir, 'agent-network.toml');
  writeFileSync(join(configDir, 'comms.toml'), 'confirmedByMason = true\n');
  const pair: PairDeps = { configDir, now: () => now, bridge: {
    async ownHandles() { return handles; },
    async baseline() { return rowid; },
    async send(handle, text) { sent.push({ handle, text }); return true; },
    async replies(after) { return inbox.filter(reply => reply.rowid > after); },
  } };
  const output: string[] = [];
  const live = { pair, output: (line: string) => output.push(line), options: {
    runsDir: configDir, settings: { ...emptyOwnerSettings(), imessageBridge: 'loopback' as const }, now: pair.now,
  } };
  return { pair, handles, sent, network, output, live, tick: () => pairTick(pair), state: () => readPairState(configDir),
    expire() { now += PAIR_TTL_MS; },
    reply(text: string, handle = OWNER) { inbox.push({ rowid: ++rowid, text, handle, fromMe: true }); },
  };
}

it('caps four expired windows at two texts and reports the persistent stop', async () => {
  const f = fixture();
  expect((await f.tick()).action).toBe('started');
  for (const action of ['started', 'declined_auto', 'declined_auto', 'declined_auto']) {
    f.expire();
    expect((await f.tick()).action).toBe(action);
  }
  expect(f.sent).toEqual(Array(2).fill({ handle: OWNER, text: PAIR_TEXT }));
  const declinedAt = f.pair.now!() - 2 * PAIR_TTL_MS;
  expect(f.state()).toMatchObject({ pending: null, autoInvitations: { [OWNER]: { sent: 2, declinedAt } } });
  expect(await cmdFleetOwnerLive(['--apply', '--json'], f.live)).toBe(0);
  expect(JSON.parse(f.output.pop()!).pair).toMatchObject({ action: 'declined_auto', detail: expect.stringContaining(MANUAL) });
  expect(await cmdOwnerLiveStatus(['--json'], f.live)).toBe(0);
  expect(JSON.parse(f.output.pop()!).pair).toMatchObject({ state: 'declined_auto', line: expect.stringContaining(MANUAL), since: new Date(declinedAt).toISOString() });
  expect(await cmdOwnerLiveStatus([], f.live)).toBe(0);
  expect(f.output).toContainEqual(expect.stringContaining('Automatic pairing invitations stopped'));
  expect(f.sent).toHaveLength(2);
});

it('sends one explicit retry after the cap and resets the automatic count', async () => {
  const f = fixture();
  await f.tick(); f.expire(); await f.tick(); f.expire(); await f.tick();
  expect(await cmdOwnerPair(['pair', 'imessage'], { pair: f.pair, output: () => {} })).toBe(0);
  expect(f.sent).toHaveLength(3);
  expect(f.state().autoInvitations).toBeUndefined();
  f.expire();
  expect((await f.tick()).action).toBe('started');
  expect(f.state().autoInvitations?.[OWNER]?.sent).toBe(1);
});

it.each([false, true])('stops on no thanks without binding (first observed after expiry: %s)', async afterExpiry => {
  const f = fixture();
  await f.tick();
  f.reply('no thanks');
  if (afterExpiry) f.expire();
  expect((await f.tick()).action).toBe('declined_auto');
  f.expire();
  expect((await f.tick()).action).toBe('declined_auto');
  expect(f.sent).toHaveLength(1);
  expect(existsSync(f.network)).toBe(false);
});

it('accepts YES in the first window and writes the owner and team binding', async () => {
  const f = fixture();
  await f.tick();
  f.reply(PAIR_TEXT);
  expect((await f.tick()).action).toBe('waiting');
  f.reply(' YES ');
  expect(await f.tick()).toEqual({ action: 'bound', detail: 'paired and confirmed' });
  const settings = loadOwnerThreadSettings(f.pair.configDir);
  expect(settings.owners.imessage).toBe(OWNER);
  expect(settings.team).toContainEqual(expect.objectContaining({ channel: 'imessage', id: OWNER }));
});

it('keeps per-handle history across eligibility changes and direct automatic starts', async () => {
  const f = fixture();
  await f.tick();
  f.reply(PAIR_TEXT);
  f.expire();
  f.handles.splice(0, 1, OWNER.toUpperCase(), OTHER);
  expect((await startOwnerPair(f.pair, { auto: true })).status).toBe('pending');
  f.expire();
  expect(await startOwnerPair(f.pair, { auto: true })).toMatchObject({ status: 'pending', handles: [OTHER] });
  f.expire();
  expect((await startOwnerPair(f.pair, { auto: true })).status).toBe('declined_auto');
  expect(f.sent.map(row => row.handle.toLowerCase())).toEqual([OWNER, OWNER, OTHER, OTHER]);
});

it('reserves only one invitation when automatic starts overlap', async () => {
  const f = fixture();
  const results = await Promise.all([f.tick(), f.tick()]);
  expect(results.filter(result => result.action === 'started')).toHaveLength(1);
  expect(f.sent).toHaveLength(1);
  expect(f.state().autoInvitations?.[OWNER]?.sent).toBe(1);
});
