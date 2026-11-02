import { expect, it } from 'vitest';
import type { OutcomeCaseRow } from './fleet-outcomes-model.js';
import { recutJob } from './recut-job-body.js';

it('includes the recut rules and stays within the dispatch byte limit', () => {
  const row: OutcomeCaseRow = {
    caseId: 'x', jobId: '😀'.repeat(10), endedAt: null,
    outcome: 'failed', lane: 'codex-personal', label: '😀'.repeat(100),
    failureKind: '😀'.repeat(100), proposalRecorded: true,
    prLink: { url: `https://github.com/ashlrai/phantom/pull/${'9'.repeat(20)}`, label: 'PR' },
  };
  const body = recutJob(row, Date.parse('2026-11-01T00:10:00Z'))!.body;
  for (const sentence of [
    "Apply only the hunks that belong to this PR's own concern.",
    'Before stopping, git diff --stat origin/master must list only the files you planned for this concern (write that list in BRIDGE_NOTES.md first); if it lists more, you started from a stale base — git checkout origin/master -- <extra files> and continue.',
    'A new verb is only a new src/cli/fleet-<verb>.ts exporting cmdFleet<Verb> (convention dispatch, PR #2427).',
    'A recut must drop its src/cli/fleet.ts hunk and rename its export to fit.',
    'Do not edit src/core/verse/verse-api.ts; mount new routes as sub-paths inside an existing mounted module.',
    'Do not import a symbol from a job that has not merged; if the inherited work depends on one, define the type in a new file of your own.',
    'Your last step before stopping is npx tsc --noEmit -p tsconfig.json with exit 0.',
    'If it fails, fix it.', 'A red PR emails Mason.',
  ]) expect(body).toContain(sentence);
  expect(new TextEncoder().encode(body).length).toBeLessThan(7000);
});
