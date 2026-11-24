import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetReturnsCheck } from '../src/cli/fleet-returns-check.js';
import { claimFleetWork, fleetCoordinationPath, postFleetMessage, readFleetBoard } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';

const at = 1_000_000;
const expiry = at + 10_000;
const head = 'abc1234def567890abcdef1234567890abcdef12';
const repo = 'example/history';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('checks durable history at the observation clock without reviving ordinary messages or ownership', async () => {
  const root = mkdtempSync(join(tmpdir(), 'returns-clock-592s-'));
  try {
    vi.stubEnv('HOME', root);
    vi.stubEnv('ASHLR_HOME', root);
    vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', '');
    delete process.env['PHANTOM_FLEET_LEDGER_PATH'];
    const path = fleetCoordinationPath();
    const claim = claimFleetWork({ repo, task: 'synthetic task', agent: 'fake-agent', ttlMs: 10_000 }, { now: at });
    if (!claim.ok) throw new Error('claim failed');
    const id = claim.value.claim.id;
    expect(returnFleetClaim({ id, agent: 'fake-agent', lease: claim.value.lease, pr: 592, head, ttlMs: 10_000 }, { now: at }).ok).toBe(true);
    const stale = claimFleetWork({ repo, task: 'expired ownership', agent: 'other-agent', ttlMs: 10_000 }, { now: at });
    expect(stale.ok).toBe(true);
    const gh = vi.fn(async () => JSON.stringify({ state: 'closed', merged: true, merged_at: '2026-11-12T22:29:00Z', head: { sha: head } }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const run = async (now: number, code: number) => {
      const bytes = readFileSync(path);
      gh.mockClear(); log.mockClear();
      expect(await cmdFleetReturnsCheck(['--json'], { gh, now: () => now })).toBe(code);
      expect(readFileSync(path)).toEqual(bytes);
      return JSON.parse(String(log.mock.calls[0]?.[0]));
    };
    const current = await run(at + 1, 0);
    expect(current.asOf).toBe(new Date(at + 1).toISOString());
    expect(current.receipts).toEqual(expect.arrayContaining([expect.objectContaining({ claimId: id, repo, pr: 592, head, temporal: 'current' })]));
    expect(postFleetMessage({ id: 'return-impostor', from: 'fake-agent', to: 'all', ttlMs: 10_000,
      body: `RESULT VERIFIED ${repo} claim impostor task "fake": pr #999 head ${head}` }, { now: at }).ok).toBe(true);
    const expired = await run(expiry, 1);
    expect(expired).toMatchObject({ asOf: new Date(expiry).toISOString(), unparsed: 0,
      receipts: [{ claimId: id, repo, pr: 592, head, temporal: 'expired' }],
      checked: [{ claimId: id, repo, pr: 592, head, observedHead: head, verdict: 'merged-at-head' }] });
    expect(gh).toHaveBeenCalledExactlyOnceWith(['api', '-H', 'Accept: application/vnd.github+json', 'repos/example/history/pulls/592']);
    expect(readFleetBoard({ now: expiry, reap: false, includeExpiredReturns: true }).claims).toEqual([]);
    expect(postFleetMessage({ id: 'return-malformed', from: 'fake-agent', to: 'all', body: 'not a receipt', ttlMs: 10_000 }, { now: expiry }).ok).toBe(true);
    const malformed = await run(expiry, 1);
    expect(malformed).toMatchObject({ unparsed: 1, projectionCoverage: { unparsed: 1 } });
    expect(gh).toHaveBeenCalledExactlyOnceWith(['api', '-H', 'Accept: application/vnd.github+json', 'repos/example/history/pulls/592']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
