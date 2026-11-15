import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { planRestock } from '../src/core/portfolio/restock-plan.js';
import { cmdFleetRestock, restockPrecheck } from '../src/cli/fleet-restock.js';
const repos = ['phantom', 'locus', 'lexicon', 'ashlr-stack', 'ashlr-md'];
const candidates = (n: number, repo = 'phantom') => Array.from({ length: n }, (_, i) =>
  `- READY RQ-${repo.toUpperCase()}-${i} (repo=${repo}, pool=codex-personal, tier=work): Add case ${i} in test/example.test.ts; run npm test.`).join('\n');
const options = { isDir: () => true };
it('turns 30 cases across five repos into five six-item jobs', async () => {
  const report = await planRestock(repos.map(repo => candidates(6, repo)).join('\n'), async () => ({ code: 0, reason: 'ready' }), options);
  expect(report.jobs).toHaveLength(5);
  expect(report.jobs.map(job => job.items.length)).toEqual([6, 6, 6, 6, 6]);
  expect(report.jobs.every(job => job.items.every(item => item.repo === job.repo))).toBe(true);
  expect(report.invalid).toEqual([]);
});
it('checks every item before batching and excludes code 13 without claiming completion', async () => {
  const check = vi.fn(async (item: { jobId: string }) => ({ code: item.jobId.endsWith('-0') ? 13 : 0, reason: 'files_and_tests' }));
  const report = await planRestock(candidates(7), check, options);
  expect(check).toHaveBeenCalledTimes(7);
  expect(report.excluded).toEqual([{ jobId: 'RQ-PHANTOM-0', code: 13, reason: 'files_and_tests' }]);
  expect(report.jobs[0]!.items).toHaveLength(6);
  expect(report.jobs[0]!.prompt).not.toContain('RQ-PHANTOM-0:');
});
it('balances 6–10 item jobs and holds small tails; failures never enter jobs', async () => {
  for (const n of [5, 11, 12, 21, 30]) {
    const report = await planRestock(candidates(n), async () => ({ code: 0, reason: 'ready' }), options);
    expect(report.jobs.every(job => job.items.length >= 6 && job.items.length <= 10)).toBe(true);
    expect(report.jobs.flatMap(job => job.items).length + report.held.length).toBe(n);
  }
  const report = await planRestock(candidates(6), async () => { throw new Error('timeout'); }, options);
  expect(report.jobs).toEqual([]);
  expect(report.excluded).toHaveLength(6);
});
it('uses the existing precheck and withholds candidates when unavailable', async () => {
  const report = await planRestock(candidates(6), restockPrecheck('/missing-restock-fixture', '/missing-repos'), options);
  expect(report.jobs).toEqual([]);
  expect(report.excluded).toHaveLength(6);
});
it('provides one CLI path and rejects unknown flags', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetRestock(['plan', '--apply'])).toBe(2);
  error.mockRestore();
});

it('emits the typed plan as JSON through the CLI', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await cmdFleetRestock(['plan', '--json'], { text: candidates(6), check: async () => ({ code: 0, reason: 'ready' }), options })).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ schema: 'fleet.restock-plan.v1', jobs: [{ repo: 'phantom' }], excluded: [], held: [], invalid: [] });
  } finally { log.mockRestore(); }
});

it('honors code 13 from the dispatcher script at generation time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restock-precheck-'));
  try {
    await mkdir(join(root, 'bin'));
    await writeFile(join(root, 'bin/precheck.sh'), 'echo "SKIP fixture code=13 reason=files_and_tests"; exit 13\n');
    const report = await planRestock(candidates(6), restockPrecheck(root, root), options);
    expect(report.jobs).toEqual([]);
    expect(report.excluded.map(item => item.code)).toEqual([13, 13, 13, 13, 13, 13]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
