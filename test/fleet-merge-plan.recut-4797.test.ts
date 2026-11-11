import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { supersededOpenPrs } from '../src/core/fleet/merge-plan.js';
import { cmdFleetMergePlan } from '../src/cli/fleet-merge-plan.js';

it('reports open supersession proposals through the fleet command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'merge-plan-'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const input = join(dir, 'prs.json');
    await writeFile(input, JSON.stringify([
      { number: 10, title: 'Original', body: '', isDraft: false },
      { number: 11, title: 'bridge: RQ-FIX-PHANTOM-10', body: '', isDraft: false },
    ]));
    expect(await cmdFleetMergePlan(['--input', input, '--repo', 'ashlrai/phantom', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]![0])).proposals).toMatchObject([{ number: 10, supersededBy: 11 }]);
  } finally {
    log.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

it('never chooses a draft as the replacement', () => {
  const report = supersededOpenPrs([
    { number: 20, title: 'bridge: RQ-FIX-PHANTOM-21', body: '', isDraft: false },
    { number: 21, title: 'Draft', body: '', isDraft: true },
  ], 'ashlrai/phantom');
  expect(report.proposals).toMatchObject([{ number: 21, supersededBy: 20 }]);
});
