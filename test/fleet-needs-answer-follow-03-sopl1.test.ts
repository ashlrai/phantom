import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetNeedsAnswerFollow } from '../src/cli/fleet-needs-answer-follow.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { appendBusInbox, type BusInboxOptions } from '../src/core/fleet/bus-inbox.js';
import { readNeedsMasonAnswer } from '../src/core/fleet/needs-mason-answer.js';
import {
  followNeedsMasonAnswers, NEEDS_ANSWER_FOLLOW_MAX_IDS, NEEDS_ANSWER_FOLLOW_MAX_POLL_MS,
  NEEDS_ANSWER_FOLLOW_MAX_TIMEOUT_MS, type NeedsAnswerFollowRecord,
} from '../src/core/fleet/needs-mason-answer-follow.js';
import { resolveNeedsMason } from '../src/core/fleet/needs-mason-resolve.js';

const itemText = 'Approve the fake deploy', otherText = 'Choose a fake vendor', openText = 'Pick a fake window';
const idOf = (text: string) => `nm-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
const itemId = idOf(itemText), otherId = idOf(otherText), openId = idOf(openText);

let root: string, runsDir: string, busRoot: string, lines: string[], errors: string[];
const resolve = (id: string, reply: string, source: 'cli' | 'telegram' = 'cli') =>
  resolveNeedsMason({ itemId: id, reply }, { runsDir, bus: { root: busRoot }, source });
const records = (): Array<Record<string, unknown>> => lines.map(line => JSON.parse(line) as Record<string, unknown>);
/** A fake monotonic clock whose sleep advances time and records each delay. */
function clock(onSleep?: (calls: number) => void) {
  let t = 1000; const sleeps: number[] = [];
  return { sleeps, now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; onSleep?.(sleeps.length); } };
}
const emit = (record: NeedsAnswerFollowRecord): void => { lines.push(JSON.stringify(record)); };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'needs-answer-follow-'));
  runsDir = join(root, 'runs'); busRoot = join(root, 'fleet');
  mkdirSync(runsDir);
  writeFileSync(join(runsDir, 'NEEDS-MASON.md'), `# fake ledger\n- [ ] ${itemText}\n- [ ] ${otherText}\n- [ ] ${openText}\n`);
  lines = []; errors = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(message => { errors.push(String(message)); return true; });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('needs-answer-follow convention', () => {
  it('resolves through the fleet convention without registry edits', async () => {
    expect(resolveFleetSubcommand('needs-answer-follow'))
      .toEqual({ module: './fleet-needs-answer-follow.js', exportName: 'cmdFleetNeedsAnswerFollow' });
    const loaded = await import('../src/cli/fleet-needs-answer-follow.js');
    expect(typeof loaded.cmdFleetNeedsAnswerFollow).toBe('function');
  });
});

