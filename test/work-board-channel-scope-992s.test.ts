import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { cmdFleetWorkBoard } from '../src/cli/fleet-work-board.js';

const ref = 'fake-team/fake-channel/fake-thread';
let root: string;
let now: number;
let start: number;

function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const path = join(entry.parentPath, entry.name);
      return [path.slice(root.length), readFileSync(path).toString('base64')];
    }).sort(([a], [b]) => a!.localeCompare(b!)));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'board-channel-992s-'));
  chmodSync(root, 0o700);
  start = now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  for (const [id, channel] of [['slack-old', 'slack'], ['imessage', 'imessage'],
    ['legacy', undefined], ['slack-new', 'slack']] as const) {
    const envelope: BusEnvelope = { id, from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 10_000_000,
      ...(channel === undefined ? {} : { channel, channel_ref: ref,
        sender: { agent_id: 'fake-peer', vendor: 'fake-vendor', human: false, team: true }, external: false }),
      body: { kind: 'work' } };
    expect(appendBusInbox(envelope, { root, now: () => now }).status).toBe('posted');
    now += 1_000;
  }
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('work board channel scope', { timeout: 60_000 }, () => {
  it('filters effective channels and composes filters before the limit without writing', async () => {
    const before = snapshot(root);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const board = async (...args: string[]) => {
      expect(await cmdFleetWorkBoard(['--root', root, ...args, '--json'])).toBe(0);
      return JSON.parse(String(log.mock.calls.at(-1)![0]));
    };
    const all = await board();
    expect(all.items.map((item: { id: string }) => item.id))
      .toEqual(['slack-new', 'legacy', 'imessage', 'slack-old']);
    expect(all.matched).toBeUndefined();
    const slack = await board('--channel', 'slack', '--thread', ref, '--limit', '1');
    expect(slack).toMatchObject({ inbox: 'ok', matched: 2, truncated: true });
    expect(slack.items.map((item: { id: string }) => item.id)).toEqual(['slack-new']);
    const bus = await board('--channel', 'bus');
    expect(bus).toMatchObject({ matched: 1, truncated: false, items: [{ id: 'legacy', channel: 'bus' }] });
    const custom = await board('--channel', 'custom-transport');
    expect(custom).toMatchObject({ matched: 0, items: [] });
    const window = await board('--channel', 'slack', '--thread', ref, '--state', 'RECEIVED',
      '--since', String(start + 1_000), '--before', String(start + 4_000));
    expect(window).toMatchObject({ state: 'RECEIVED', matched: 1, items: [{ id: 'slack-new' }] });
    const excluded = await board('--channel', 'slack', '--state', 'RUNNING');
    expect(excluded).toMatchObject({ matched: 0, items: [] });
    expect(await cmdFleetWorkBoard(['--root', root, '--channel', 'slack', '--limit', '1'])).toBe(0);
    expect(String(log.mock.calls.at(-1)![0])).toContain('items=1 matched=2 truncated=yes');
    expect(snapshot(root)).toEqual(before);
  });

  it('rejects missing, blank and repeated channel flags', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const args of [['--channel'], ['--channel', ''], ['--channel', '  '],
      ['--channel', '--json'], ['--channel', 'slack', '--channel', 'bus']]) {
      expect(await cmdFleetWorkBoard(args)).toBe(2);
    }
  });
});
