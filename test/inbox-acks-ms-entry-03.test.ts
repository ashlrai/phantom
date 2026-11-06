import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetInboxAcks } from '../src/cli/fleet-inbox-acks.js';
import { INBOX_CHANNEL_LINE } from '../src/core/fleet/inbox-channel-line.js';
import type { InboxAck } from '../src/core/fleet/inbox-ack.js';

// appendInboxEntry writes toISOString() output, which always carries milliseconds.
const LEGACY = '## 2026-11-01 18:09 ET (Mason, relayed) PRIORITY P0\nlegacy order text';
const D1 = '2026-11-02T23:51:29.123Z [src:desktop id:desk-0123456789abcdef] first desktop order';
const D2 = '2026-11-02T23:52:07.456Z [src:desktop id:desk-fedcba9876543210] second desktop order';

let runs: string;
let out: string[];

const run = async (args: string[], senders?: Record<string, (ack: InboxAck) => Promise<void>>): Promise<number> =>
  cmdFleetInboxAcks(['--runs-dir', runs, ...args], { senders });
const json = (): { entries: Array<{ entryId: string; channel: string | null; state: string }>; totals: Record<string, number> } =>
  JSON.parse(out.at(-1)!);

beforeEach(() => {
  runs = mkdtempSync(join(tmpdir(), 'inbox-acks-ms-'));
  mkdirSync(join(runs, 'leader'), { recursive: true });
  writeFileSync(join(runs, 'leader', 'MASON-INBOX.md'), `${[LEGACY, D1, D2].join('\n')}\n`);
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); rmSync(runs, { recursive: true, force: true }); });

describe('fleet inbox-acks with millisecond desktop entries', () => {
  it('splits each millisecond desktop line into its own pending entry', async () => {
    expect(await run(['--json'])).toBe(0);
    const parsed = json();
    expect(parsed.entries).toHaveLength(3);
    expect(parsed.entries[0]).toMatchObject({ channel: null, state: 'no-channel' });
    expect(parsed.entries[1]).toMatchObject({ entryId: 'desk-0123456789abcdef', channel: 'desktop', state: 'pending' });
    expect(parsed.entries[2]).toMatchObject({ entryId: 'desk-fedcba9876543210', channel: 'desktop', state: 'pending' });
    expect(parsed.totals).toEqual({ acked: 0, skipped: 0, pending: 2, noChannel: 1 });
  });

  it('flush acks both desktop entries and the next json reports them acked', async () => {
    const desktop = vi.fn(async (_ack: InboxAck) => {});
    expect(await run(['--flush'], { desktop })).toBe(0);
    expect(desktop).toHaveBeenCalledTimes(2);
    expect(desktop.mock.calls.map(c => c[0].entryId)).toEqual(['desk-0123456789abcdef', 'desk-fedcba9876543210']);
    expect(desktop.mock.calls[0]![0].text).toContain('first desktop order');

    await run(['--json']);
    const parsed = json();
    expect(parsed.entries.slice(1).map(e => e.state)).toEqual(['acked', 'acked']);
    expect(parsed.totals).toEqual({ acked: 2, skipped: 0, pending: 0, noChannel: 1 });
  });
});

describe('INBOX_CHANNEL_LINE', () => {
  it('matches channel lines with and without fractional seconds', () => {
    expect(INBOX_CHANNEL_LINE.test(D1)).toBe(true);
    expect(INBOX_CHANNEL_LINE.test('2026-11-02T23:51Z [src:desktop] text')).toBe(true);
    expect(INBOX_CHANNEL_LINE.test('2026-11-02T23:51:29Z [src:desktop id:desk-1] text')).toBe(true);
  });

  it('rejects a timestamp line without a src tag', () => {
    expect(INBOX_CHANNEL_LINE.test('2026-11-02T23:51:29.123Z text')).toBe(false);
  });
});
