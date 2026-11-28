/** Automatic pairing stops after two unanswered invitations. All handles and bridge I/O are fake. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureOwnerAdaptersFile } from '../src/core/comms/owner-adapters-file.js';
import {
  PAIR_AUTO_MAX_UNANSWERED, PAIR_TEXT, PAIR_TTL_MS, checkOwnerPair, pairTick,
  readOwnerPairStatus, readPairState, startOwnerPair, unpairOwner,
  type PairDeps, type PairInbound,
} from '../src/core/comms/owner-pair.js';

vi.setConfig({ testTimeout: 30_000 });
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'owner-pair-auto-stop-'));
  roots.push(dir);
  ensureOwnerAdaptersFile(dir);
  writeFileSync(join(dir, 'comms.toml'), 'confirmedByMason = true\n');
  const stateFile = join(dir, 'comms', 'owner-pair.json');
  const sent: { handle: string; text: string }[] = [];
  let now = Date.UTC(2026, 10, 26);
  let inbound: PairInbound[] = [];
  const deps: PairDeps = { configDir: dir, now: () => now, bridge: {
    ownHandles: vi.fn(async () => ['mason-test']),
    baseline: vi.fn(async () => 10),
    send: vi.fn(async (handle, text) => { sent.push({ handle, text }); return true; }),
    replies: vi.fn(async () => inbound),
  } };
  return { dir, deps, sent,
    advance: () => { now += PAIR_TTL_MS; },
    reply: () => { inbound = [{ rowid: 11, text: 'YES', handle: 'mason-test' }]; },
    stored: () => JSON.parse(readFileSync(stateFile, 'utf8')),
    writeState: (state: unknown) => {
      mkdirSync(join(dir, 'comms'), { recursive: true });
      writeFileSync(stateFile, JSON.stringify(state));
    },
    writeRaw: (text: string) => {
      mkdirSync(join(dir, 'comms'), { recursive: true });
      writeFileSync(stateFile, text);
    },
  };
}

async function pause(s: ReturnType<typeof setup>) {
  expect(PAIR_AUTO_MAX_UNANSWERED).toBe(2);
  expect((await pairTick(s.deps)).action).toBe('started');
  expect(readPairState(s.dir)).toMatchObject({ pending: { auto: true }, autoUnanswered: 0 });
  s.advance();
  expect((await pairTick(s.deps)).action).toBe('started');
  expect(readPairState(s.dir).autoUnanswered).toBe(1);
  s.advance();
  return pairTick(s.deps);
}

describe('automatic owner-pair invitation cap', () => {
  it('pauses after two unanswered automatic expirations and stays paused across later ticks', async () => {
    const s = setup();
    expect(await pause(s)).toEqual({ action: 'none',
      detail: 'auto-paused: 2 invitations unanswered; run phm owner pair imessage to retry' });
    expect(s.sent).toEqual(Array.from({ length: 2 }, () => ({ handle: 'mason-test', text: PAIR_TEXT })));
    expect(s.stored()).toMatchObject({ pending: null, autoUnanswered: 2 });
    expect(readOwnerPairStatus(s.dir)).toEqual({ schema: 'owner-pair.status.v1', state: 'not-paired',
      line: 'not paired (auto invitations paused after 2 unanswered)', autoPaused: true });
    for (let i = 0; i < 4; i++) {
      s.advance();
      expect((await pairTick(s.deps)).detail).toMatch(/^auto-paused/);
    }
    expect(await startOwnerPair(s.deps, { auto: true })).toEqual({ status: 'auto-paused' });
    expect(s.deps.bridge.ownHandles).toHaveBeenCalledTimes(2);
    expect(s.deps.bridge.baseline).toHaveBeenCalledTimes(2);
    expect(s.sent).toHaveLength(2);
  });

  it('an explicit retry sends once, resets the counter, and a YES binds', async () => {
    const s = setup();
    await pause(s);
    expect((await startOwnerPair(s.deps)).status).toBe('pending');
    expect(s.sent).toHaveLength(3);
    expect(s.stored()).toMatchObject({ pending: { auto: false }, autoUnanswered: 0 });
    expect(readOwnerPairStatus(s.dir).autoPaused).toBeUndefined();
    s.reply();
    expect(await checkOwnerPair(s.deps)).toEqual({ status: 'bound', confirmed: true });
    expect(readPairState(s.dir)).toMatchObject({ pending: null, autoUnanswered: 0 });
    expect(readOwnerPairStatus(s.dir)).toMatchObject({ state: 'paired' });
  });

  it('a YES on the second automatic invitation resets the unanswered counter', async () => {
    const s = setup();
    await pairTick(s.deps);
    s.advance();
    await pairTick(s.deps);
    expect(readPairState(s.dir).autoUnanswered).toBe(1);
    s.reply();
    expect((await pairTick(s.deps)).action).toBe('bound');
    expect(readPairState(s.dir).autoUnanswered).toBe(0);
  });

  it('an expired explicit invitation does not count toward the automatic cap', async () => {
    const s = setup();
    await startOwnerPair(s.deps);
    expect(s.stored().pending.auto).toBe(false);
    s.advance();
    expect((await pairTick(s.deps)).action).toBe('started');
    expect(readPairState(s.dir).autoUnanswered).toBe(0);
    s.advance();
    expect((await pairTick(s.deps)).action).toBe('started');
    s.advance();
    expect((await pairTick(s.deps)).detail).toMatch(/^auto-paused/);
    expect(s.sent).toHaveLength(3);
  });

  it('direct automatic starts also consume expirations once and respect the cap', async () => {
    const s = setup();
    for (let i = 0; i < 2; i++) {
      expect((await startOwnerPair(s.deps, { auto: true })).status).toBe('pending');
      s.advance();
    }
    expect((await startOwnerPair(s.deps, { auto: true })).status).toBe('auto-paused');
    expect((await checkOwnerPair(s.deps)).status).toBe('none');
    expect(readPairState(s.dir).autoUnanswered).toBe(2);
    expect(s.sent).toHaveLength(2);
  });

  it('legacy state without the counter or pending origin reads cleanly', async () => {
    const s = setup();
    expect(readPairState(s.dir).autoUnanswered).toBe(0);
    await startOwnerPair(s.deps);
    const legacy = s.stored();
    delete legacy.autoUnanswered;
    delete legacy.pending.auto;
    s.writeState(legacy);
    expect(readPairState(s.dir)).toMatchObject({ autoUnanswered: 0, pending: { auto: false } });
    s.advance();
    expect((await checkOwnerPair(s.deps)).status).toBe('expired');
    expect(readPairState(s.dir).autoUnanswered).toBe(0);
    expect((await pairTick(s.deps)).action).toBe('started');
  });

  it.each(['2', -1, NaN, null, 0.5, Number.MAX_SAFE_INTEGER + 1, 100])('a damaged or excessive counter (%s) fails closed', async count => {
    const s = setup();
    s.writeState({ pending: null, lastStartAt: null, autoOff: false, autoUnanswered: count });
    expect(readPairState(s.dir).autoUnanswered).toBe(2);
    for (let i = 0; i < 3; i++) {
      expect((await pairTick(s.deps)).detail).toMatch(/^auto-paused/);
      s.advance();
    }
    expect(s.sent).toHaveLength(0);
  });

  it('invalid JSON containing a literal NaN also fails closed', async () => {
    const s = setup();
    s.writeRaw('{"autoUnanswered":NaN}');
    expect(readPairState(s.dir).autoUnanswered).toBe(2);
    expect((await pairTick(s.deps)).detail).toMatch(/^auto-paused/);
    expect(s.sent).toHaveLength(0);
  });

  it('unpair still disables automatic invitations until an explicit retry', async () => {
    const s = setup();
    await pause(s);
    unpairOwner(s.dir);
    expect(readPairState(s.dir).autoOff).toBe(true);
    s.advance();
    expect((await pairTick(s.deps)).action).toBe('none');
    expect(s.sent).toHaveLength(2);
    await startOwnerPair(s.deps);
    expect(readPairState(s.dir)).toMatchObject({ autoOff: false, autoUnanswered: 0 });
    expect(s.sent).toHaveLength(3);
  });
});
