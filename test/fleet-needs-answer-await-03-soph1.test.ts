import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetNeedsAnswer } from '../src/cli/fleet-needs-answer.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { readNeedsMasonAnswer } from '../src/core/fleet/needs-mason-answer.js';
import {
  awaitNeedsMasonAnswer, NEEDS_MASON_AWAIT_MAX_POLL_MS, NEEDS_MASON_AWAIT_MAX_TIMEOUT_MS,
} from '../src/core/fleet/needs-mason-answer-await.js';
import { resolveNeedsMason } from '../src/core/fleet/needs-mason-resolve.js';

const itemText = 'Approve the fake deploy';
const idOf = (text: string) => `nm-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
const itemId = idOf(itemText), otherText = 'Choose a fake vendor', otherId = idOf(otherText);

let root: string, runsDir: string, busRoot: string, out: string[], errors: string[];
const resolve = (id: string, reply: string) => resolveNeedsMason({ itemId: id, reply },
  { runsDir, bus: { root: busRoot, now: Date.now }, source: 'cli' });
/** A fake clock whose sleep advances time and records each requested delay. */
function clock(onSleep?: (calls: number) => void) {
  let t = 1000; const sleeps: number[] = [];
  return { sleeps, now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; onSleep?.(sleeps.length); } };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'needs-answer-await-'));
  runsDir = join(root, 'runs'); busRoot = join(root, 'fleet');
  mkdirSync(runsDir);
  writeFileSync(join(runsDir, 'NEEDS-MASON.md'), `# fake ledger\n- [ ] ${itemText}\n- [ ] ${otherText}\n`);
  out = []; errors = [];
  vi.spyOn(console, 'log').mockImplementation((message: string) => { out.push(message); });
  vi.spyOn(process.stderr, 'write').mockImplementation(message => { errors.push(String(message)); return true; });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('awaitNeedsMasonAnswer', () => {
  it('stays unknown through wrong-item traffic, then returns the exact retained receipt', async () => {
    const c = clock(calls => {
      if (calls === 1) expect(resolve(otherId, 'fake other answer')).toMatchObject({ ok: true });
      if (calls === 2) expect(resolve(itemId, 'fake go ahead')).toMatchObject({ ok: true });
    });
    const result = await awaitNeedsMasonAnswer(itemId, { root: busRoot, timeoutMs: 60_000, pollMs: 500 }, c);
    expect(result).toEqual(readNeedsMasonAnswer(itemId, { root: busRoot }));
    expect(result).toMatchObject({ status: 'found', id: `needs-mason-resolved-${itemId}`, cursor: 2,
      answer: { itemId, item: itemText, reply: 'fake go ahead', source: 'cli' } });
    expect(c.sleeps).toEqual([500, 500]);
  });

  it('times out with only unrelated traffic, capping the last sleep at the time remaining', async () => {
    resolve(otherId, 'fake other answer');
    const before = readFileSync(join(busRoot, 'bus-inbox', 'messages.json'), 'utf8');
    const c = clock();
    expect(await awaitNeedsMasonAnswer(itemId, { root: busRoot, timeoutMs: 1200, pollMs: 500 }, c)).toEqual({ status: 'timeout' });
    expect(c.sleeps).toEqual([500, 500, 200]);
    expect(readFileSync(join(busRoot, 'bus-inbox', 'messages.json'), 'utf8')).toBe(before);
  });

  it('ends explicitly when the store is unavailable, including a throwing reader', async () => {
    const c = clock();
    expect(await awaitNeedsMasonAnswer(itemId, { timeoutMs: 5000 }, { ...c, read: () => ({ status: 'unavailable' }) }))
      .toEqual({ status: 'unavailable' });
    expect(await awaitNeedsMasonAnswer(itemId, { timeoutMs: 5000 }, { ...c, read: () => { throw new Error('boom'); } }))
      .toEqual({ status: 'unavailable' });
    expect(c.sleeps).toEqual([]);
  });

  it('performs no read when already aborted and stops after an abort during sleep', async () => {
    const read = vi.fn(() => ({ status: 'unknown' as const }));
    const pre = new AbortController(); pre.abort();
    expect(await awaitNeedsMasonAnswer(itemId, { timeoutMs: 5000, signal: pre.signal }, { read })).toEqual({ status: 'cancelled' });
    expect(read).not.toHaveBeenCalled();
    const live = new AbortController();
    const c = clock(() => live.abort());
    expect(await awaitNeedsMasonAnswer(itemId, { timeoutMs: 5000, signal: live.signal }, { ...c, read })).toEqual({ status: 'cancelled' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('passes the bus root to the reader and rejects out-of-range bounds without reading', async () => {
    const read = vi.fn(() => ({ status: 'unknown' as const }));
    await awaitNeedsMasonAnswer(itemId, { root: busRoot, timeoutMs: 1 }, { read, ...clock() });
    expect(read).toHaveBeenCalledWith(itemId, { root: busRoot });
    read.mockClear();
    for (const bad of [{ timeoutMs: 0 }, { timeoutMs: 1.5 }, { timeoutMs: NEEDS_MASON_AWAIT_MAX_TIMEOUT_MS + 1 },
      { timeoutMs: 10, pollMs: 0 }, { timeoutMs: 10, pollMs: NEEDS_MASON_AWAIT_MAX_POLL_MS + 1 }]) {
      expect(await awaitNeedsMasonAnswer(itemId, bad, { read })).toEqual({ status: 'invalid' });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('does not leave timers or abort listeners behind', async () => {
    const c = new AbortController();
    const add = vi.spyOn(c.signal, 'addEventListener'), remove = vi.spyOn(c.signal, 'removeEventListener');
    await awaitNeedsMasonAnswer(itemId, { root: busRoot, timeoutMs: 20, pollMs: 5, signal: c.signal });
    expect(add.mock.calls.length).toBeGreaterThan(0);
    expect(remove.mock.calls.length).toBe(add.mock.calls.length);
  });
});

describe('fleet needs-answer --timeout-ms', () => {
  it('waits on the real bus and prints the scrubbed answer, with the one-shot output unchanged', async () => {
    const sleep = async () => { if (!out.length) resolve(itemId, 'fake go ahead'); };
    expect(await cmdFleetNeedsAnswer([itemId, '--bus-root', busRoot, '--timeout-ms', '5000', '--poll-ms', '10'], { sleep })).toBe(0);
    expect(out[0]).toMatch(new RegExp(`^${itemId} answered via cli at .* \\(bus cursor 1\\)\\nitem: ${itemText}\\nreply: fake go ahead$`));
    const waited = out[0];
    expect(await cmdFleetNeedsAnswer([itemId, '--bus-root', busRoot])).toBe(0);
    expect(out[1]).toBe(waited);
  });

  it('reports timeout in JSON and text with exit 3, and no-flag unknown stays exit 1', async () => {
    const c = clock();
    expect(await cmdFleetNeedsAnswer([itemId, '--bus-root', busRoot, '--timeout-ms', '30', '--json'], c)).toBe(3);
    expect(JSON.parse(out[0]!)).toEqual({ v: 1, status: 'timeout', itemId });
    expect(await cmdFleetNeedsAnswer([itemId, '--bus-root', busRoot, '--timeout-ms', '30'], c)).toBe(3);
    expect(out[1]).toBe(`timeout ${itemId}`);
    expect(await cmdFleetNeedsAnswer([itemId, '--bus-root', busRoot])).toBe(1);
    expect(out[2]).toBe(`unknown ${itemId}`);
  });

  it('forwards --bus-root and --poll-ms to the reader', async () => {
    const read = vi.fn(() => ({ status: 'unknown' as const }));
    const c = clock();
    await cmdFleetNeedsAnswer([itemId, '--bus-root', '/fake/root', '--timeout-ms', '100', '--poll-ms', '40'], { read, ...c });
    expect(read).toHaveBeenCalledWith(itemId, { root: '/fake/root' });
    expect(c.sleeps).toEqual([40, 40, 20]);
  });

  it('ends unavailable with exit 1 when the bus cannot be read', async () => {
    const read = vi.fn(() => ({ status: 'unavailable' as const }));
    expect(await cmdFleetNeedsAnswer([itemId, '--timeout-ms', '100'], { read, ...clock() })).toBe(1);
    expect(errors.join('')).toContain('needs-answer unavailable');
  });

  it('removes its signal handlers after the wait', async () => {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    await cmdFleetNeedsAnswer([itemId, '--bus-root', busRoot, '--timeout-ms', '5'], clock());
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });

  it('cancels on SIGINT with exit 130 and no answer', async () => {
    const sleep = async () => { process.emit('SIGINT'); };
    expect(await cmdFleetNeedsAnswer([itemId, '--bus-root', busRoot, '--timeout-ms', '5000', '--json'], { sleep })).toBe(130);
    expect(JSON.parse(out[0]!)).toEqual({ v: 1, status: 'cancelled', itemId });
  });

  it.each([
    ['poll without timeout', ['--poll-ms', '10']],
    ['duplicate timeout', ['--timeout-ms', '10', '--timeout-ms', '20']],
    ['duplicate poll', ['--timeout-ms', '10', '--poll-ms', '1', '--poll-ms', '2']],
    ['zero', ['--timeout-ms', '0']],
    ['negative', ['--timeout-ms', '-5']],
    ['fractional', ['--timeout-ms', '1.5']],
    ['non-numeric', ['--timeout-ms', '1e3']],
    ['missing value', ['--timeout-ms']],
    ['over max timeout', ['--timeout-ms', String(NEEDS_MASON_AWAIT_MAX_TIMEOUT_MS + 1)]],
    ['over max poll', ['--timeout-ms', '10', '--poll-ms', String(NEEDS_MASON_AWAIT_MAX_POLL_MS + 1)]],
    ['unsafe integer', ['--timeout-ms', '99999999999999999999']],
    ['unknown flag', ['--timeout-ms', '10', '--wait']],
  ])('rejects %s before any read', async (_name, flags) => {
    const read = vi.fn(() => ({ status: 'unknown' as const }));
    expect(await cmdFleetNeedsAnswer([itemId, ...flags], { read, ...clock() })).toBe(2);
    expect(read).not.toHaveBeenCalled();
    expect(errors.join('')).toContain('Usage: ashlr fleet needs-answer');
  });

  it('keeps scrubbing replies in waited JSON output', async () => {
    const fakeToken = 'sk-' + 'a'.repeat(40);
    appendBusInbox({ id: `needs-mason-resolved-${itemId}`, from: 'mason', to: 'leaders', priority: 'P1', ttl: 60_000,
      body: { kind: 'needs_mason.resolved', itemId, source: 'cli', item: itemText, reply: `use ${fakeToken}`, resolvedAt: new Date().toISOString() } },
    { root: busRoot });
    expect(await cmdFleetNeedsAnswer([itemId, '--bus-root', busRoot, '--timeout-ms', '100', '--json'], clock())).toBe(0);
    expect(out[0]).not.toContain(fakeToken);
  });
});
