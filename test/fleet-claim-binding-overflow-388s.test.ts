import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readClaimThreadBindings, runClaimNoticePass } from '../src/core/fleet/claim-notice-send.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';

const limit = 5000;
const now = 1_800_000_000_000;
const repo = 'fake/repo';
const stale = 'TFAKE/CFAKE/100.000001';
const corrected = 'TFAKE/CFAKE/100.000002';
const row = (claimId: string, threadKey = stale) => ({ v: 1, claimId, repo, threadKey });
const directories: string[] = [];
function writeRows(rows: ReturnType<typeof row>[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'claim-binding-test-'));
  directories.push(dir);
  const path = join(dir, 'bindings.jsonl');
  const contents = `${rows.map(value => JSON.stringify(value)).join('\n')}\n`;
  expect(Buffer.byteLength(contents)).toBeLessThan(4 * 1024 * 1024);
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe.sequential('claim binding row budget', () => {
  it('refuses overflow and cannot send an assignment to the stale thread', async () => {
    const rows = [row('fake-claim'), ...Array.from({ length: limit }, (_, i) => row(`fake-${i}`)),
      row('fake-claim', corrected)];
    const path = writeRows(rows);
    expect(readClaimThreadBindings(path)).toEqual([]);
    const calls: string[] = [];
    const claim = { id: 'fake-claim', repo, task: 'fake task', agent: 'fake-agent',
      claimedAt: now - 1000, expiresAt: now + 10000 };
    const board: FleetBoard = { schema: 'fleet.coordination.v1', state: 'known', claims: [claim],
      messages: [], proposals: [], expiredClaims: 0 };
    const result = await runClaimNoticePass({
      readBoard: () => board,
      readPrevSnapshot: () => ({ state: 'known', claims: [], messages: [], asOf: now - 2000 }),
      writePrevSnapshot: () => {},
      readBindings: () => readClaimThreadBindings(path),
      readSentLedger: () => new Set(),
      appendSentLedger: () => {},
      send: thread => { calls.push(thread); return { ok: true }; },
      now: () => now,
    });
    expect(result.planned).toBe(0);
    expect(calls).toEqual([]);
  });

  it('accepts exactly the distinct-key limit and applies a later correction', () => {
    const path = writeRows([...Array.from({ length: limit }, (_, i) => row(`fake-${i}`)),
      row('fake-0', corrected)]);
    const bindings = readClaimThreadBindings(path);
    expect(bindings).toHaveLength(limit);
    expect(bindings.find(binding => binding.claimId === 'fake-0')?.threadKey).toBe(corrected);
  });

  it('counts distinct keys rather than repeated updates', () => {
    const path = writeRows([...Array.from({ length: limit + 1 }, () => row('fake-claim')),
      row('fake-claim', corrected)]);
    expect(readClaimThreadBindings(path)).toEqual([{ claimId: 'fake-claim', repo, threadKey: corrected }]);
  });

  it('uses the last correction below the limit', () => {
    const path = writeRows([row('fake-claim'), row('fake-other'), row('fake-claim', corrected)]);
    expect(readClaimThreadBindings(path)).toEqual([
      { claimId: 'fake-claim', repo, threadKey: corrected },
      { claimId: 'fake-other', repo, threadKey: stale },
    ]);
  });
});
