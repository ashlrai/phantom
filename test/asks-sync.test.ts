/** Fixture tests for `phm asks sync` (asks.sync.v1): synthetic ledger rows in a temp runs dir, no real home. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdAsks } from '../src/cli/asks.js';
import { answerAsk, listAsks, type AsksOptions } from '../src/core/fleet/asks.js';
import { readCreditDecision } from '../src/core/fleet/asks-ledger.js';
import { readResourceLedger } from '../src/core/fleet/runs-resource-ledger.js';
import { ASKS_SYNC_SCHEMA, syncAsks, type SyncInputs } from '../src/core/fleet/asks-sync.js';
import { buildPoolsView, monthDay } from '../src/core/fleet/pools-view.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';

const NOW = Date.parse('2026-11-19T22:00:00.000Z');
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const lane = (name: string, patch: Partial<ResourceLaneRow> = {}): ResourceLaneRow => ({
  lane: name, running: 1, target: 2, held: false, window: 'weekly', usedPct: 50, creditsRemaining: null, resetAt: at(5),
  burnPctPerHour: 0.1, tokensPerHour6h: null, projectedExhaustion: null, source: null, deadSignal: null,
  observation: { source: 'claude-native-usage', asOf: at(-0.1) }, ...patch,
});
const inputs = (rows: ResourceLaneRow[], heldReasons: Record<string, string | null> | null = { gemini: 'needs sign-in' }, readable = true): SyncInputs => ({
  view: buildPoolsView({
    v: 1, generatedAt: at(0), sources: { status: 'healthy', apiSpend: 'missing', jobs: 'missing' }, asOf: at(0), lanes: rows, apiSpend: null, jobsMalformedRows: null,
  } satisfies ResourceLedgerV1, NOW),
  ledgerReadable: readable, heldReasons,
});
const signedOut = lane('gemini', { usedPct: 12, held: true, resetAt: at(30) });
const credit = lane('claude-api-credit', { window: 'credits', usedPct: null, creditsRemaining: 40, target: 0, running: 0, resetAt: at(48), observation: undefined });

let dir = '';
let opts: Required<Pick<AsksOptions, 'runsDir' | 'bus' | 'now'>>;
const run = (state: SyncInputs, extra: { dryRun?: boolean } = {}) => syncAsks({ ...opts, ...extra, read: async () => state });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'asks-sync-'));
  mkdirSync(join(dir, 'runs'));
  writeFileSync(join(dir, 'runs', 'NEEDS-MASON.md'), '');
  opts = { runsDir: join(dir, 'runs'), bus: { root: join(dir, 'fleet'), now: () => NOW }, now: () => NOW };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('syncAsks', () => {
  it('raises one sign-in ask with the pool reset as its expiry, and nothing on a second run', async () => {
    const first = await run(inputs([signedOut]), {});
    expect(first).toMatchObject({ schema: ASKS_SYNC_SCHEMA, status: 'ok', dryRun: false, kept: [], resolved: [] });
    expect(first.raised).toHaveLength(1);
    const asks = listAsks(opts).asks;
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ kind: 'signin', subject: 'gemini', replies: ['done', 'later'], expires: at(30) });
    expect(asks[0]!.request).toMatch(/^Sign in to Gemini once/);
    const second = await run(inputs([signedOut]));
    expect(second.raised).toEqual([]);
    expect(second.kept).toHaveLength(1);
    expect(listAsks(opts).asks).toHaveLength(1);
  });

  it('raises one payment ask for a credit that ends unused with its lane at zero', async () => {
    const sync = await run(inputs([credit]));
    expect(sync.raised).toMatchObject([{ pool: 'claude-api-credit', kind: 'payment', replies: ['yes', 'no'], expires: at(48) }]);
    expect(listAsks(opts).asks[0]).toMatchObject({ kind: 'payment', subject: 'claude-api-credit', expires: at(48) });
    expect((await run(inputs([credit]))).raised).toEqual([]);
    expect(listAsks(opts).asks).toHaveLength(1);
  });

  it('leaves a credit alone while its lane still runs, and when the balance is empty', async () => {
    expect((await run(inputs([{ ...credit, target: 2 }]))).raised).toEqual([]);
    expect((await run(inputs([{ ...credit, creditsRemaining: 0 }]))).raised).toEqual([]);
    expect(listAsks(opts).count).toBe(0);
  });

  it('resolves the ask when the verdict clears, and leaves hand-raised asks alone', async () => {
    writeFileSync(join(opts.runsDir, 'NEEDS-MASON.md'), `- [ ] ask:password@gemini Hand-raised: type the gemini password (asked ${at(-1)})\n`);
    await run(inputs([signedOut]));
    await run(inputs([credit, signedOut]));
    expect(listAsks(opts).count).toBe(3);
    const cleared = await run(inputs([{ ...signedOut, held: false }, { ...credit, target: 2 }]));
    expect(cleared.resolved.map(item => item.kind).sort()).toEqual(['payment', 'signin']);
    expect(listAsks(opts).asks.map(ask => ask.request)).toEqual([expect.stringMatching(/^Hand-raised/)]);
    expect((await run(inputs([{ ...signedOut, held: false }, { ...credit, target: 2 }]))).resolved).toEqual([]);
  });

  it('reports an unreadable ledger or unreadable held lanes as unknown and invents or closes nothing', async () => {
    await run(inputs([signedOut]));
    const blind = await run(inputs([], null, false));
    expect(blind).toMatchObject({ status: 'unknown', raised: [], resolved: [] });
    expect(blind.reason).toMatch(/missing or degraded/);
    const noHeld = await run(inputs([signedOut], null));
    expect(noHeld.status).toBe('ok');
    expect(noHeld.unknown[0]).toMatchObject({ pool: '*' });
    expect(noHeld.resolved).toEqual([]);
    expect(listAsks(opts).count).toBe(1);
    const thrown = await syncAsks({ ...opts, read: async () => { throw new Error('boom'); } });
    expect(thrown.status).toBe('unknown');
  });

  it('shows an unreported credit as unknown, not as an ask', async () => {
    const sync = await run(inputs([{ ...credit, creditsRemaining: null }]));
    expect(sync.raised).toEqual([]);
    expect(sync.unknown).toEqual([{ pool: 'claude-api-credit', reason: 'credit balance, expiry or lane target is not reported' }]);
  });

  it('a dry run writes nothing', async () => {
    const sync = await run(inputs([signedOut, credit]), { dryRun: true });
    expect(sync).toMatchObject({ dryRun: true });
    expect(sync.raised).toHaveLength(2);
    expect(sync.raised.every(item => item.askId === null)).toBe(true);
    expect(listAsks(opts).count).toBe(0);
  });
});

describe('phm asks sync', () => {
  it('prints asks.sync.v1 with --json and plain words without, and refuses other arguments', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sync = (extra: Partial<Parameters<typeof syncAsks>[0]>) => syncAsks({ ...opts, ...extra, read: async () => inputs([signedOut]) });
    expect(await cmdAsks(['sync', '--dry-run', '--json'], { options: opts, sync })).toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ schema: 'asks.sync.v1', dryRun: true, status: 'ok' });
    expect(await cmdAsks(['sync'], { options: opts, sync })).toBe(0);
    expect(log.mock.calls[1]![0]).toMatch(/^Raised: Sign in to Gemini once/);
    expect(await cmdAsks(['sync', '--bogus'], { options: opts, sync })).toBe(2);
    expect(await cmdAsks(['sync'], { options: opts, sync: async () => syncAsks({ ...opts, read: async () => inputs([], null, false) }) })).toBe(1);
    expect(log.mock.calls[2]![0]).toMatch(/^Asks: unknown\./);
    log.mockRestore(); err.mockRestore();
  });
});

describe('Claude API gift credit', () => {
  const EXPIRES = '2026-11-24T23:59:00.000Z';
  const statusOf = (gift: Record<string, unknown>, target = 0) => JSON.stringify({
    schema: 'dispatchd.status.v1', last_tick: at(0), lanes: { 'claude-api': { running: 0, target } }, budget: { 'claude-api': gift },
  });
  const read = async (status: string): Promise<SyncInputs> => {
    const runs = join(dir, 'status-runs');
    mkdirSync(join(runs, 'queue'), { recursive: true });
    writeFileSync(join(runs, 'queue', 'status.json'), status);
    const ledger = await readResourceLedger({ runsDir: runs, now: () => NOW, personalCodexHome: join(dir, 'none') });
    return { view: buildPoolsView(ledger, NOW), ledgerReadable: true, heldReasons: {} };
  };

  it('raises one credit ask that states the balance, unit and expiry, and nothing on a re-run', async () => {
    const state = await read(statusOf({ pools: { gift: { balance: 112.4, expires_at: EXPIRES, open: true } } }));
    const first = await run(state);
    expect(first.raised).toHaveLength(1);
    const ask = listAsks(opts).asks[0]!;
    expect(ask).toMatchObject({ kind: 'payment', subject: 'claude-api', replies: ['yes', 'no'], expires: EXPIRES });
    expect(ask.request).toBe('About 112 USD of Claude API credit expires Nov 24. Use it? yes / no');
    const again = await run(state);
    expect(again.raised).toEqual([]);
    expect(again.kept).toHaveLength(1);
    expect(listAsks(opts).count).toBe(1);
  });

  it('reads the typed gift block too', async () => {
    const state = await read(statusOf({ gift: { usd_remaining: 50, as_of: at(-1), expires_at: EXPIRES } }));
    expect((await run(state)).raised[0]!.text).toBe('About 50 USD of Claude API credit expires Nov 24. Use it? yes / no');
  });

  it('a closed lane with a stale balance still raises the ask and names the reading date', async () => {
    // The live shape: balance and open under pools.gift, the reading date under gift.
    const state = await read(statusOf({ gift: { as_of: at(-30), expires_at: EXPIRES }, pools: { gift: { balance: 112, expires_at: EXPIRES, open: false } } }, 2));
    const sync = await run(state);
    expect(sync.unknown).toEqual([]);
    expect(sync.raised).toHaveLength(1);
    const text = sync.raised[0]!.text;
    expect(text).toBe(`Last reading ${monthDay(at(-30))}: about 112 USD of Claude API credit expires Nov 24 and its lane is closed. Use it? yes / no`);
  });

  it('raises no ask while the lane is open and running, or once the credit has expired', async () => {
    expect((await run(await read(statusOf({ pools: { gift: { balance: 112, expires_at: EXPIRES, open: true } } }, 2)))).raised).toEqual([]);
    const past = at(-2);
    const gone = await run(await read(statusOf({ gift: { usd_remaining: 112, as_of: at(-30), expires_at: past } })));
    expect(gone.raised).toEqual([]);
    expect(gone.unknown).toEqual([{ pool: 'claude-api', reason: expect.stringMatching(/balance .* unknown/) }]);
  });

  it('a missing balance is unknown and names the field, never 0', async () => {
    const sync = await run(await read(statusOf({ gift: { as_of: at(-1), expires_at: EXPIRES } })));
    expect(sync.raised).toEqual([]);
    expect(sync.unknown[0]!.reason).toMatch(/^Claude API credit balance .* unknown, so no ask was raised$/);
    const ledger = await readResourceLedger({ runsDir: join(dir, 'status-runs'), now: () => NOW, personalCodexHome: join(dir, 'none') });
    expect(ledger.lanes.find(l => l.lane === 'claude-api')!.creditsRemaining).toBeNull();
  });

  it('the pools view shows balance, reading date and days to expiry for a gift row', async () => {
    const state = await read(statusOf({ gift: { as_of: at(-30), expires_at: EXPIRES }, pools: { gift: { balance: 112, expires_at: EXPIRES, open: false } } }));
    const row = state.view.pools.find(p => p.id === 'claude-api')!;
    expect(row).toMatchObject({ creditsRemaining: 112, creditAsOf: at(-30), creditClosed: true, daysLeft: expect.any(Number) });
    expect(row.summary).toMatch(/^Claude API: last reading Nov \d+: about 112 USD; expires in \d+ days? \(Nov 24\); lane closed$/);
    expect(row.reason).not.toMatch(/percent used is not known/);
  });

  it('records a yes reply as a typed decision and changes nothing else', async () => {
    await run(await read(statusOf({ pools: { gift: { balance: 112, expires_at: EXPIRES, open: true } } })));
    const ask = listAsks(opts).asks[0]!;
    expect(await answerAsk(ask.shortId, 'yes', 'cli', opts)).toMatchObject({ status: 'answered', answer: 'yes' });
    expect(readCreditDecision('claude-api', { runsDir: opts.runsDir })).toMatchObject({ pool: 'claude-api', decision: 'yes', askId: ask.id });
    expect(readCreditDecision('gemini', { runsDir: opts.runsDir })).toBeNull();
  });
});

describe('sign-in kind', () => {
  it('reports a sync-raised sign-in ask as signin, and leaves a hand-raised password ask a password', async () => {
    writeFileSync(join(opts.runsDir, 'NEEDS-MASON.md'), `- [ ] ask:password@grok Hand-raised: type the grok password (asked ${at(-1)})\n`);
    await run(inputs([signedOut]));
    const kinds = Object.fromEntries(listAsks(opts).asks.map(ask => [ask.subject, ask.kind]));
    expect(kinds).toEqual({ grok: 'password', gemini: 'signin' });
    // The alias does not hide the ask from sync: a second run keeps it, a cleared verdict closes it.
    expect((await run(inputs([signedOut]))).kept).toHaveLength(1);
    expect((await run(inputs([{ ...signedOut, held: false }]))).resolved.map(i => i.kind)).toEqual(['signin']);
  });
});
