import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readResourceLedger } from '../src/core/fleet/runs-resource-ledger.js';

describe('personal ledger account isolation', () => {
  let root: string;
  let personalHome: string;
  let runsDir: string;
  let originalCodexHome: string | undefined;
  const now = Date.now();

  function session(home: string, at: number, used: number) {
    const dir = join(home, 'sessions', '2026', '10', '31');
    mkdirSync(dir, { recursive: true });
    const timestamp = new Date(at).toISOString();
    writeFileSync(join(dir, 'rollout-fake.jsonl'), `${JSON.stringify({
      timestamp, type: 'event_msg', payload: { type: 'token_count', rate_limits: {
        plan_type: 'plus', primary: { used_percent: 12, window_minutes: 300, resets_at: Math.floor((now + 3600000) / 1000) },
        secondary: { used_percent: used, window_minutes: 10080, resets_at: Math.floor((now + 3 * 86400000) / 1000) },
      } },
    })}\n`);
    return timestamp;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'personal-ledger-isolation-'));
    personalHome = join(root, 'personal');
    runsDir = join(root, 'runs');
    originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(root, 'other');
    session(process.env.CODEX_HOME, now - 1000, 99);
  });

  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    rmSync(root, { recursive: true, force: true });
  });

  async function personalRows() {
    const ledger = await readResourceLedger({ runsDir, personalCodexHome: personalHome, now: () => now });
    return ledger.lanes.filter(row => row.lane === 'codex-personal');
  }

  it('uses only the selected home even when the process home is newer', async () => {
    const observedAt = session(personalHome, now - 60000, 23);
    const rows = await personalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ usedPct: 23, source: 'codex-personal-sessions',
      observation: { source: 'codex-personal-sessions', asOf: observedAt } });
  });

  it.each(['empty', 'missing'])('does not invent a session for an %s selected home', async state => {
    if (state === 'empty') mkdirSync(personalHome, { recursive: true });
    expect(await personalRows()).toEqual([]);
  });

  it.each(['empty', 'missing'])('preserves status provenance for an %s selected home', async state => {
    if (state === 'empty') mkdirSync(personalHome, { recursive: true });
    const asOf = new Date(now - 120000).toISOString();
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
    writeFileSync(join(runsDir, 'queue', 'status.json'), JSON.stringify({
      last_tick: asOf, lanes: { 'codex-personal': { running: 1, target: 2, held: false } },
      budget: { 'codex-personal': { weekly_used_pct: 41, source: 'dispatchd-status', observed_at: asOf } },
    }));
    const rows = await personalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ usedPct: 41, source: 'dispatchd-status' });
    expect(rows[0].observation).toBeUndefined();
    expect(rows[0].quotaEvidence).toEqual(expect.objectContaining({ statusQuota: expect.objectContaining({ observedAt: asOf }), measuredQuota: null }));
  });
});
