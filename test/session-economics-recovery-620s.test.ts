import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdFleetSessionEconomics } from '../src/cli/fleet-session-economics.js';
import { sizeWorkerSession } from '../src/core/org/session-economics.js';

// Recovered economics assertions from PR #5809 (head 57bd290), with fake fixtures only.
const sample = { batchDepth: 100, fanOut: 2, completed: 100, tokens: 1000, elapsedMs: 1000, setupTokens: 200 };
const vitals = { queued: 100, liveClaims: 0, tokenCeiling: 10_000, fanOutCeiling: 4, warm: sample, fresh: [sample] };

describe('session economics core (recovered from #5809)', () => {
  it('keeps a warm session when its amortized cost wins, and spawns a measured cheaper fresh configuration', () => {
    expect(sizeWorkerSession(vitals).action).toBe('keep');
    expect(sizeWorkerSession({ ...vitals, fresh: [{ ...sample, tokens: 500 }] })).toMatchObject({ action: 'spawn', sizing: { batchDepth: 100, plannedTasks: 100, tokensPerTask: 7 } });
  });

  it('amortizes fresh setup over a one-item queue and keeps the warm session', () => {
    expect(sizeWorkerSession({ ...vitals, queued: 1, fresh: [{ ...sample, tokens: 500 }] }).action).toBe('keep');
    // One planned task carries the whole setup: 500/100 + 200/1 = 205.
    expect(sizeWorkerSession({ ...vitals, queued: 1, warm: null, fresh: [{ ...sample, tokens: 500 }] })).toMatchObject({ action: 'spawn', sizing: { plannedTasks: 1, tokensPerTask: 205 } });
  });

  it('breaks equal tokens per task on measured throughput', () => {
    // Zero setup on both, so each costs 10 tokens per task and only throughput (1/ms vs 4/ms) differs.
    const slow = { ...sample, setupTokens: 0, elapsedMs: 4000 };
    const fast = { ...sample, setupTokens: 0, batchDepth: 50 };
    const result = sizeWorkerSession({ ...vitals, warm: null, fresh: [slow, fast] });
    expect(result).toMatchObject({ action: 'spawn', sizing: { batchDepth: 50, tokensPerTask: 10 } });
  });

  it('drains live work, retires idle sessions, and never turns a fresh recommendation into replacement of running work', () => {
    expect(sizeWorkerSession({ ...vitals, queued: 0, liveClaims: 1 })).toEqual({ action: 'drain', sizing: null });
    expect(sizeWorkerSession({ ...vitals, queued: 0 })).toEqual({ action: 'retire', sizing: null });
    expect(sizeWorkerSession({ ...vitals, liveClaims: 1, fresh: [{ ...sample, tokens: 500 }] }).action).toBe('drain');
  });

  it('holds when there is no evidence or the caller ceilings exclude every option', () => {
    expect(sizeWorkerSession({ ...vitals, warm: null, fresh: [] })).toEqual({ action: 'hold', sizing: null });
    expect(sizeWorkerSession({ ...vitals, tokenCeiling: 1 })).toEqual({ action: 'hold', sizing: null });
    expect(sizeWorkerSession({ ...vitals, fanOutCeiling: 1 })).toEqual({ action: 'hold', sizing: null });
  });

  it('rejects invalid numbers, unknown fields and missing ceilings instead of inferring them', () => {
    const bad: unknown[] = [
      { ...vitals, queued: -1 },
      { ...vitals, queued: 1.5 },
      { ...vitals, tokenCeiling: Number.NaN },
      { ...vitals, tokenCeiling: Number.POSITIVE_INFINITY },
      { ...vitals, warm: { ...sample, batchDepth: 5 } },
      { ...vitals, warm: { ...sample, elapsedMs: 0 } },
      { ...vitals, extra: true },
      { queued: 1, liveClaims: 0, fanOutCeiling: 4, warm: null, fresh: [] },
    ];
    for (const raw of bad) expect(() => sizeWorkerSession(raw)).toThrow('Invalid session vitals.');
  });
});

describe('fleet session-economics CLI (exported handler)', () => {
  let dir: string;
  let log: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;
  const write = (name: string, body: string) => { const path = join(dir, name); writeFileSync(path, body); return path; };
  const out = () => log.mock.calls.map(call => String(call[0])).join('\n');
  const errOut = () => err.mock.calls.map(call => String(call[0])).join('\n');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'session-economics-620s-'));
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    err = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints usage for --help and exits 0 without reading input', async () => {
    expect(await cmdFleetSessionEconomics(['--help'])).toBe(0);
    expect(out()).toContain('Usage: phm fleet session-economics');
  });

  it('emits advisory JSON with no execution authority for a warm-versus-fresh snapshot', async () => {
    const input = write('snapshot.json', JSON.stringify({ ...vitals, fresh: [{ ...sample, tokens: 500 }] }));
    expect(await cmdFleetSessionEconomics(['--input', input, '--json'])).toBe(0);
    expect(JSON.parse(out())).toMatchObject({
      schema: 'fleet.session-economics.v1', advisory: true, executionAuthority: 'none',
      action: 'spawn', sizing: { plannedTasks: 100, tokensPerTask: 7 },
    });
  });

  it('reports a live-claim fresh recommendation as drain in text mode', async () => {
    const input = write('claims.json', JSON.stringify({ ...vitals, liveClaims: 2, warm: null, fresh: [{ ...sample, tokens: 500 }] }));
    expect(await cmdFleetSessionEconomics(['--input', input])).toBe(0);
    expect(out()).toContain('advisory, no execution authority): action=drain');
  });

  it('exits 0 with hold and null sizing when no observations exist', async () => {
    const input = write('empty.json', JSON.stringify({ ...vitals, warm: null, fresh: [] }));
    expect(await cmdFleetSessionEconomics(['--input', input, '--json'])).toBe(0);
    expect(JSON.parse(out())).toMatchObject({ action: 'hold', sizing: null });
  });

  it('exits 2 on missing or unknown arguments', async () => {
    expect(await cmdFleetSessionEconomics([])).toBe(2);
    expect(await cmdFleetSessionEconomics(['--input', '--json'])).toBe(2);
    expect(await cmdFleetSessionEconomics(['--input', 'x.json', '--bogus'])).toBe(2);
  });

  it('fails with sanitized fixed errors for malformed, invalid or oversized input, never echoing content', async () => {
    const marker = 'SECRET-MARKER-620S';
    const cases = [
      join(dir, 'does-not-exist.json'),
      write('malformed.json', `{"leak":"${marker}"`),
      write('invalid.json', JSON.stringify({ ...vitals, queued: -1, note: marker })),
      write('oversize.json', ' '.repeat(64 * 1024 + 1) + marker),
    ];
    for (const path of cases) {
      expect(await cmdFleetSessionEconomics(['--input', path, '--json'])).toBe(1);
    }
    expect(errOut()).toContain('error:');
    expect(errOut()).not.toContain(marker);
    expect(errOut()).not.toContain(dir);
    expect(out()).not.toContain(marker);
  });
});
