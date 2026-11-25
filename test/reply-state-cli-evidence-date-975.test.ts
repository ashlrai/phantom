import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdChannelsReplyState } from '../src/cli/channels-reply-state.js';
import { readReplyState } from '../src/core/comms/reply-state.js';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';

let home: string;
let previousHome: string | undefined;
let now: number;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'reply-cli-date-'));
  chmodSync(home, 0o700);
  previousHome = process.env['ASHLR_HOME'];
  process.env['ASHLR_HOME'] = home;
  now = Date.parse('2026-11-14T12:30:00.000Z');
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => {
  if (previousHome === undefined) delete process.env['ASHLR_HOME'];
  else process.env['ASHLR_HOME'] = previousHome;
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

function receipt(id: string, at: string): void {
  const envelope: BusEnvelope = { id, from: 'fake-peer', to: 'fake-lane', priority: 'P2',
    ttl: 1_000_000_000, body: { kind: 'work' } };
  expect(appendBusInbox(envelope, { root: join(home, 'fleet'), now: () => Date.parse(at) }).status).toBe('posted');
}

it('prints the persisted evidence date, unknown for missing evidence, and unchanged JSON', async () => {
  const first = '2026-11-12T12:30:00.000Z';
  const second = '2026-11-13T12:30:00.000Z';
  receipt('fake-first', first);
  receipt('fake-second', second);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const read = async (args: string[]) => {
    log.mockClear();
    expect(await cmdChannelsReplyState(args)).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    return String(log.mock.calls[0]?.[0]);
  };
  const firstText = await read(['fake-first']);
  const secondText = await read(['fake-second']);
  expect(firstText).toContain(`Evidence as of: ${first}`);
  expect(secondText).toContain(`Evidence as of: ${second}`);
  expect(firstText).not.toBe(secondText);
  now += 86_400_000;
  expect(await read(['fake-first'])).toBe(firstText);
  expect(await read(['fake-missing'])).toContain('Evidence as of: unknown');
  const json = await read(['fake-first', '--json']);
  expect(JSON.parse(json)).toEqual(readReplyState('fake-first', { root: join(home, 'fleet'), now }));
});
