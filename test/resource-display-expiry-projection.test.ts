/**
 * Producer-to-display expiry contract. The real account/seat projections read
 * only an empty, disposable accounts root and an inert injected collector.
 * No native collector is created and no provider, session or credential is read.
 * Small temp-directory reads only: no processes, network or durable journals.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceAccountConnection } from '../src/core/resources/connection-types.js';
import type { VerseAccountCollector } from '../src/core/verse/accounts.js';
import { buildSeatTelemetry } from '../src/core/verse/seats.js';
import { nativeSeat } from '../src/web-ui/routes/verse/seat-fixtures.test-support.js';
import { buildCapacityRows } from '../src/web-ui/routes/verse/usage/capacity-strip-model.js';
import { projectResourceDisplay } from '../src/web-ui/routes/verse/resources/resource-display-model.js';

const START = Date.parse('2026-10-13T12:00:00.000Z');
const AT = new Date(START).toISOString();
const PROVIDERS = ['claude', 'codex', 'grok'] as const;
const CREDIT = { hasCredits: true, unlimited: false, balance: '12.5000000001' };
const instant = (offset: number) => new Date(START + offset).toISOString();
let accountsRoot: string;

beforeEach(() => {
  accountsRoot = mkdtempSync(join(tmpdir(), 'phantom-display-expiry-'));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(accountsRoot, { recursive: true, force: true });
});

function connection(provider: ResourceAccountConnection['provider'], ttl: number | null,
  overrides: Partial<ResourceAccountConnection> = {}): ResourceAccountConnection {
  return {
    id: `synthetic-${provider}`, label: `Synthetic ${provider}`, provider,
    state: 'observed', authentication: 'signed-in', health: 'reachable',
    planType: null, observedAt: AT, expiresAt: ttl === null ? null : instant(ttl),
    windows: [{ id: 'weekly', usedPercent: 37, resetsAt: null }],
    reason: 'probe-observed', onDemandEnabled: null, executionSupported: false,
    ...overrides,
  };
}

function collector(account: ResourceAccountConnection): VerseAccountCollector {
  return {
    accountsRoot,
    status: () => ({ mode: 'owned', state: 'running', owner: 'this-server', reasonCode: null,
      pollIntervalMs: 30_000, idleSuspendMs: 300_000, lastPolledAt: AT, lastRequestAt: AT,
      note: 'Synthetic injected fixture; no collection runs.' }),
    touch: () => {},
    connections: () => ({ sampledAt: AT, refreshing: false, accounts: [account] }),
    observations: () => [], unavailableWorkerIds: () => [], credits: () => null,
    close: async () => {},
  };
}

function telemetrySeat(account: ResourceAccountConnection) {
  const telemetry = buildSeatTelemetry(accountsRoot, { collector: collector(account) }).get(account.id);
  expect(telemetry, 'the real account projection must produce the injected account').toBeDefined();
  expect(telemetry!.capacity.evidenceSource).toBe('collector');
  return nativeSeat(telemetry!.capacity, {
    id: account.id, accountId: account.id, engine: account.provider, label: account.label,
    models: [], health: telemetry!.health,
  });
}

function capacityRow(seat: ReturnType<typeof telemetrySeat>, nowMs: number) {
  const rows = buildCapacityRows([seat], { now: nowMs });
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe('actual native telemetry to resource display source deadlines', () => {
  for (const provider of PROVIDERS) {
    for (const ttl of [60_000, 300_000]) {
      it.each([ttl - 1, ttl, ttl + 1])(`${provider} ${ttl / 1000}s source expiry at offset %ims survives capture and rebuilding`, offset => {
        const source = connection(provider, ttl);
        const original = structuredClone(source);
        const seat = telemetrySeat(source);
        const captured = capacityRow(seat, START);
        expect(projectResourceDisplay(captured, { nowMs: START, healthRead: true }).usage.current).toBe(true);

        vi.setSystemTime(START + offset);
        const rebuiltSeat = telemetrySeat(source);
        const rebuilt = capacityRow(rebuiltSeat, START + offset);
        for (const row of [captured, rebuilt]) {
          const display = projectResourceDisplay(row, { nowMs: START + offset, healthRead: true });
          expect(display.usage.current).toBe(offset < ttl);
          expect(display.usage.state).toBe(offset < ttl ? 'current' : 'retained');
          expect(display.usage.freshness).toBe(offset < ttl ? 'current' : 'stale');
          expect(display.usage.observedAt).toBe(AT);
          expect(row.usageObservedAt).toBe(AT);
          expect(row.quotaExpiresAt).toBe(instant(ttl));
          expect(row.windows[0]!.usedPercent).toBe(37);
          if (offset >= ttl) {
            expect(display.status.kind).toBe('not-checked');
            expect(display.status.usableAgain).toBeNull();
          }
        }
        expect(rebuiltSeat.capacity!.observedAt).toBe(AT);
        expect(rebuiltSeat.capacity!.quotaExpiresAt).toBe(instant(ttl));
        expect(source).toEqual(original);
        expect(readdirSync(accountsRoot)).toEqual([]);
      });
    }
  }

  it.each(PROVIDERS)('%s missing original expiry is unconfirmed despite a recent observed meter', provider => {
    const source = connection(provider, null, provider === 'codex' ? { codexCredits: CREDIT } : {});
    const seat = telemetrySeat(source);
    const row = capacityRow(seat, START);
    const display = projectResourceDisplay(row, { nowMs: START, healthRead: true });
    expect(seat.capacity!.quotaExpiresAt).toBeNull();
    expect(row.quotaExpiresAt).toBeNull();
    expect(display.usage).toMatchObject({ current: false, state: 'retained', freshness: 'unconfirmed', observedAt: AT });
    expect(row.windows[0]!.usedPercent).toBe(37);
    expect(display.status.kind).toBe('not-checked');
    expect(display.credit.current).toBe(false);
    expect(seat.capacity!.credits).toBeNull();
    expect(readdirSync(accountsRoot)).toEqual([]);
  });
});

describe('native credits retain their own original source deadline', () => {
  it('accepts a five-minute quota reading without extending native credit qualification to that TTL', () => {
    const source = connection('codex', 300_000, { codexCredits: CREDIT });
    const seat = telemetrySeat(source);
    const row = capacityRow(seat, START);
    const display = projectResourceDisplay(row, { nowMs: START, healthRead: true });
    expect(display.usage.current).toBe(true);
    expect(row.quotaExpiresAt).toBe(instant(300_000));
    expect(seat.capacity!.credits).toBeNull();
    expect(seat.capacity!.creditsExpiresAt).toBeNull();
    expect(display.credit.current).toBe(false);
    expect(source.codexCredits).toEqual(CREDIT);
  });

  it('withholds a separately missing credit deadline while preserving current quota', () => {
    const source = connection('codex', 60_000, { codexCredits: CREDIT });
    const native = telemetrySeat(source);
    // A legacy browser payload may omit only this independently carried field.
    const legacy = { ...native, capacity: { ...native.capacity!, creditsExpiresAt: undefined } };
    const row = capacityRow(legacy, START);
    const display = projectResourceDisplay(row, { nowMs: START, healthRead: true });
    expect(display.usage.current).toBe(true);
    expect(row.quotaExpiresAt).toBe(instant(60_000));
    expect(row.credits).toBeNull();
    expect(display.credit).toEqual({ current: false, observedAt: AT, expiresAt: null });
    expect(display.status.label).not.toBe('Credits available');
    expect(native.capacity!.creditsExpiresAt).toBe(instant(60_000));
  });

  it.each([59_999, 60_000, 60_001])('revokes cached and rebuilt native credit claims at offset %ims', offset => {
    const source = connection('codex', 60_000, { codexCredits: CREDIT });
    const original = structuredClone(source);
    const seat = telemetrySeat(source);
    expect(seat.capacity!.credits).toEqual(CREDIT);
    expect(seat.capacity!.creditsExpiresAt).toBe(instant(60_000));
    const captured = capacityRow(seat, START);
    expect(captured.creditBalance).toBe(CREDIT.balance);
    vi.setSystemTime(START + offset);
    const rebuiltSeat = telemetrySeat(source);
    const rebuilt = capacityRow(rebuiltSeat, START + offset);
    for (const row of [captured, rebuilt]) {
      const display = projectResourceDisplay(row, { nowMs: START + offset, healthRead: true });
      expect(display.credit.current).toBe(offset < 60_000);
      expect(display.credit.observedAt).toBe(AT);
      // Rebuilding after ingress expiry removes the credit signal entirely;
      // a captured row instead retains its original deadline for revalidation.
      expect(display.credit.expiresAt).toBe(row === captured || offset < 60_000 ? instant(60_000) : null);
      if (offset >= 60_000) expect(display.status.label).not.toBe('Credits available');
    }
    expect(captured.creditBalance).toBe(CREDIT.balance);
    expect(captured.creditsExpiresAt).toBe(instant(60_000));
    expect(rebuiltSeat.capacity!.credits).toEqual(offset < 60_000 ? CREDIT : null);
    expect(source).toEqual(original);
    expect(readdirSync(accountsRoot)).toEqual([]);
  });

  it('keeps qualified native credits after quota reset, without claiming current subscription usage', () => {
    const source = connection('codex', 60_000, {
      codexCredits: CREDIT, windows: [{ id: 'weekly', usedPercent: 100, resetsAt: instant(30_000) }],
    });
    const captured = capacityRow(telemetrySeat(source), START);
    vi.setSystemTime(START + 30_000);
    const rebuilt = capacityRow(telemetrySeat(source), START + 30_000);
    for (const row of [captured, rebuilt]) {
      const display = projectResourceDisplay(row, { nowMs: START + 30_000, healthRead: true });
      expect(display.usage).toMatchObject({ current: false, state: 'retained', freshness: 'stale', observedAt: AT });
      expect(display.credit).toEqual({ current: true, observedAt: AT, expiresAt: instant(60_000) });
      expect(display.status.label).toBe('Credits available');
      expect(display.status.usableAgain).toBeNull();
      expect(row.windows[0]!.resetsAt).toBe(instant(30_000));
      expect(row.quotaExpiresAt).toBe(instant(60_000));
    }
  });

  it.each([30_000, 300_000])('does not borrow a separately supplied quota deadline of %ims for native credits', quotaTtl => {
    const source = connection('codex', 60_000, { codexCredits: CREDIT });
    const native = telemetrySeat(source);
    // The native producer currently copies one observation expiry to both
    // signals. The browser contract separately carries these deadlines: this
    // explicit fixture supplies a distinct quota deadline, preserving the
    // native credit timestamp/expiry rather than fabricating producer output.
    const separateQuota = { ...native, capacity: { ...native.capacity!, quotaExpiresAt: instant(quotaTtl) } };
    const captured = capacityRow(separateQuota, START);
    const offset = quotaTtl === 30_000 ? 30_000 : 60_000;
    vi.setSystemTime(START + offset);
    const rebuiltNative = telemetrySeat(source);
    const rebuilt = capacityRow({ ...rebuiltNative,
      capacity: { ...rebuiltNative.capacity!, quotaExpiresAt: instant(quotaTtl) } }, START + offset);
    for (const row of [captured, rebuilt]) {
      const display = projectResourceDisplay(row, { nowMs: START + offset, healthRead: true });
      expect(display.usage.current).toBe(offset < quotaTtl);
      expect(display.credit.current).toBe(offset < 60_000);
      expect(row.quotaExpiresAt).toBe(instant(quotaTtl));
      expect(row.usageObservedAt).toBe(AT);
      if (offset < 60_000) expect(display.status.label).toBe('Credits available');
      else expect(display.status.label).not.toBe('Credits available');
    }
    expect(native.capacity!.quotaExpiresAt).toBe(instant(60_000));
    expect(native.capacity!.creditsExpiresAt).toBe(instant(60_000));
    expect(captured.creditsExpiresAt).toBe(instant(60_000));
    expect(source.expiresAt).toBe(instant(60_000));
  });
});
