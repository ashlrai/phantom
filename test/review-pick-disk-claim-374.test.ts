import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetReviewPick, type FleetReviewPickDeps } from '../src/cli/fleet-review-pick.js';
import type { ReviewPickReport } from '../src/core/fleet/review-pick.js';

it('refreshes durable queue ownership from claimed.tsv for each review pick', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-pick-374-'));
  try {
    const queue = join(root, 'queue');
    const claimed = join(queue, 'claimed.tsv');
    await mkdir(queue);
    await writeFile(claimed, '');
    const head = 'a'.repeat(40);
    const job = 'RQ-REVIEWDISKCLAIM374';
    const gh = vi.fn(async () => ({ ok: true, stderr: '', stdout: JSON.stringify([{
      number: 374, title: `bridge: ${job}`, headRefName: 'bridge/review-disk-claim', headRefOid: head,
      isDraft: false, mergeStateStatus: 'CLEAN', updatedAt: '2026-11-13T00:00:00Z',
    }]) }));
    const output: string[] = [];
    const errors: string[] = [];
    const deps: FleetReviewPickDeps = {
      gh,
      inspectBusWork: () => ({ source: 'available', claims: [] }),
      readBoard: () => ({ schema: 'fleet.coordination.v1', state: 'known', claims: [], messages: [], proposals: [], expiredClaims: 0 }),
      listWorkers: async () => ({ v: 1, generatedAt: '2026-11-14T16:00:00.000Z', sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0 }),
      now: () => Date.parse('2026-11-14T16:00:00Z'),
      stdout: text => output.push(text), stderr: text => errors.push(text),
    };
    async function pick() {
      output.length = 0;
      const code = await cmdFleetReviewPick(['--repo', 'example/phantom', '--root', root, '--json'], deps);
      expect(code).toBe(0);
      expect(errors).toEqual([]);
      const report = JSON.parse(output.join('')) as ReviewPickReport;
      expect(report.source).toEqual({ prs: 'read', claims: {
        'claimed-tsv': 'read', 'bus-work-claims': 'read', coordination: 'read', 'live-workers': 'read',
      }, unavailable: [] });
      return report;
    }

    const first = await pick();
    expect(first.picked).toMatchObject({ pr: 374, head_sha: head, owner: 'none' });
    expect(first.skipped).toEqual([]);

    await writeFile(claimed, `${job}\tcodex-personal\twork\t16:00\t1794672000\n`);
    const owned = await pick();
    expect(owned.picked).toBeNull();
    expect(owned.skipped).toEqual([{ pr: 374, owner: 'codex-personal', why: `live claim '${job}' via claimed-tsv` }]);
    expect(JSON.stringify(owned)).not.toContain('"owner":"none"');
    expect(JSON.stringify(owned)).not.toContain(head);

    await writeFile(claimed, 'RQ-OTHER374\tcodex-personal\twork\t16:00\t1794672000\n');
    const released = await pick();
    expect(released.picked).toMatchObject({ pr: 374, head_sha: head, owner: 'none' });
    expect(released.skipped).toEqual([]);
    expect(gh).toHaveBeenCalledTimes(3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
