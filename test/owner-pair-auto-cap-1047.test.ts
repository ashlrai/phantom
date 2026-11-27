import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  PAIR_AUTO_MAX_UNANSWERED, PAIR_TEXT, PAIR_TTL_MS, checkOwnerPair, pairTick,
  readOwnerPairStatus, readPairState, startOwnerPair, unpairOwner,
  type PairBridge, type PairDeps, type PairInbound,
} from '../src/core/comms/owner-pair.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'owner-pair-cap-'));
  roots.push(dir);
  writeFileSync(join(dir, 'comms.toml'), 'confirmedByMason = true\n');
  const sent: { handle: string; text: string }[] = [];
  const inbound: PairInbound[] = [];
  let now = Date.UTC(2026, 10, 24);
  const bridge: PairBridge = {
    async ownHandles() { return ['+15550000001']; },
    async baseline() { return 10; },
    async send(handle, text) { sent.push({ handle, text }); return true; },
    async replies() { return inbound; },
  };
  const deps: PairDeps = { configDir: dir, bridge, now: () => now };
  return {
    dir, deps, sent, inbound,
    advance: () => { now += PAIR_TTL_MS + 1; },
    writeState: (state: object) => {
      mkdirSync(join(dir, 'comms'), { recursive: true });
      writeFileSync(join(dir, 'comms', 'owner-pair.json'), JSON.stringify(state));
    },
  };
}

async function stopAuto(s: ReturnType<typeof setup>) {
  expect(PAIR_AUTO_MAX_UNANSWERED).toBe(3);
  expect((await pairTick(s.deps)).action).toBe('started');
  for (let round = 1; round <= PAIR_AUTO_MAX_UNANSWERED; round++) {
    expect(readPairState(s.dir).pending?.auto).toBe(true);
    s.advance();
    expect(await pairTick(s.deps)).toMatchObject(round < PAIR_AUTO_MAX_UNANSWERED
      ? { action: 'started' } : { action: 'expired', detail: 'auto-stopped' });
    expect(readPairState(s.dir).autoUnanswered).toBe(round);
  }
}

it('stops after three unanswered auto rounds, including later ticks and restarts', async () => {
  const s = setup();
  await stopAuto(s);
  expect(s.sent).toEqual(Array.from({ length: 3 }, () => ({ handle: '+15550000001', text: PAIR_TEXT })));
  s.advance();
  expect(await pairTick({ ...s.deps })).toEqual({ action: 'none', detail: 'auto-stopped' });
  expect(await startOwnerPair(s.deps, { auto: true })).toEqual({ status: 'too-soon' });
  expect(s.sent).toHaveLength(3);
  expect(readOwnerPairStatus(s.dir)).toEqual({
    schema: 'owner-pair.status.v1', state: 'not-paired', autoStopped: true,
    line: 'not paired (auto invite stopped after 3 unanswered; run phm owner pair imessage)',
  });
  unpairOwner(s.dir);
  expect(readPairState(s.dir).autoUnanswered).toBe(3);
});

it('a manual start after the stop sends again, resets the counter and binds on YES', async () => {
  const s = setup();
  await stopAuto(s);
  expect((await startOwnerPair(s.deps)).status).toBe('pending');
  expect(s.sent).toHaveLength(4);
  expect(readPairState(s.dir)).toMatchObject({ autoUnanswered: 0, pending: { auto: false } });
  s.inbound.push({ rowid: 11, handle: '+15550000001', text: 'YES' });
  expect(await checkOwnerPair(s.deps)).toEqual({ status: 'bound', confirmed: true });
  expect(readPairState(s.dir).autoUnanswered).toBe(0);
  expect(readOwnerPairStatus(s.dir).line).toBe('paired (**01)');
});

it.each([undefined, -1, 0.5, '3', Number.MAX_SAFE_INTEGER + 1])('defaults absent or invalid counter %s to zero', value => {
  const s = setup();
  s.writeState({ pending: null, lastStartAt: null, autoOff: false, autoUnanswered: value });
  expect(readPairState(s.dir).autoUnanswered).toBe(0);
  expect(readOwnerPairStatus(s.dir)).not.toHaveProperty('autoStopped');
});

it('does not count an expired manual pair or legacy pending pair as unanswered auto', async () => {
  const s = setup();
  await startOwnerPair(s.deps);
  s.advance();
  expect(await checkOwnerPair(s.deps)).toEqual({ status: 'expired' });
  expect(readPairState(s.dir).autoUnanswered).toBe(0);
  s.writeState({ ...readPairState(s.dir), pending: {
    handles: ['+15550000001'], startedAt: 0, expiresAt: 1, afterRowId: 10,
  } });
  expect(await checkOwnerPair(s.deps)).toEqual({ status: 'expired' });
  expect(readPairState(s.dir).autoUnanswered).toBe(0);
  expect((await pairTick(s.deps)).action).toBe('started');
});

it('binding clears an existing unanswered counter', async () => {
  const s = setup();
  s.writeState({ pending: null, lastStartAt: null, autoOff: false, autoUnanswered: 2 });
  await pairTick(s.deps);
  s.inbound.push({ rowid: 11, handle: '+15550000001', text: 'YES' });
  expect((await checkOwnerPair(s.deps)).status).toBe('bound');
  expect(readPairState(s.dir).autoUnanswered).toBe(0);
});
