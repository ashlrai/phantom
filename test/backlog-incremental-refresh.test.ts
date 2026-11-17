import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ local: vi.fn(), queue: vi.fn() }));
vi.mock('../src/core/portfolio/scanners.js', () => ({ SCANNERS: [mocks.local, mocks.queue], SCANNER_REGISTRATIONS: undefined }));
vi.mock('../src/core/plugins/registry.js', () => ({ getPluginScanners: async () => [] }));
import { buildBacklog, createBacklogScanSnapshot } from '../src/core/portfolio/backlog.js';
import type { WorkItem } from '../src/core/types.js';

let root: string;
let repos: string[];
const item = (repo: string): WorkItem => ({ id: repo, repo, source: 'issue', title: 'Repair parser corruption', detail: 'Handle invalid input without corrupting persisted state', value: 4, effort: 1, score: 4, tags: [], ts: '2026-01-01T00:00:00.000Z' });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'backlog-incremental-'));
  repos = ['a', 'b'].map(name => { const repo = join(root, name); mkdirSync(repo); return repo; });
  mocks.local.mockReset().mockImplementation(async repo => [item(repo)]);
  mocks.queue.mockReset().mockResolvedValue([]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const options = () => ({ repos, persist: false, listPendingProposals: () => [], cfg: { foundry: { feedbackEnabled: false } } });

it('invalidates only touched repos and selected scanners while retaining other repo items', async () => {
  const snapshot = createBacklogScanSnapshot();
  await buildBacklog({ ...options(), snapshot });
  const result = await buildBacklog({ ...options(), snapshot, invalidate: { repos: [repos[0]!], scanners: ['scanner-1'] } });
  expect(mocks.local.mock.calls.map(([repo]) => repo)).toEqual([repos[0], repos[1], repos[0]]);
  expect(mocks.queue).toHaveBeenCalledTimes(4);
  expect(result.items.map(item => item.repo)).toEqual(repos);
  const filtered = await buildBacklog({ ...options(), snapshot, minItemValue: 5 });
  expect(filtered.items).toEqual([]);
  expect(mocks.local).toHaveBeenCalledTimes(3);
});

it('skips never-settling scanners at their sub-deadline without caching the skip', async () => {
  mocks.queue.mockImplementation(() => new Promise(() => {}));
  const snapshot = createBacklogScanSnapshot();
  const start = Date.now();
  const result = await buildBacklog({ ...options(), snapshot, scannerDeadlineMs: 40 });
  expect(Date.now() - start).toBeLessThan(1500);
  expect(result.items).toHaveLength(2);
  expect(result.skippedScanners).toEqual(repos.map(repo => ({ repo, scannerId: 'scanner-1', reason: 'scanner-deadline', durationMs: expect.any(Number) })));
  expect(result.observations).toEqual(expect.arrayContaining(repos.map(repo => expect.objectContaining({ repo, status: 'unavailable', reason: 'scanner-deadline' }))));
  mocks.queue.mockResolvedValue([]);
  const retried = await buildBacklog({ ...options(), snapshot });
  expect(retried.skippedScanners).toEqual([]);
  expect(mocks.local).toHaveBeenCalledTimes(2);
  expect(mocks.queue).toHaveBeenCalledTimes(4);
});

it('records cancellation without starting any scanners', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await buildBacklog({ ...options(), repos: Array(6).fill(repos[0]), signal: controller.signal });
  expect(mocks.local).not.toHaveBeenCalled();
  expect(mocks.queue).not.toHaveBeenCalled();
  expect(result.items).toEqual([]);
  expect(result.skippedScanners?.every(skip => skip.reason === 'phase-cancelled')).toBe(true);
  expect(result.skippedScanners).toHaveLength(2);
});

it('aborts active scanners and skips repositories not yet started', async () => {
  const extra = Array.from({ length: 4 }, (_, i) => { const repo = join(root, `extra-${i}`); mkdirSync(repo); return repo; });
  mocks.local.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const pending = buildBacklog({ ...options(), repos: [...repos, ...extra], signal: controller.signal });
  await vi.waitFor(() => expect(mocks.local).toHaveBeenCalledTimes(4));
  controller.abort();
  const result = await pending;
  expect(mocks.local).toHaveBeenCalledTimes(4);
  expect(result.skippedScanners?.filter(skip => skip.scannerId === 'scanner-0')).toHaveLength(6);
  expect(result.skippedScanners?.every(skip => skip.reason === 'phase-cancelled')).toBe(true);
});

it('isolates scanner errors and supports an empty repo set', async () => {
  mocks.queue.mockRejectedValue(new Error('unavailable source'));
  expect((await buildBacklog(options())).items).toHaveLength(2);
  expect((await buildBacklog({ ...options(), repos: [] })).skippedScanners).toEqual([]);
});
