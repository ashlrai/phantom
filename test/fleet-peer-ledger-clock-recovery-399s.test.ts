import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetPeerLedger } from '../src/cli/fleet-peer-ledger.js';
import * as peerBus from '../src/core/agentnet/peer-bus.js';
import { readPeerLedger } from '../src/core/agentnet/peer-ledger.js';

it('refreshes real CLI evidence across clock rollback, exact recovery and replacement', async () => {
  const busRoot = realpathSync(mkdtempSync(join(tmpdir(), 'peer-clock-399s-')));
  const dir = join(busRoot, 'agentnet'), file = join(dir, 'coordination.json');
  const at = Date.parse('2026-11-13T12:00:00.000Z');
  const threadId = 'fixture-private-thread-399s', digest = '3995a1b2'.repeat(8);
  const iso = (ms: number) => new Date(ms).toISOString();
  const origin = (n: number) => `peer-3995a1b2-3995-4995-8995-${String(n).padStart(12, '0')}`;
  const row = (n: number, time: number): peerBus.PeerLedgerRow => ({
    id: origin(n), origin: origin(n), fromAgent: `fixture-source-${n}`, target: `fixture-target-${n}`,
    at: time, hopCount: peerBus.PEER_MAX_HOPS - 1, threadId, digest,
  });
  let nowMs = at + 1_000, stdout = '', stderr = '', calls = 0;
  // Only the root and clock are injected: every invocation parses the actual private file.
  const read = vi.fn(() => readPeerLedger({ busRoot, now: () => nowMs }));
  try {
    mkdirSync(dir, { mode: 0o700 });
    vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => { stdout += String(s); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => { stderr += String(s); return true; });
    const send = vi.spyOn(peerBus, 'sendPeerMessage').mockImplementation(async () => { throw new Error('unexpected peer send'); });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('unexpected network request'); });
    const snapshot = () => ({ bytes: readFileSync(file, 'utf8'), stat: statSync(file),
      rootEntries: readdirSync(busRoot), entries: readdirSync(dir) });
    const run = async (json: boolean) => {
      const before = snapshot();
      stdout = ''; stderr = '';
      const code = await cmdFleetPeerLedger(json ? ['--json'] : [], { read });
      expect(read).toHaveBeenCalledTimes(++calls);
      expect(stderr).toBe('');
      for (const privateDetail of [threadId, digest, busRoot, file]) {
        expect(stdout + stderr).not.toContain(privateDetail);
      }
      // Read access may update atime; bytes, write timestamps, permissions and entries must not change.
      const after = snapshot();
      expect({ ...after, stat: undefined }).toEqual({ ...before, stat: undefined });
      for (const key of ['mtimeMs', 'ctimeMs', 'ino', 'mode', 'size'] as const) expect(after.stat[key]).toBe(before.stat[key]);
      expect(send).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      return { code, text: stdout };
    };
    const expectAvailable = async (evidence: peerBus.PeerLedgerRow, count: number) => {
      const blocked = count === peerBus.PEER_PAIR_LIMIT;
      const retryAt = blocked ? iso(evidence.at + peerBus.PEER_WINDOW_MS) : null;
      for (const json of [false, true]) {
        const result = await run(json);
        expect(result.code).toBe(0);
        if (json) {
          expect(JSON.parse(result.text)).toMatchObject({ status: 'ok', authority: 'none', asOf: iso(nowMs), liveRows: count,
            pairs: [{ fromAgent: evidence.fromAgent, target: evidence.target, inWindow: count,
              remaining: peerBus.PEER_PAIR_LIMIT - count, lastAt: iso(evidence.at), retryAt }],
            origins: [{ origin: evidence.origin, maxHop: evidence.hopCount, nearCap: true }] });
          expect(JSON.parse(result.text)).not.toHaveProperty('reason');
        } else {
          expect(result.text).toBe(`peer ledger: ok\nas of: ${iso(nowMs)}\nlive rows: ${count} of 1024\n` +
            `${evidence.fromAgent} -> ${evidence.target}  ${count}/${peerBus.PEER_PAIR_LIMIT}  remaining ${peerBus.PEER_PAIR_LIMIT - count}` +
            `${blocked ? `  blocked; retry at: ${retryAt}` : ''}\n` +
            `near hop cap: ${evidence.origin} at hop ${evidence.hopCount} of ${peerBus.PEER_MAX_HOPS}\n`);
        }
        if (evidence !== initial) {
          for (const stale of [initial.fromAgent, initial.target, initial.origin, iso(at + peerBus.PEER_WINDOW_MS)]) {
            expect(result.text).not.toContain(stale);
          }
        }
      }
    };
    const initial = row(1, at);
    writeFileSync(file, JSON.stringify(Array.from({ length: peerBus.PEER_PAIR_LIMIT }, (_, i) => ({
      ...initial, id: origin(10 + i),
    }))), { mode: 0o600 });
    await expectAvailable(initial, peerBus.PEER_PAIR_LIMIT);

    // The same bytes become future evidence, just one millisecond before row.at.
    nowMs = at - 1;
    for (const json of [false, true]) {
      const result = await run(json);
      expect(result.code).toBe(1);
      if (json) {
        expect(JSON.parse(result.text)).toMatchObject({ status: 'unavailable', reason: 'peer-clock-reversed',
          authority: 'none', asOf: iso(nowMs), liveRows: 0, pairs: [], origins: [] });
      } else {
        expect(result.text).toBe(`peer ledger: unavailable (peer-clock-reversed)\nas of: ${iso(nowMs)}\nlive rows: 0 of 1024\n`);
      }
      for (const stale of [initial.fromAgent, initial.target, initial.origin, iso(at + peerBus.PEER_WINDOW_MS),
        'retryAt', 'retry at:', '"empty"', '"ok"', 'peer ledger: empty', 'peer ledger: ok']) {
        expect(result.text).not.toContain(stale);
      }
    }
    nowMs = at;
    await expectAvailable(initial, peerBus.PEER_PAIR_LIMIT);

    nowMs = at + 2_000;
    const replacement = row(2, nowMs);
    writeFileSync(file, JSON.stringify([replacement]));
    await expectAvailable(replacement, 1);
    expect(calls).toBe(8);
  } finally {
    vi.restoreAllMocks();
    rmSync(busRoot, { recursive: true, force: true });
  }
});
