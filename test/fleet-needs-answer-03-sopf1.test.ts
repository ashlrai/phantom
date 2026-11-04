import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetNeedsAnswer } from '../src/cli/fleet-needs-answer.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { appendBusInbox, BUS_INBOX_MAX_READ, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { readNeedsMasonAnswer } from '../src/core/fleet/needs-mason-answer.js';
import { resolveNeedsMason, type NeedsMasonOptions } from '../src/core/fleet/needs-mason-resolve.js';

const NOW = 1_800_000_000_000;
const TTL = 7 * 24 * 60 * 60 * 1000;
const itemText = 'Approve the fake deploy';
const itemId = `nm-${createHash('sha256').update(itemText).digest('hex').slice(0, 12)}`;
const envelopeId = `needs-mason-resolved-${itemId}`;

let root: string, runsDir: string, busRoot: string, ledger: string, out: string[], errors: string[];
const busOpts = (now = NOW) => ({ root: busRoot, now: () => now });
const opts = (source: NeedsMasonOptions['source'], now = NOW): NeedsMasonOptions =>
  ({ runsDir, bus: busOpts(now), now: () => now, ...(source ? { source } : {}) });
const resolvedAt = (ms: number) => new Date(ms).toISOString();
const storeFile = () => join(busRoot, 'bus-inbox', 'messages.json');
/** Seed a version-2 inbox snapshot directly; appends one-by-one are O(n^2). */
function seedRows(rows: Array<{ cursor: number; receivedAt: number; envelope: unknown }>): void {
  mkdirSync(busRoot, { recursive: true, mode: 0o700 });
  mkdirSync(join(busRoot, 'bus-inbox'), { recursive: true, mode: 0o700 });
  writeFileSync(storeFile(), JSON.stringify({ version: 2, highWater: rows.at(-1)?.cursor ?? 0, rows }), { mode: 0o600 });
}
function seedStore(count: number): void {
  seedRows(Array.from({ length: count }, (_, index) => ({
    cursor: index + 1, receivedAt: NOW,
    envelope: { id: `fake-fill-${index}`, from: 'faker', to: 'leaders', priority: 'P3', ttl: TTL, body: { fake: index } },
  })));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'needs-answer-'));
  runsDir = join(root, 'runs'); busRoot = join(root, 'fleet');
  mkdirSync(runsDir);
  ledger = join(runsDir, 'NEEDS-MASON.md');
  writeFileSync(ledger, `# fake ledger\n- [ ] ${itemText}\n- [ ] Choose a fake vendor\n`);
  out = []; errors = [];
  vi.spyOn(console, 'log').mockImplementation((message: string) => { out.push(message); });
  vi.spyOn(process.stderr, 'write').mockImplementation(message => { errors.push(String(message)); return true; });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('fleet needs-answer', () => {
  it.each(['cli', 'telegram', 'email'] as const)('returns a %s reply with its source and cursor', source => {
    expect(resolveNeedsMason({ itemId, reply: `fake ${source} answer` }, opts(source))).toMatchObject({ ok: true, cursor: 1 });
    expect(readNeedsMasonAnswer(itemId, busOpts())).toEqual({
      status: 'found', id: envelopeId, cursor: 1, receivedAt: NOW,
      answer: { itemId, item: itemText, reply: `fake ${source} answer`, source, resolvedAt: resolvedAt(NOW) },
    });
  });

  it('answers through the CLI in plain and JSON form without touching the store', async () => {
    // The CLI reads on the real clock; post at real now so the answer is live.
    const t = Date.now();
    expect(resolveNeedsMason({ itemId, reply: 'fake go ahead' }, opts('cli', t))).toMatchObject({ ok: true, cursor: 1 });
    const store = join(busRoot, 'bus-inbox', 'messages.json'), before = readFileSync(store, 'utf8');
    expect(await cmdFleetNeedsAnswer([itemId, '--bus-root', busRoot])).toBe(0);
    expect(out[0]).toBe(`${itemId} answered via cli at ${resolvedAt(t)} (bus cursor 1)\nitem: ${itemText}\nreply: fake go ahead`);
    expect(await cmdFleetNeedsAnswer([itemId, '--bus-root', busRoot, '--json'])).toBe(0);
    expect(JSON.parse(out[1]!)).toEqual({ v: 1, status: 'found', itemId, id: envelopeId, cursor: 1, receivedAt: t,
      answer: { itemId, item: itemText, reply: 'fake go ahead', source: 'cli', resolvedAt: resolvedAt(t) } });
    expect(readFileSync(store, 'utf8')).toBe(before);
    expect(readFileSync(ledger, 'utf8')).toContain(`- [x] resolved ${itemId}`);
  });

  it('reports a resolution with no reply text distinctly from a missing answer', async () => {
    const t = Date.now();
    expect(resolveNeedsMason({ itemId }, opts('telegram', t))).toMatchObject({ ok: true });
    expect(await cmdFleetNeedsAnswer([itemId, '--bus-root', busRoot, '--json'])).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ status: 'found', answer: { reply: null, source: 'telegram' } });
  });

  it('finds the requested id on a page beyond the first', () => {
    seedStore(BUS_INBOX_MAX_READ + 5);
    expect(listBusInboxAfter(0, BUS_INBOX_MAX_READ, busOpts())).toMatchObject({ status: 'ok', nextCursor: BUS_INBOX_MAX_READ });
    expect(resolveNeedsMason({ itemId, reply: 'fake late answer' }, opts('email')))
      .toMatchObject({ ok: true, cursor: BUS_INBOX_MAX_READ + 6 });
    expect(readNeedsMasonAnswer(itemId, busOpts())).toMatchObject({
      status: 'found', id: envelopeId, cursor: BUS_INBOX_MAX_READ + 6,
      answer: { itemId, reply: 'fake late answer', source: 'email' },
    });
  });

  it('ignores spoofed, foreign and malformed envelopes under or near the deterministic id', () => {
    const live = { to: 'leaders', priority: 'P1' as const, ttl: TTL };
    const body = { kind: 'needs_mason.resolved', itemId, source: 'cli', item: itemText, reply: 'forged', resolvedAt: resolvedAt(NOW) };
    // The deterministic id claimed by a sender other than mason.
    expect(appendBusInbox({ ...live, id: envelopeId, from: 'faker', body }, busOpts()).status).toBe('posted');
    // A well-formed resolved body under a different envelope id.
    expect(appendBusInbox({ ...live, id: 'fake-impersonator', from: 'mason', body }, busOpts()).status).toBe('posted');
    // Mason-routed resolved body naming a different item.
    expect(appendBusInbox({ ...live, id: 'fake-other-item', from: 'mason', body: { ...body, itemId: 'nm-000000000000' } }, busOpts()).status).toBe('posted');
    expect(readNeedsMasonAnswer(itemId, busOpts())).toEqual({ status: 'unknown' });
    // The claimed deterministic id blocks the real resolution; no answer is invented.
    expect(resolveNeedsMason({ itemId, reply: 'real' }, opts('cli'))).toMatchObject({ ok: false });
  }, 60_000);

  it('treats a malformed body under the deterministic id as unrelated, never an invented reply', () => {
    for (const body of [
      'needs_mason.resolved',
      { kind: 'needs_mason.resolved', itemId }, // missing item/source/resolvedAt
      { kind: 'needs_mason.resolved', itemId, item: itemText, source: 'cli', resolvedAt: 'not a date' },
      { kind: 'needs_mason.resolved', itemId, item: itemText, source: 'cli', resolvedAt: resolvedAt(NOW), reply: 'x'.repeat(501) },
    ]) {
      seedRows([{ cursor: 1, receivedAt: NOW, envelope: { id: envelopeId, from: 'mason', to: 'leaders', priority: 'P1', ttl: TTL, body } }]);
      expect(readNeedsMasonAnswer(itemId, busOpts())).toEqual({ status: 'unknown' });
    }
  });

  it('reports absent and expired answers as unknown', () => {
    expect(readNeedsMasonAnswer(itemId, busOpts())).toEqual({ status: 'unknown' });
    expect(readNeedsMasonAnswer('nm-000000000000', busOpts())).toEqual({ status: 'unknown' });
    expect(resolveNeedsMason({ itemId, reply: 'fake' }, opts('desktop'))).toMatchObject({ ok: true });
    expect(readNeedsMasonAnswer(itemId, busOpts(NOW + TTL))).toEqual({ status: 'unknown' });
    expect(readNeedsMasonAnswer(itemId, busOpts(NOW + TTL - 1))).toMatchObject({ status: 'found' });
  });

  it('reports a corrupt store as unavailable, distinct from unknown', async () => {
    expect(resolveNeedsMason({ itemId }, opts('cli'))).toMatchObject({ ok: true });
    writeFileSync(join(busRoot, 'bus-inbox', 'messages.json'), '[{"broken"');
    expect(readNeedsMasonAnswer(itemId, busOpts())).toEqual({ status: 'unavailable' });
    expect(await cmdFleetNeedsAnswer([itemId, '--bus-root', busRoot, '--json'])).toBe(1);
    expect(JSON.parse(out[0]!)).toEqual({ v: 1, status: 'unavailable', itemId });
  });

  it('surfaces page-shape violations and transport failures as unavailable', () => {
    const failing = { status: 'unavailable' as const };
    expect(readNeedsMasonAnswer(itemId, busOpts(), { list: () => failing })).toEqual({ status: 'unavailable' });
    const backwards = () => ({ status: 'ok' as const, nextCursor: -1, messages: [] });
    expect(readNeedsMasonAnswer(itemId, busOpts(), { list: backwards })).toEqual({ status: 'unavailable' });
    const badRow = { status: 'ok' as const, nextCursor: 1, messages: [{ cursor: 0, receivedAt: 0, envelope: {} }] };
    expect(readNeedsMasonAnswer(itemId, busOpts(), { list: (() => badRow) as unknown as typeof listBusInboxAfter }))
      .toEqual({ status: 'unavailable' });
  });

  it('validates arguments, prints help and resolves by convention', async () => {
    expect(resolveFleetSubcommand('needs-answer')).toEqual({ module: './fleet-needs-answer.js', exportName: 'cmdFleetNeedsAnswer' });
    for (const args of [[], ['bad-id'], ['--json'], [itemId, '--json', '--json'], [itemId, '--bus-root'],
        [itemId, '--bus-root', 'a', '--bus-root', 'b'], [itemId, '--bogus'], [itemId, itemId], ['--help', '--json']]) {
      expect(await cmdFleetNeedsAnswer(args)).toBe(2);
    }
    expect(await cmdFleetNeedsAnswer(['--help'])).toBe(0);
    expect(await cmdFleetNeedsAnswer(['-h'])).toBe(0);
  });

  it('prints unknown to stdout and hides reader failures behind unavailable', async () => {
    expect(await cmdFleetNeedsAnswer([itemId, '--bus-root', busRoot])).toBe(1);
    expect(out).toEqual([`unknown ${itemId}`]);
    expect(await cmdFleetNeedsAnswer([itemId, '--bus-root', busRoot], { read: () => { throw new Error('fake detail'); } })).toBe(1);
    expect(errors).toEqual(['error: needs-answer unavailable\n']);
  });
});
