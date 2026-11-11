import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { claimFleetWork, readFleetBoard, releaseFleetClaim } from '../src/core/fleet/coordination.js';

it('preserves a release when a full ledger is compacted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-recut-'));
  try {
    const options = { path: join(dir, 'ledger'), now: 1000 };
    const claim = claimFleetWork({ repo: 'ashlrai/phantom', task: 'Example', agent: 'agent', ttlMs: 10000 }, options);
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error('claim failed');
    const tombstone = JSON.stringify({ version: 1, kind: 'release', at: 1000, id: 'old' }) + '\n';
    writeFileSync(options.path, readFileSync(options.path, 'utf8') + tombstone.repeat(19999));
    expect(releaseFleetClaim({ id: claim.value.claim.id, agent: 'agent', lease: claim.value.lease }, options).ok).toBe(true);
    expect(readFleetBoard(options)).toMatchObject({ state: 'known', claims: [] });
    expect(readFileSync(options.path, 'utf8')).not.toContain('old');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
