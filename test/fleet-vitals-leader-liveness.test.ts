import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLeaderLiveness } from '../src/core/fleet/leader-liveness-evidence.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });
async function fake(plan?: string, events?: string) {
  const root = await mkdtemp(join(tmpdir(), 'vitals-leader-')); roots.push(root);
  await mkdir(join(root, 'leader')); await mkdir(join(root, 'queue'));
  if (plan !== undefined) await writeFile(join(root, 'leader/PLAN-LOG.md'), plan);
  if (events !== undefined) await writeFile(join(root, 'queue/dispatch-events.log'), events);
  return root;
}

// Recovered from #6999: plan-log age, 24h mismatch count and the >2h red flag. The source test's
// "now" (17:05Z) preceded its own 16:05 ET heading (21:05Z), so it is moved forward here.
it('reports planner age, counts mismatches in the prior 24h and flags age over two hours', async () => {
  const root = await fake('# Leader PLAN-LOG\n\n## 2026-11-16 ~15:05 ET\n- first\n\n## 2026-11-16 ~16:05 ET\n- Work from /Users/fake/projects/phantom\n',
    ['2026-11-16T14:00:00.000Z INFO OPUS-LEADER loop sha mismatch, refused', '2026-11-16T15:00:00.000Z INFO OPUS-LEADER loop sha mismatch, refused',
      '2026-11-15T14:00:00.000Z INFO OPUS-LEADER loop sha mismatch, refused (old entry)'].join('\n') + '\n');
  const l = await readLeaderLiveness(root, Date.parse('2026-11-16T23:35:00Z'));
  expect(l).toMatchObject({ as_of: '2026-11-16T21:05:00.000Z', time_basis: 'approximate-america-new_york', mismatch_count: 2, flagged_red: true, authority: 'none' });
  expect(l.age_hours).toBeCloseTo(2.5, 5);
  expect((await readLeaderLiveness(root, Date.parse('2026-11-16T23:05:00Z'))).flagged_red).toBe(false); // exactly 2h is not stale
});

it('missing evidence is unknown, never zero mismatches or healthy', async () => {
  const l = await readLeaderLiveness(await fake(), 1);
  expect(l).toMatchObject({ as_of: null, age_seconds: null, age_hours: null, flagged_red: null, mismatch_count: null, mismatch_unusable_lines: null });
});
