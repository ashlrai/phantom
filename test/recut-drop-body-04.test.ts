import { expect, it } from 'vitest';
import { recutDropJob } from '../src/core/fleet/recut-drop-body.js';
import { validateDropJob } from '../src/core/fleet/drop-job-writer.js';
import type { DirtyLandedPr } from '../src/core/fleet/dirty-landed-inspect.js';
const pr: DirtyLandedPr = { number: 12, title: 'bridge: RQ-PHX-FAKE', head: 'a'.repeat(40), base: 'master',
  class: 'needs-recut', changedPaths: ['a'], landedPaths: [], remainingPaths: ['src/a.ts', 'test/b.ts'] };
it('builds a valid UTC desktop-compatible drop with exact paths and bound', () => {
  const job = recutDropJob(pr, Date.UTC(2026, 10, 2));
  expect('reason' in job).toBe(false);
  if ('reason' in job) return;
  expect(job.id).toBe('RECUT121102');
  expect(validateDropJob(job)).toEqual({ ok: true });
  for (const path of pr.remainingPaths) expect(job.body).toContain(JSON.stringify(path));
  expect(job.body).toContain('node scripts/verify-recut-paths.mjs origin/master <paths.json>');
  expect(job.body).toContain('Closes #12');
});
it.each(['bridge: RQ-CL-DOCS-1795103686', 'bridge: RQ-MODELREGN20UQ8'])('recuts non-PHX fleet agent PR %s', title => {
  const job = recutDropJob({ ...pr, title }, 0);
  expect('reason' in job).toBe(false);
  expect(job).toMatchObject({ body: expect.stringContaining('Closes #12') });
});
it.each(['bridge: other', 'bridge: RQ-', 'feat: bridge: RQ-X'])('still ignores non-fleet title %j', title => {
  expect(recutDropJob({ ...pr, title }, 0)).toEqual({ reason: 'title' });
});
it.each([
  [{ class: 'landed' }, 'already-present-on-base'], [{ class: 'unknown' }, 'class'], [{ title: 'other' }, 'title'],
  [{ remainingPaths: [] }, 'empty'], [{ remainingPaths: Array(21).fill('a') }, 'too-wide'],
  ...['.github/workflows/a', 'src/cli/desktop.ts', 'src/core/desktop/a', 'desktop/src-tauri/a'].map(p => [{ remainingPaths: [p] }, 'owner-path']),
  [{ head: '' }, 'invalid-data'], [{ remainingPaths: ['a'.repeat(4001)] }, 'too-large'],
  [{ base: 'release' }, 'base'],
  [{ remainingPaths: ['auth.json'] }, 'invalid-body'],
] as const)('skips unsafe or ineligible input %j', (patch, reason) => {
  expect(recutDropJob({ ...pr, ...patch } as DirtyLandedPr, 0)).toEqual({ reason });
});
it('escapes hostile title and paths without injecting a job header', () => {
  const job = recutDropJob({ ...pr, title: pr.title + '\n#job fake', remainingPaths: ['a\n#job fake'] }, 0);
  expect('reason' in job).toBe(false);
  if (!('reason' in job)) expect(job.body.split('\n').some(line => line.startsWith('#job'))).toBe(false);
});
it.each(['main', 'master'])('targets current %s without rewriting source paths or titles', base => {
  const title = 'bridge: RQ-PHX-master-fixture';
  const path = 'src/master-state.ts';
  const job = recutDropJob({ ...pr, base, title, remainingPaths: [path] }, 0);
  expect('reason' in job).toBe(false);
  if ('reason' in job) return;
  expect(job.body).toContain(`git fetch origin ${base}`);
  expect(job.body).toContain(`fresh branch from origin/${base}`);
  expect(job.body).toContain(`verify-recut-paths.mjs origin/${base}`);
  expect(job.body).toContain(JSON.stringify(path));
  expect(job.body).toContain(JSON.stringify(title));
});
