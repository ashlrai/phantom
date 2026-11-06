import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdResourcePersonalUsage } from '../src/cli/resource-personal-usage.js';
import { readResourceLedger } from '../src/core/fleet/runs-resource-ledger.js';

describe('personal account usage provenance', () => {
  let root: string;
  let personalHome: string;
  let runsDir: string;
  let now: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'personal-usage-contract-'));
    personalHome = join(root, '.codex-2');
    runsDir = join(root, 'runs');
    mkdirSync(personalHome, { recursive: true });
    now = Date.now();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function writeSession(observedMs: number, weeklyUsed: number): string {
    const observedAt = new Date(observedMs).toISOString();
    const dir = join(personalHome, 'sessions', '2026', '10', '31');
    mkdirSync(dir, { recursive: true });
    const row = {
      timestamp: observedAt,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          plan_type: 'plus',
          primary: { used_percent: 12, window_minutes: 300, resets_at: Math.floor((now + 3_600_000) / 1000) },
          secondary: { used_percent: weeklyUsed, window_minutes: 10080, resets_at: Math.floor((now + 3 * 86_400_000) / 1000) },
        },
      },
    };
    writeFileSync(join(dir, 'rollout-fake.jsonl'), `${JSON.stringify(row)}\n`);
    return observedAt;
  }

  function writeStatus(statusMs: number): string {
    const asOf = new Date(statusMs).toISOString();
    const dir = join(runsDir, 'queue');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'status.json'), JSON.stringify({
      last_tick: asOf,
      lanes: { 'codex-personal': { running: 1, target: 2, held: false } },
      budget: { 'codex-personal': { weekly_used_pct: 99, source: 'dispatchd-status' } },
    }));
    return asOf;
  }

  function command(json: boolean): { code: number; output: string } {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = cmdResourcePersonalUsage({ json, home: personalHome });
      return { code, output: log.mock.calls.map(args => args.join(' ')).join('\n') };
    } finally {
      log.mockRestore();
    }
  }

  async function ledger() {
    return readResourceLedger({ runsDir, personalCodexHome: personalHome, now: () => now });
  }

  it('uses a newer personal session for the command and ledger despite conflicting status', async () => {
    const observedAt = writeSession(now - 60_000, 37);
    writeStatus(now - 120_000);
    const result = command(true);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.output);
    expect(report).toMatchObject({
      v: 'resource.v1',
      resources: [{ id: 'codex-personal', slot: 'secondary', state: 'current', observedAt,
        session: { usedPct: 12 }, weekly: { usedPct: 37, burnPctPerHour: null } }],
    });
    const text = command(false);
    expect(text.code).toBe(0);
    expect(text.output).toContain('Weekly: 37% used');
    expect(text.output).toContain('Weekly measured burn: unknown');
    expect(text.output).not.toContain('99%');

    const resultLedger = await ledger();
    expect(resultLedger.sources.status).toBe('healthy');
    expect(resultLedger.lanes).toContainEqual(expect.objectContaining({
      lane: 'codex-personal', usedPct: 37, source: 'codex-personal-sessions',
      observation: { source: 'codex-personal-sessions', asOf: observedAt },
    }));
  });

  it('exposes the actual status provenance when a newer status disagrees with the session', async () => {
    const observedAt = writeSession(now - 120_000, 37);
    const statusAt = writeStatus(now - 60_000);
    const result = command(true);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output).resources[0]).toMatchObject({
      id: 'codex-personal', state: 'current', observedAt, weekly: { usedPct: 37 },
    });
    const resultLedger = await ledger();
    expect(resultLedger.asOf).toBe(statusAt);
    expect(resultLedger.lanes).toContainEqual(expect.objectContaining({
      lane: 'codex-personal', usedPct: 99, source: 'dispatchd-status',
    }));
    expect(resultLedger.lanes.find(row => row.lane === 'codex-personal')?.observation).toBeUndefined();
  });

  it('reports no session evidence as unavailable instead of inventing usage', async () => {
    writeStatus(now - 60_000);
    const result = command(true);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.output).resources[0]).toMatchObject({
      id: 'codex-personal', slot: 'secondary', state: 'unavailable', observedAt: null, weekly: null, session: null,
    });
    const text = command(false);
    expect(text.code).toBe(1);
    expect(text.output).toContain('Weekly: unavailable');
    expect(text.output).not.toMatch(/(?:0|99)% used/);
    expect((await ledger()).lanes).toContainEqual(expect.objectContaining({
      lane: 'codex-personal', usedPct: 99, source: 'dispatchd-status',
    }));
  });

  it('marks old session evidence stale without substituting the status percentage', async () => {
    const observedAt = writeSession(now - 2 * 86_400_000, 37);
    writeStatus(now - 60_000);
    const result = command(true);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.output).resources[0]).toMatchObject({
      id: 'codex-personal', state: 'stale', observedAt, weekly: { usedPct: 37, burnPctPerHour: null },
    });
    const text = command(false);
    expect(text.code).toBe(1);
    expect(text.output).toContain('Freshness: stale');
    expect(text.output).toContain('Weekly: 37% used');
    expect(text.output).not.toMatch(/(?:0|99)% used/);
    expect((await ledger()).lanes).toContainEqual(expect.objectContaining({
      lane: 'codex-personal', usedPct: 99, source: 'dispatchd-status',
    }));
  });
});
