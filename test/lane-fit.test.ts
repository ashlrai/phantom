import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { computeLaneFit } from '../src/core/fleet/lane-fit.js';
import { cmdLanes } from '../src/cli/lanes.js';

it('scores measured outcomes by job kind and leaves gaps unknown', async () => {
  const text = await readFile(new URL('./fixtures/lane-fit/jobs.jsonl', import.meta.url), 'utf8');
  const report = computeLaneFit(text, 'codex-local');
  expect(report.kinds).toContainEqual({ repo: 'phantom', tier: 'work', verb: 'fix', jobs: 4, prs: 0, unknownOutcomes: 1, prRate: 0, recommendation: 'avoid' });
  expect(report.kinds).toContainEqual({ repo: 'phantom', tier: 'work', verb: 'build', jobs: 3, prs: 2, unknownOutcomes: 0, prRate: 2 / 3, recommendation: 'send' });
  expect(report.kinds).toContainEqual({ repo: 'phantom', tier: 'work', verb: null, jobs: 1, prs: 0, unknownOutcomes: 0, prRate: 0, recommendation: 'unknown' });
  expect(computeLaneFit(null, 'codex-local')).toMatchObject({ known: false, kinds: [] });
  expect(computeLaneFit('', 'codex-local')).toMatchObject({ known: true, kinds: [] });
});

it('exposes fit as JSON and validates flags', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await cmdLanes(['fit', '--lane', 'codex-local', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ schema: 'lanes.fit.v1', lane: 'codex-local' });
    expect(await cmdLanes(['fit', '--lane'])).toBe(2);
    expect(await cmdLanes(['fit', '--lane', 'x', '--bad'])).toBe(2);
  } finally { log.mockRestore(); error.mockRestore(); }
});
