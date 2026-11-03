import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetInboxAcks } from '../src/cli/fleet-inbox-acks.js';
import type { InboxAck } from '../src/core/fleet/inbox-ack.js';

const LEGACY = '## 2026-11-01 18:06 ET (Mason, relayed) PRIORITY P0\nplain legacy order text';
const A = '2026-11-02T00:27:30-0500 [src:desktop id:fake-a] hello';
const B = '2026-11-02T00:28:30-0500 [src:telegram id:fake-b] please report status on the fake fleet';

let runs: string;
let out: string[];
let err: string[];

const ledgerPath = (): string => join(runs, 'queue', 'inbox-acks.jsonl');
const writeInbox = (...entries: string[]): void => {
  mkdirSync(join(runs, 'leader'), { recursive: true });
  writeFileSync(join(runs, 'leader', 'MASON-INBOX.md'), `${entries.join('\n')}\n`);
};
const writeLedger = (...lines: string[]): void => {
  mkdirSync(join(runs, 'queue'), { recursive: true });
  writeFileSync(ledgerPath(), `${lines.join('\n')}\n`);
};
const run = async (args: string[], senders?: Record<string, (ack: InboxAck) => Promise<void>>): Promise<number> =>
  cmdFleetInboxAcks(['--runs-dir', runs, ...args], { senders });

beforeEach(() => {
  runs = mkdtempSync(join(tmpdir(), 'inbox-acks-'));
  out = []; err = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(runs, { recursive: true, force: true }); });

describe('fleet inbox-acks', () => {
  it('reports acked, pending and no-channel with totals', async () => {
    writeInbox(LEGACY, A, B);
    writeLedger(JSON.stringify({ entryId: 'fake-a', status: 'acked' }));
    expect(await run([])).toBe(0);
    expect(out[0]).toMatch(/^no-channel {2}- {2}\S{12} {2}## 2026-11-01/);
    expect(out[1]).toMatch(/^acked {2}desktop {2}fake-a {2}hello$/);
    expect(out[2]).toMatch(/^pending {2}telegram {2}fake-b {2}please report status/);
    expect(out[3]).toBe('Totals: 1 acked, 0 skipped, 1 pending, 1 no-channel');
  });

  it('prints json without bodies and truncates plain previews to 60 chars', async () => {
    const long = `2026-11-02T00:29:30-0500 [src:phone id:fake-c] ${'word '.repeat(30)}TAILMARKER`;
    writeInbox(LEGACY, A, long);
    writeLedger(JSON.stringify({ entryId: 'fake-a', status: 'skipped', reason: 'channel has no sender' }));
    await run(['--json']);
    const json = JSON.parse(out[0]!);
    expect(Object.keys(json).sort()).toEqual(['entries', 'generatedAt', 'malformedLedgerRows', 'totals', 'v']);
    expect(json.v).toBe(1);
    expect(json.totals).toEqual({ acked: 0, skipped: 1, pending: 1, noChannel: 1 });
    expect(json.entries[1]).toEqual({ entryId: 'fake-a', channel: 'desktop', state: 'skipped', reason: 'channel has no sender' });
    expect(out[0]).not.toContain('TAILMARKER');
    expect(out[0]).not.toContain('plain legacy');
    out.length = 0;
    await run([]);
    expect(out.join('\n')).not.toContain('TAILMARKER');
    expect(out[2]!.split('  ')[3]!.length).toBeLessThanOrEqual(60);
  });

  it('flush sends the pending entry once and a second flush sends nothing', async () => {
    writeInbox(LEGACY, A, B);
    writeLedger(JSON.stringify({ entryId: 'fake-a', status: 'acked' }));
    const telegram = vi.fn(async (_ack: InboxAck) => {});
    const desktop = vi.fn(async (_ack: InboxAck) => {});
    await run(['--flush'], { telegram, desktop });
    expect(telegram).toHaveBeenCalledTimes(1);
    expect(telegram.mock.calls[0]![0].entryId).toBe('fake-b');
    expect(desktop).not.toHaveBeenCalled();
    expect(out.at(-1)).toMatch(/^Totals: 2 acked, 0 skipped, 0 pending, 1 no-channel/);
    await run(['--flush'], { telegram, desktop });
    expect(telegram).toHaveBeenCalledTimes(1);
  });

  it('keeps the entry pending when a sender throws', async () => {
    writeInbox(B);
    const telegram = vi.fn(async (_ack: InboxAck) => { throw new Error('down'); });
    expect(await run(['--flush'], { telegram })).toBe(0);
    expect(out.at(-1)).toMatch(/1 pending/);
    telegram.mockImplementation(async () => {});
    await run(['--flush'], { telegram });
    expect(telegram).toHaveBeenCalledTimes(2);
    expect(out.at(-1)).toMatch(/1 acked, 0 skipped, 0 pending/);
  });

  it('counts malformed ledger rows and tolerates a missing inbox', async () => {
    writeInbox(A);
    writeLedger('{not json', JSON.stringify({ entryId: 'fake-a', status: 'acked' }));
    expect(await run(['--json'])).toBe(0);
    expect(JSON.parse(out[0]!).malformedLedgerRows).toBe(1);
    expect(JSON.parse(out[0]!).totals.acked).toBe(1);

    rmSync(join(runs, 'leader'), { recursive: true });
    rmSync(ledgerPath());
    out.length = 0;
    expect(await run([])).toBe(0);
    expect(out).toEqual(['Totals: 0 acked, 0 skipped, 0 pending, 0 no-channel']);
  });

  it('honors --limit and exits 2 on bad arguments', async () => {
    writeInbox(LEGACY, A, B);
    await run(['--limit', '1', '--json']);
    expect(JSON.parse(out[0]!).entries.map((e: { entryId: string }) => e.entryId)).toEqual(['fake-b']);
    for (const bad of [['--limit', '0'], ['--limit', '201'], ['--limit'], ['--bogus'], ['--json', '--json']]) {
      err.length = 0;
      expect(await run(bad)).toBe(2);
      expect(err).toHaveLength(1);
    }
    expect(readFileSync(join(runs, 'leader', 'MASON-INBOX.md'), 'utf8')).toContain('fake-a');
  });
});