describe('followNeedsMasonAnswers', () => {
  it('emits the first answer before the second exists, then completes once each', async () => {
    expect(resolve(itemId, 'fake go ahead')).toMatchObject({ ok: true });
    const c = clock(calls => { if (calls === 1) expect(resolve(otherId, 'fake pick one', 'telegram')).toMatchObject({ ok: true }); });
    const result = await followNeedsMasonAnswers(
      { ids: [itemId, otherId], root: busRoot, timeoutMs: 60_000, pollMs: 500 }, { ...c, emit });
    expect(result).toEqual({ outcome: 'complete', pending: [] });
    expect(records()).toHaveLength(3);
    expect(records()[0]).toMatchObject({ v: 1, type: 'answer', itemId, id: `needs-mason-resolved-${itemId}`,
      cursor: 1, receivedAt: expect.any(Number),
      answer: { itemId, item: itemText, reply: 'fake go ahead', source: 'cli' } });
    expect(records()[1]).toMatchObject({ v: 1, type: 'answer', itemId: otherId, cursor: 2,
      answer: { itemId: otherId, item: otherText, reply: 'fake pick one', source: 'telegram' } });
    expect(records()[2]).toEqual({ v: 1, type: 'end', outcome: 'complete', pending: [] });
    expect(records().filter(r => r.type === 'answer' && r.itemId === itemId)).toHaveLength(1);
    expect(records().filter(r => r.type === 'answer' && r.itemId === otherId)).toHaveLength(1);
    expect(c.sleeps).toEqual([500]);
  });

  it('emits in request order within a scan, not bus order', async () => {
    expect(resolve(itemId, 'fake first')).toMatchObject({ ok: true });
    expect(resolve(otherId, 'fake second')).toMatchObject({ ok: true });
    const result = await followNeedsMasonAnswers(
      { ids: [otherId, itemId], root: busRoot, timeoutMs: 60_000 }, { ...clock(), emit });
    expect(result.outcome).toBe('complete');
    expect(records().map(r => r.type === 'answer' ? r.itemId : r.type)).toEqual([otherId, itemId, 'end']);
  });

  it('keeps a missing receipt pending until the shared deadline, first reply retained', async () => {
    expect(resolve(itemId, 'fake go ahead')).toMatchObject({ ok: true });
    const c = clock();
    const result = await followNeedsMasonAnswers(
      { ids: [itemId, openId], root: busRoot, timeoutMs: 1200, pollMs: 500 }, { ...c, emit });
    expect(result).toEqual({ outcome: 'timeout', pending: [openId] });
    expect(records().at(-1)).toEqual({ v: 1, type: 'end', outcome: 'timeout', pending: [openId] });
    expect(records()[0]).toMatchObject({ type: 'answer', itemId, answer: { reply: 'fake go ahead' } });
    expect(records().filter(r => r.type === 'answer')).toHaveLength(1);
    expect(c.sleeps).toEqual([500, 500, 200]);
  });

  it('ends unavailable on a failed read, keeping delivered answers, never on a missing receipt', async () => {
    expect(resolve(itemId, 'fake go ahead')).toMatchObject({ ok: true });
    const read = vi.fn((id: unknown, options?: BusInboxOptions) =>
      id === otherId ? { status: 'unavailable' as const } : readNeedsMasonAnswer(id, options));
    const result = await followNeedsMasonAnswers(
      { ids: [itemId, otherId], root: busRoot, timeoutMs: 60_000 }, { ...clock(), read, emit });
    expect(result).toEqual({ outcome: 'unavailable', pending: [otherId] });
    expect(records()).toEqual([
      expect.objectContaining({ type: 'answer', itemId }),
      { v: 1, type: 'end', outcome: 'unavailable', pending: [otherId] },
    ]);
  });

  it('cancels between ids and still emits the terminal record', async () => {
    expect(resolve(itemId, 'fake go ahead')).toMatchObject({ ok: true });
    const controller = new AbortController();
    const read = vi.fn((id: unknown, options?: BusInboxOptions) => { controller.abort(); return readNeedsMasonAnswer(id, options); });
    const result = await followNeedsMasonAnswers(
      { ids: [itemId, otherId], root: busRoot, timeoutMs: 60_000, signal: controller.signal }, { ...clock(), read, emit });
    expect(result).toEqual({ outcome: 'cancelled', pending: [otherId] });
    expect(records().at(-1)).toEqual({ v: 1, type: 'end', outcome: 'cancelled', pending: [otherId] });
  });

  it('validates before reading and emits nothing on invalid input', async () => {
    const read = vi.fn(() => ({ status: 'unknown' as const }));
    const badEmit = vi.fn();
    for (const bad of [
      { ids: [], timeoutMs: 10 }, { ids: [itemId, itemId], timeoutMs: 10 },
      { ids: Array.from({ length: NEEDS_ANSWER_FOLLOW_MAX_IDS + 1 }, (_, i) => `nm-${String(i).padStart(12, '0')}`), timeoutMs: 10 },
      { ids: ['nm-zzz'], timeoutMs: 10 }, { ids: [itemId], timeoutMs: 0 },
      { ids: [itemId], timeoutMs: NEEDS_ANSWER_FOLLOW_MAX_TIMEOUT_MS + 1 },
      { ids: [itemId], timeoutMs: 10, pollMs: 0 },
      { ids: [itemId], timeoutMs: 10, pollMs: NEEDS_ANSWER_FOLLOW_MAX_POLL_MS + 1 },
    ]) {
      expect(await followNeedsMasonAnswers(bad as never, { read, emit: badEmit })).toEqual({ outcome: 'invalid', pending: [] });
    }
    expect(read).not.toHaveBeenCalled();
    expect(badEmit).not.toHaveBeenCalled();
  });
});

