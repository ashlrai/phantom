import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRunsRead } from '../src/cli/fleet-runs-read.js';
import { readLeaderJournal } from '../src/core/fleet/leader-journal.js';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import { readFleetQueue } from '../src/core/fleet/runs-parked-queue.js';

const dirs: string[] = [];
const now = Date.parse('2026-10-31T12:00:00Z');
let output: string[];
let errors: string[];

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'journal-rejections-'));
  dirs.push(dir);
  const drop = join(dir, 'leader/drop');
  await mkdir(drop, { recursive: true });
  const journal = vi.fn(() => readLeaderJournal({ runsDir: dir, now: () => now }));
  return { dir, drop, deps: { runs: vi.fn(readFleetRunsDirState), journal, parked: vi.fn(readFleetQueue) } };
}

beforeEach(() => {
  output = []; errors = [];
  vi.spyOn(console, 'log').mockImplementation(message => { output.push(String(message)); });
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { errors.push(String(chunk)); return true; });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('fleet journal rejections-only', () => {
  it('projects real journal artifacts in JSON and text without changing the default', async () => {
    const { dir, drop, deps } = await setup();
    await writeFile(join(dir, 'leader/PLAN-LOG.md'), '## fake pass\n**fake section**\n- fake pass detail\n');
    await writeFile(join(drop, 'ingested.tsv'), '2026-10-31T11:30:00Z\tRQ-FAKE-OK\tfake-leader\tfake-lane\tfake-tier\tfake title\n');
    await writeFile(join(drop, 'ingest.log'), [
      '2026-10-31T11:30:00Z reject RQ-FAKE-BAD.md invalid lane',
      '2026-10-31T11:35:00Z accept RQ-FAKE-OK.md reject mentioned in reason',
      '2026-10-31T11:40:00Z ReJeCtEd RQ-FAKE-OTHER.md fake failure',
      '2026-10-31T11:45:00Z rejection-note RQ-FAKE-UNKNOWN.md reject',
    ].join('\n'));
    const original = await readLeaderJournal({ runsDir: dir, now: () => now });
    expect(original.passes).toHaveLength(1);
    expect(original.ingested).toHaveLength(1);
    expect(original.ingest).toHaveLength(4);
    expect(await cmdFleetRunsRead('journal', ['--json'], deps)).toBe(0);
    expect(JSON.parse(output.pop()!)).toEqual(original);
    expect(await cmdFleetRunsRead('journal', ['--json', '--rejections-only'], deps)).toBe(0);
    expect(JSON.parse(output.pop()!)).toEqual({ ...original, passes: [], ingested: [],
      ingest: [original.ingest[1], original.ingest[3]],
      rejectionsFilter: { global: ['sources', 'rejectedLastHour'], omitted: ['passes', 'ingested'] } });
    expect(original.rejectedLastHour).toBe(1);
    expect(await cmdFleetRunsRead('journal', ['--rejections-only'], deps)).toBe(0);
    const text = output.pop()!;
    expect(text).toContain('source health and rejected last hour are global');
    expect(text).toContain('planLog=healthy ingestLog=healthy ingested=healthy');
    expect(text).toContain('Rejected last hour: 1');
    expect(text).toContain('reject RQ-FAKE-BAD.md: invalid lane');
    expect(text).toContain('ReJeCtEd RQ-FAKE-OTHER.md: fake failure');
    expect(text).not.toMatch(/fake pass detail|fake title|RQ-FAKE-OK|RQ-FAKE-UNKNOWN/);
  });

  it('preserves missing and degraded sources and unknown count', async () => {
    const { dir, drop, deps } = await setup();
    await mkdir(join(dir, 'leader/PLAN-LOG.md'));
    await writeFile(join(drop, 'ingested.tsv'), 'fake\tRQ-FAKE\tfake\tfake\tfake\tfake\n');
    expect(await cmdFleetRunsRead('journal', ['--rejections-only', '--json'], deps)).toBe(0);
    expect(JSON.parse(output.pop()!)).toMatchObject({
      sources: { planLog: 'degraded', ingestLog: 'missing', ingested: 'healthy' },
      rejectedLastHour: null, passes: [], ingest: [], ingested: [],
    });
    expect(await cmdFleetRunsRead('journal', ['--rejections-only'], deps)).toBe(0);
    expect(output.pop()).toContain('Rejected last hour: unknown');
  });

  it('filters each watch sample using the real reader', async () => {
    const { drop, deps } = await setup();
    await writeFile(join(drop, 'ingest.log'), 'reject first.md fake\naccept ok.md fake\n');
    const controller = new AbortController();
    let ticks = 0;
    const wait = async () => {
      if (++ticks === 1) await writeFile(join(drop, 'ingest.log'), 'reject second.md fake\n');
      else controller.abort();
    };
    expect(await cmdFleetRunsRead('journal', ['--watch', '--json', '--rejections-only'], deps, { signal: controller.signal, wait })).toBe(0);
    expect(output.map(line => JSON.parse(line).ingest.map((row: { file: string }) => row.file))).toEqual([['first.md'], ['second.md']]);
  });

  it('validates scope, duplicates and help before reading', async () => {
    const { deps } = await setup();
    for (const verb of ['runs', 'parked'] as const) {
      expect(await cmdFleetRunsRead(verb, ['--rejections-only'], deps)).toBe(2);
      expect(await cmdFleetRunsRead(verb, ['--help', '--rejections-only'], deps)).toBe(2);
    }
    expect(await cmdFleetRunsRead('journal', ['--rejections-only', '--rejections-only'], deps)).toBe(2);
    expect(await cmdFleetRunsRead('journal', ['--help'], deps)).toBe(0);
    expect(output.pop()).toContain('--rejections-only');
    expect(deps.runs).not.toHaveBeenCalled();
    expect(deps.journal).not.toHaveBeenCalled();
    expect(deps.parked).not.toHaveBeenCalled();
    expect(errors).toHaveLength(5);
  });
});
