import { describe, expect, it, vi } from 'vitest';
import { cmdFleetReviewPick, type FleetReviewPickDeps } from '../src/cli/fleet-review-pick.js';
import type { ReviewPickReport } from '../src/core/fleet/review-pick.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';

const REPO = 'example/phantom';
const NOW = Date.parse('2026-11-14T16:00:00Z');
const ISO = '2026-11-14T16:00:00.000Z';
const firstHead = 'a'.repeat(40);
const changedHead = 'b'.repeat(40);
const secondHead = 'c'.repeat(40);

function fixture() {
  let boardAvailable = false;
  let githubAvailable = true;
  let claimed = false;
  let head = firstHead;
  const output: string[] = [];
  const errors: string[] = [];
  const gh = vi.fn(async (args: string[]) => {
    expect(args).toEqual(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '100', '--json',
      'number,title,headRefName,headRefOid,isDraft,mergeStateStatus,updatedAt']);
    return { ok: githubAvailable, stderr: '', stdout: JSON.stringify([
      { number: 101, title: 'review one', headRefName: 'bridge/one', headRefOid: head, isDraft: false, mergeStateStatus: 'CLEAN', updatedAt: '2026-11-12T00:00:00Z' },
      { number: 102, title: 'review two', headRefName: 'bridge/two', headRefOid: secondHead, isDraft: false, mergeStateStatus: 'CLEAN', updatedAt: '2026-11-13T00:00:00Z' },
    ]) };
  });
  const readClaimedTsv = vi.fn(async () => ({ state: 'healthy' as const, text: '' }));
  const inspectBusWork = vi.fn(() => ({ source: 'available' as const, claims: [] }));
  const readBoard = vi.fn((): FleetBoard => ({
    schema: 'fleet.coordination.v1', state: boardAvailable ? 'known' : 'unknown',
    claims: claimed ? [{ id: 'fake-claim', repo: REPO, task: 'review #101', agent: 'fake-agent', claimedAt: NOW - 1000, expiresAt: NOW + 60_000 }] : [],
    messages: [], proposals: [], expiredClaims: 0,
  }));
  const listWorkers = vi.fn(async () => ({ v: 1 as const, generatedAt: ISO, sourceState: 'healthy' as const, workers: [], leaders: [], orchestratorAgents: 0 }));
  const deps: FleetReviewPickDeps = { gh, readClaimedTsv, inspectBusWork, readBoard, listWorkers,
    runsDir: '/synthetic/runs', now: () => NOW, stdout: text => output.push(text), stderr: text => errors.push(text) };
  return {
    async invoke(json: boolean) {
      output.length = 0;
      const code = await cmdFleetReviewPick(['--repo', REPO, ...(json ? ['--json'] : [])], deps);
      expect(errors).toEqual([]);
      return { code, text: output.join('') };
    },
    recover() { boardAvailable = true; },
    claimChangedHead() { head = changedHead; claimed = true; },
    failGithub() { githubAvailable = false; },
    assertReads() {
      for (const reader of [gh, readClaimedTsv, inspectBusWork, readBoard, listWorkers]) expect(reader).toHaveBeenCalledTimes(4);
    },
  };
}

describe.each([true, false])('review-pick fresh recovery (json=%s)', json => {
  it('withholds unavailable evidence, refreshes ownership and head, and drops a stale pick', async () => {
    const f = fixture();
    const unavailable = await f.invoke(json);
    expect(unavailable.code).toBe(1);
    if (json) {
      const report = JSON.parse(unavailable.text) as ReviewPickReport;
      expect(report.picked).toBeNull();
      expect(report.source.unavailable).toEqual(['coordination']);
      expect(unavailable.text).not.toContain('"owner":"none"');
    } else {
      expect(unavailable.text).toContain('picked: none\n');
      expect(unavailable.text).toContain('source.unavailable: coordination\n');
      expect(unavailable.text).not.toContain('owner: none');
    }

    f.recover();
    const recovered = await f.invoke(json);
    expect(recovered.code).toBe(0);
    if (json) {
      const report = JSON.parse(recovered.text) as ReviewPickReport;
      expect(report.as_of).toBe(ISO);
      expect(report.picked).toMatchObject({ repo: REPO, pr: 101, head: 'bridge/one', head_sha: firstHead, owner: 'none' });
    } else {
      for (const line of [`repo: ${REPO}`, `as_of: ${ISO}`, 'pr: 101', 'head: bridge/one', `head_sha: ${firstHead}`, 'owner: none']) expect(recovered.text).toContain(`${line}\n`);
    }

    f.claimChangedHead();
    const refreshed = await f.invoke(json);
    expect(refreshed.code).toBe(0);
    if (json) {
      const report = JSON.parse(refreshed.text) as ReviewPickReport;
      expect(report.picked).toMatchObject({ repo: REPO, pr: 102, head: 'bridge/two', head_sha: secondHead, owner: 'none' });
      expect(report.skipped).toEqual([{ pr: 101, owner: 'fake-agent', why: "live claim '#101' via coordination" }]);
    } else {
      for (const line of [`repo: ${REPO}`, `as_of: ${ISO}`, 'pr: 102', 'head: bridge/two', `head_sha: ${secondHead}`, 'owner: none', "skipped #101: live claim '#101' via coordination (owner: fake-agent)"]) expect(refreshed.text).toContain(`${line}\n`);
    }
    expect(refreshed.text).not.toContain(firstHead);
    expect(refreshed.text).not.toContain(changedHead);

    f.failGithub();
    const failed = await f.invoke(json);
    expect(failed.code).toBe(1);
    if (json) {
      const report = JSON.parse(failed.text) as ReviewPickReport;
      expect(report.picked).toBeNull();
      expect(report.source.prs).toBe('unavailable');
    } else {
      expect(failed.text).toContain('picked: none\n');
      expect(failed.text).toContain('source.prs: unavailable\n');
      expect(failed.text).not.toContain('owner: none');
    }
    expect(failed.text).not.toContain(secondHead);
    f.assertReads();
  });
});