describe('fleet needs-answer-follow', () => {
  it('streams NDJSON answers as they land and exits 0 on complete', async () => {
    expect(resolve(itemId, 'fake go ahead')).toMatchObject({ ok: true });
    const c = clock(calls => { if (calls === 1) expect(resolve(otherId, 'fake pick one', 'telegram')).toMatchObject({ ok: true }); });
    const code = await cmdFleetNeedsAnswerFollow(
      [itemId, otherId, '--bus-root', busRoot, '--timeout-ms', '60000', '--poll-ms', '40', '--json'],
      { ...c, emit: line => { lines.push(line); } });
    expect(code).toBe(0);
    expect(records()).toHaveLength(3);
    expect(records()[0]).toMatchObject({ v: 1, type: 'answer', itemId, answer: { reply: 'fake go ahead', source: 'cli' } });
    expect(records()[1]).toMatchObject({ v: 1, type: 'answer', itemId: otherId, answer: { reply: 'fake pick one', source: 'telegram' } });
    expect(records()[2]).toEqual({ v: 1, type: 'end', outcome: 'complete', pending: [] });
    expect(c.sleeps).toEqual([40]);
  });

  it('exits 3 on timeout with the pending id ordered in the terminal record', async () => {
    expect(resolve(itemId, 'fake go ahead')).toMatchObject({ ok: true });
    const code = await cmdFleetNeedsAnswerFollow(
      [itemId, openId, '--bus-root', busRoot, '--timeout-ms', '30', '--json'],
      { ...clock(), emit: line => { lines.push(line); } });
    expect(code).toBe(3);
    expect(records().at(-1)).toEqual({ v: 1, type: 'end', outcome: 'timeout', pending: [openId] });
    expect(records()[0]).toMatchObject({ type: 'answer', itemId });
  });

  it('exits 1 when the store is unavailable, after the answers already delivered', async () => {
    expect(resolve(itemId, 'fake go ahead')).toMatchObject({ ok: true });
    const read = vi.fn((id: unknown, options?: BusInboxOptions) =>
      id === otherId ? { status: 'unavailable' as const } : readNeedsMasonAnswer(id, options));
    const code = await cmdFleetNeedsAnswerFollow(
      [itemId, otherId, '--bus-root', busRoot, '--timeout-ms', '60000', '--json'],
      { ...clock(), read, emit: line => { lines.push(line); } });
    expect(code).toBe(1);
    expect(records()).toEqual([
      expect.objectContaining({ type: 'answer', itemId }),
      { v: 1, type: 'end', outcome: 'unavailable', pending: [otherId] },
    ]);
  });

  it('cancels on SIGINT with exit 130 and removes its signal handlers', async () => {
    expect(resolve(itemId, 'fake go ahead')).toMatchObject({ ok: true });
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const c = clock(() => process.emit('SIGINT'));
    const code = await cmdFleetNeedsAnswerFollow(
      [itemId, otherId, '--bus-root', busRoot, '--timeout-ms', '60000', '--json'],
      { ...c, emit: line => { lines.push(line); } });
    expect(code).toBe(130);
    expect(records().at(-1)).toEqual({ v: 1, type: 'end', outcome: 'cancelled', pending: [otherId] });
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });

  it.each([
    ['no ids', ['--timeout-ms', '10', '--json']],
    ['duplicate id', [itemId, itemId, '--timeout-ms', '10', '--json']],
    ['too many ids', [...Array.from({ length: NEEDS_ANSWER_FOLLOW_MAX_IDS + 1 }, (_, i) => `nm-${String(i).padStart(12, '0')}`), '--timeout-ms', '10', '--json']],
    ['bad id shape', ['nm-nothex00000', '--timeout-ms', '10', '--json']],
    ['missing --json', [itemId, '--timeout-ms', '10']],
    ['missing --timeout-ms', [itemId, '--json']],
    ['poll without timeout', [itemId, '--poll-ms', '10', '--json']],
    ['duplicate timeout', [itemId, '--timeout-ms', '10', '--timeout-ms', '20', '--json']],
    ['duplicate poll', [itemId, '--timeout-ms', '10', '--poll-ms', '1', '--poll-ms', '2', '--json']],
    ['duplicate bus-root', [itemId, '--bus-root', '/a', '--bus-root', '/b', '--timeout-ms', '10', '--json']],
    ['duplicate --json', [itemId, '--timeout-ms', '10', '--json', '--json']],
    ['zero timeout', [itemId, '--timeout-ms', '0', '--json']],
    ['over max timeout', [itemId, '--timeout-ms', String(NEEDS_ANSWER_FOLLOW_MAX_TIMEOUT_MS + 1), '--json']],
    ['over max poll', [itemId, '--timeout-ms', '10', '--poll-ms', String(NEEDS_ANSWER_FOLLOW_MAX_POLL_MS + 1), '--json']],
    ['non-numeric', [itemId, '--timeout-ms', '1e3', '--json']],
    ['missing value', [itemId, '--timeout-ms']],
    ['unknown flag', [itemId, '--timeout-ms', '10', '--watch', '--json']],
  ])('rejects %s before any read or record', async (_name, flags) => {
    const read = vi.fn(() => ({ status: 'unknown' as const }));
    const code = await cmdFleetNeedsAnswerFollow(flags, { ...clock(), read, emit: line => { lines.push(line); } });
    expect(code).toBe(2);
    expect(read).not.toHaveBeenCalled();
    expect(lines).toHaveLength(0);
    expect(errors.join('')).toContain('Usage: ashlr fleet needs-answer-follow');
  });

  it('keeps newline-bearing reply text inside a single NDJSON record', async () => {
    const reply = 'fake line one\nfake line two\n{"v":1,"type":"end","outcome":"complete","pending":[]}';
    appendBusInbox({ id: `needs-mason-resolved-${itemId}`, from: 'mason', to: 'leaders', priority: 'P1', ttl: 60_000,
      body: { kind: 'needs_mason.resolved', itemId, item: itemText, source: 'cli', reply, resolvedAt: new Date().toISOString() } },
    { root: busRoot });
    const code = await cmdFleetNeedsAnswerFollow(
      [itemId, '--bus-root', busRoot, '--timeout-ms', '10', '--json'],
      { ...clock(), emit: line => { lines.push(line); } });
    expect(code).toBe(0);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect((JSON.parse(line) as { v: number }).v).toBe(1);
    expect((records()[0] as { answer: { reply: string } }).answer.reply).toBe(reply);
    expect(records()[1]).toEqual({ v: 1, type: 'end', outcome: 'complete', pending: [] });
  });

  it('leaves the bus snapshot bytes unchanged', async () => {
    expect(resolve(itemId, 'fake go ahead')).toMatchObject({ ok: true });
    const file = join(busRoot, 'bus-inbox', 'messages.json');
    const before = readFileSync(file, 'utf8');
    const code = await cmdFleetNeedsAnswerFollow(
      [itemId, openId, '--bus-root', busRoot, '--timeout-ms', '30', '--poll-ms', '10', '--json'],
      { ...clock(), emit: line => { lines.push(line); } });
    expect(code).toBe(3);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});
