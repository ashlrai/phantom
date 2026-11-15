import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetRecheck } from '../src/core/fleet/fleet-recheck.js';

const state = vi.hoisted(() => ({ verdict: undefined as unknown, reads: 0 }));
vi.mock('../src/core/fleet/fleet-recheck.js', () => ({
  readFleetRecheck: async () => { state.reads++; return state.verdict; },
}));

import { composeOwnerRecheckReply, ownerStatusReply, recheckReplyWithRecord } from '../src/core/agents/owner-status-reply.js';
import { formatRecheckReply } from '../src/core/fleet/fleet-recheck-reply.js';

const asOf = '2026-11-13T00:00:01.000Z';
function fake(): FleetRecheck {
  return {
    schema: 'fleet.recheck.v1', asOf,
    sections: {
      runtime: { state: 'VERIFIED', source: 'runtime-identity', asOf, host: 'fake-host', tailnetName: 'fake.ts.net', installedVersion: '1.2.3', sourceVersion: '1.2.3', fleetState: { ageSeconds: 3, stale: false }, missing: [] },
      claims: { state: 'VERIFIED', source: 'coordination', asOf, active: 2, expiredClaims: 0, top: [], missing: [] },
      bridge: { state: 'VERIFIED', source: 'channel-health', asOf, channels: [], missingBridge: null, missing: [] },
      task: { state: 'VERIFIED', source: 'work-board', asOf, task: { id: 'T-1', state: 'RUNNING', owner: 'fake-agent', claimReceipt: 'rcpt-1', ledgerClaim: null, asOf, source: 'work-board' }, unowned: 0, unclaimed: 0, missing: [] },
    },
    overall: { state: 'VERIFIED', missing: [] },
  } as FleetRecheck;
}
const now = new Date(asOf);
const dirs: string[] = [];
let prevHome: string | undefined;
beforeEach(() => { state.verdict = fake(); state.reads = 0; prevHome = process.env.ASHLR_HOME; });
afterEach(() => {
  if (prevHome === undefined) delete process.env.ASHLR_HOME; else process.env.ASHLR_HOME = prevHome;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('recheck ask records evidence', () => {
  it('records once and replies with the formatted verdict', async () => {
    const record = vi.fn();
    const text = await composeOwnerRecheckReply(now, { recordRecheck: record });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(state.verdict);
    expect(state.reads).toBe(1);
    expect(text).toBe(formatRecheckReply(fake()));
  });

  it('a throwing record seam still yields the same reply', async () => {
    const text = await composeOwnerRecheckReply(now, { recordRecheck: () => { throw new Error('disk full'); } });
    expect(text).toBe(formatRecheckReply(fake()));
    expect(await recheckReplyWithRecord(now, async () => fake(), () => { throw new Error('x'); })).toBe(text);
  });

  it('a supplied deps.recheck bypasses read and record', async () => {
    const record = vi.fn();
    expect(await composeOwnerRecheckReply(now, { recheck: async () => 'custom', recordRecheck: record })).toBe('custom');
    expect(record).not.toHaveBeenCalled();
    expect(state.reads).toBe(0);
  });

  it('a failing read gives the fallback and records nothing', async () => {
    const record = vi.fn();
    const text = await recheckReplyWithRecord(now, async () => { throw new Error('boom'); }, record).catch(() => 'threw');
    expect(text).toBe('threw');
    expect(record).not.toHaveBeenCalled();
  });

  it('a status ask records nothing', async () => {
    const record = vi.fn();
    const reply = ownerStatusReply({ recordRecheck: record, brief: async () => 'Morning leader brief\nx', board: () => ({ items: [], total: 0 }) as never });
    await reply.compose('/nonexistent', now, 'status');
    expect(record).not.toHaveBeenCalled();
    expect(state.reads).toBe(0);
  });

  it('default path appends one valid sanitized row under a temp home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'recheck-328-'));
    dirs.push(home);
    process.env.ASHLR_HOME = home;
    const text = await ownerStatusReply().compose('/nonexistent', now, 'recheck');
    expect(text).toBe(formatRecheckReply(fake()));
    const file = join(home, 'fleet', 'recheck-log.jsonl');
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).schema).toBe('fleet.recheck-record.v1');
    expect(raw).not.toContain('/Users/');
    expect(raw).not.toContain(home);
  });
});
