import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimFleetWork, readFleetBoard, releaseFleetClaim } from '../src/core/fleet/coordination.js';
import { readReviewPick } from '../src/core/fleet/review-pick.js';

const repo = 'example/phantom';
const now = Date.parse('2026-11-14T16:00:00Z');
const directories: string[] = [];
function ledger() {
  const dir = mkdtempSync(join(tmpdir(), 'rp-ledger-'));
  directories.push(dir);
  const path = join(dir, 'coordination.jsonl');
  writeFileSync(path, '', { mode: 0o600 });
  return path;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function pick(path: string, at = now) {
  return readReviewPick({
    repo, now: () => at, readBoard: () => readFleetBoard({ path, now: at }),
    gh: async () => ({ ok: true, stderr: '', stdout: JSON.stringify([
      { number: 10, title: 'Review RQ-LEDGER-PROOF', headRefName: 'example/head-10', headRefOid: 'a'.repeat(40), isDraft: false, mergeStateStatus: 'CLEAN', updatedAt: '2026-11-12T00:00:00Z' },
      { number: 11, title: 'Another review', headRefName: 'example/head-11', headRefOid: 'b'.repeat(40), isDraft: false, mergeStateStatus: 'CLEAN', updatedAt: '2026-11-13T00:00:00Z' },
    ]) }),
    readClaimedTsv: async () => ({ state: 'healthy', text: '' }),
    inspectBusWork: () => ({ source: 'available', claims: [] }),
    listWorkers: async () => ({ v: 1, generatedAt: '', sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0 }),
  });
}
function claim(path: string, task: string, claimRepo = repo, ttlMs?: number) {
  const result = claimFleetWork({ repo: claimRepo, task, agent: 'agent-a', ttlMs }, { path, now });
  if (!result.ok) throw new Error(`Claim failed: ${result.error}`);
  return result.value;
}

describe('review-pick against the coordination ledger', () => {
  it('picks the oldest unowned PR from an empty ledger', async () => {
    expect((await pick(ledger())).picked).toMatchObject({ pr: 10, owner: 'none' });
  });

  it('blocks a claimed review until its lease is released', async () => {
    const path = ledger();
    const { claim: held, lease } = claim(path, 'review #10 example/head-10');
    const report = await pick(path);
    expect(report.picked).toMatchObject({ pr: 11, owner: 'none' });
    expect(report.skipped).toContainEqual({ pr: 10, owner: 'agent-a', why: expect.stringContaining('coordination') });
    expect(releaseFleetClaim({ id: held.id, agent: 'agent-a', lease }, { path, now })).toMatchObject({ ok: true });
    expect((await pick(path)).picked).toMatchObject({ pr: 10, owner: 'none' });
  });

  it.each(['PR 10', 'PR-10', 'pull/10', 'example/head-10', 'RQ-LEDGER-PROOF'])('recognizes task %s', async task => {
    const path = ledger();
    claim(path, task);
    const report = await pick(path);
    expect(report.picked?.pr).toBe(11);
    expect(report.skipped).toContainEqual({ pr: 10, owner: 'agent-a', why: expect.stringContaining('coordination') });
  });

  it.each(['#100', '#1', '10x', 'unrelated task', '10'])('does not match task %s to #10', async task => {
    const path = ledger();
    claim(path, task);
    expect((await pick(path)).picked).toMatchObject({ pr: 10, owner: 'none' });
  });

  it('does not attribute another repository’s claim', async () => {
    const path = ledger();
    claim(path, 'review #10', 'example/other');
    expect((await pick(path)).picked).toMatchObject({ pr: 10, owner: 'none' });
  });

  it('makes an expired claim pickable', async () => {
    const path = ledger();
    claim(path, 'review #10', repo, 1000);
    expect((await pick(path)).picked?.pr).toBe(11);
    expect((await pick(path, now + 2000)).picked).toMatchObject({ pr: 10, owner: 'none' });
  });

  it.each(['corrupt', 'group-readable'])('withholds a pick for a %s ledger', async kind => {
    const path = ledger();
    if (kind === 'corrupt') writeFileSync(path, 'not JSON\n', { mode: 0o600 });
    else chmodSync(path, 0o644);
    const report = await pick(path);
    expect(report.source.claims.coordination).toBe('unavailable');
    expect(report.picked).toBeNull();
    expect(report.reason).toBe('ownership source unavailable');
  });
});
