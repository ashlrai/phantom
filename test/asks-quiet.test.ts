import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdAsks } from '../src/cli/asks.js';
import { askTypeOf, listAsks, onlyMasonAsks, raiseAsk, type AsksOptions } from '../src/core/fleet/asks.js';
import { listAskBatch } from '../src/core/fleet/asks-batch.js';
import { readFleetActions } from '../src/core/fleet/asks-ledger.js';
import { listAskBatchAll, raiseAskOrRead, readUsageSensor } from '../src/core/fleet/asks-sensor.js';
import type { UsageReading } from '../src/core/fleet/usage-history.js';

const NOW = Date.parse('2026-11-20T23:00:00.000Z');
let home = '';
let opts: Required<Pick<AsksOptions, 'runsDir' | 'bus' | 'now'>>;
const reading = (over: Partial<UsageReading> = {}): UsageReading =>
  ({ pool: 'claude-max', used_pct: 12, observed_at: '2026-11-20T22:30:00.000Z', reset_at: '2026-11-21T04:00:00.000Z', source: 'claude-status-line', ...over });
const sensor = (rows: UsageReading[]) => ({ readSamples: async () => rows });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'example-quiet-'));
  mkdirSync(join(home, 'runs'));
  opts = { runsDir: join(home, 'runs'), bus: { root: join(home, 'fleet'), now: () => NOW }, now: () => NOW };
  writeFileSync(join(opts.runsDir, 'NEEDS-MASON.md'), '# Needs Mason\n');
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); });

const seed = () => {
  raiseAsk('password', 'Unlock the example vault on the studio laptop', opts);
  raiseAsk('2fa', 'Type the example sign-in code from the phone', opts);
  raiseAsk('device', 'Approve the example laptop on the account page', opts);
  raiseAsk('payment', 'Top up the example plan by ten dollars', opts);
  raiseAsk('outreach', 'Send the example thank-you note to the vendor', opts);
  raiseAsk('approval', 'Record a yes for the example credit', opts);
  raiseAsk('usage', 'What percent of the claude plan is used?', opts, { subject: 'claude-max' });
};

describe('ask types', () => {
  it('gives every kind one of the five types', () => {
    expect([askTypeOf('password'), askTypeOf('signin'), askTypeOf('2fa'), askTypeOf('device'), askTypeOf('payment')])
      .toEqual(['password', 'password', 'two-factor', 'device-approval', 'payment']);
    expect([askTypeOf('outreach'), askTypeOf('usage'), askTypeOf('approval')]).toEqual(['other', 'other', 'other']);
    seed();
    expect(listAsks(opts).asks.map(ask => ask.type)).toEqual(['password', 'two-factor', 'device-approval', 'payment', 'other', 'other', 'other']);
  });

  it('shows only the four types by default and counts the rest', () => {
    seed();
    const list = onlyMasonAsks(listAsks(opts));
    expect(list.asks.map(ask => ask.type)).toEqual(['password', 'two-factor', 'device-approval', 'payment']);
    expect(list.otherHidden).toBe(3);
    const batch = listAskBatch(opts);
    expect(batch.asks.map(ask => ask.type)).toEqual(['password', 'two-factor', 'device-approval', 'payment']);
    expect(batch.otherHidden).toBe(3);
  });

  it('the phone batch and phm asks list agree, and --all adds the rest with what the fleet did', async () => {
    seed();
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    expect(await cmdAsks(['list', '--json'], { options: opts })).toBe(0);
    expect(JSON.parse(lines[0]!)).toEqual(JSON.parse(JSON.stringify(listAskBatch(opts))));
    expect(await cmdAsks(['list'], { options: opts })).toBe(0);
    expect(lines[1]).toContain('3 more the fleet handles: phm asks list --all');
    expect(lines[1]).not.toContain('Send the example thank-you note');
    expect(await cmdAsks(['list', '--all'], { options: opts, batchAll: o => listAskBatchAll(o, sensor([reading()])) })).toBe(0);
    expect(lines[2]).toContain('Send the example thank-you note');
    expect(lines[2]).toContain('Fleet did instead: Waiting: nothing was sent to the outside person.');
    expect(lines[2]).toContain('Fleet did instead: read from sensor claude-status-line at 2026-11-20T22:30:00.000Z');
  });
});

describe('a usage reading is not an ask', () => {
  it('uses the sensor reading and records the action instead of raising an ask', async () => {
    const out = await raiseAskOrRead('usage', 'A fresh reading of the claude plan, please', opts, { subject: 'claude-max' }, sensor([reading()]));
    expect(out).toMatchObject({ ok: true, handled: true, id: null });
    expect((out as { action: string }).action).toContain('read from sensor claude-status-line at 2026-11-20T22:30:00.000Z');
    expect((out as { action: string }).action).toContain('claude-max is 12% used, resets 2026-11-21T04:00:00.000Z');
    expect(listAsks(opts).count).toBe(0);
    expect(readFleetActions({ runsDir: opts.runsDir })).toHaveLength(1);
    const all = await listAskBatchAll(opts, sensor([reading()]));
    expect(all.count).toBe(0);
    expect(all.fleetHandled?.[0]).toMatchObject({ question: 'A fresh reading of the claude plan, please', at: '2026-11-20T23:00:00.000Z' });
    expect(all.fleetHandled?.[0]?.fleetDid).toMatch(/^read from sensor claude-status-line at /);
  });

  it('phm asks add does the same, and says so in plain words', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    const raise = (...args: Parameters<typeof raiseAsk>) => raiseAskOrRead(...args, sensor([reading()]));
    expect(await cmdAsks(['add', 'usage', 'A fresh reading of the claude plan, please', '--subject', 'claude-max'], { options: opts, raise })).toBe(0);
    expect(lines[0]).toMatch(/^Not asked: the fleet read from sensor claude-status-line at /);
    expect(listAsks(opts).count).toBe(0);
  });

  it('raises the ask when no sensor has a fresh reading', async () => {
    for (const rows of [[], [reading({ observed_at: '2026-11-20T10:00:00.000Z' })], [reading({ pool: 'grok-ultra' })]]) {
      expect(await readUsageSensor('claude-max', opts, sensor(rows))).toBeNull();
    }
    const out = await raiseAskOrRead('usage', 'What percent of the claude plan is used?', opts, { subject: 'claude-max' }, sensor([]));
    expect(out).toMatchObject({ ok: true, duplicate: false });
    expect(listAsks(opts).asks[0]).toMatchObject({ kind: 'usage', type: 'other' });
    expect(readFleetActions({ runsDir: opts.runsDir })).toHaveLength(0);
  });

  it('shows an open usage ask in --all with the reading the sensor has now', async () => {
    raiseAsk('usage', 'What percent of the claude plan is used?', opts, { subject: 'claude-max' });
    const all = await listAskBatchAll(opts, sensor([reading({ used_pct: 30 })]));
    expect(all.asks[0]).toMatchObject({ type: 'other', fleetDid: expect.stringContaining('read from sensor claude-status-line at ') });
    expect(all.asks[0]!.fleetDid).toContain('30% used');
  });

  it('never answers a password ask from a sensor', async () => {
    const out = await raiseAskOrRead('password', 'Unlock the example vault on the studio laptop', opts, {}, sensor([reading()]));
    expect(out).toMatchObject({ ok: true, duplicate: false });
    expect(listAsks(opts).asks[0]!.type).toBe('password');
  });
});
