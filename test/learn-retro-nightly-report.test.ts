import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdImprove } from '../src/cli/improve.js';
import { buildNightlyReport, learnHome, NIGHTLY_REPORT_SCHEMA, nightlyProposalsPath, readNightlyReport } from '../src/core/learn/retro/store.js';
import type { NightlyState } from '../src/core/learn/retro/nightly-types.js';

let home: string;

function state(overrides: Partial<NightlyState> = {}): NightlyState {
  return {
    v: 1,
    advisoryOnly: true,
    completedNight: '2026-10-26',
    jobs: [
      { v: 1, id: 'TEST-ok', repo: 'ashlrai/phantom', arm: 'test-frontier', playbook: 'test-verify', status: 'succeeded', updatedAt: '2026-10-25T20:00:00.000Z' },
      { v: 1, id: 'TEST-bad', repo: 'ashlrai/phantom', arm: 'test-frontier', playbook: null, status: 'failed', updatedAt: '2026-10-25T21:00:00.000Z' },
    ],
    reviews: [
      { v: 1, id: 'TEST-r1', jobId: 'TEST-bad', repo: 'ashlrai/phantom', kind: 'review-block', updatedAt: '2026-10-25T22:00:00.000Z', cause: 'execution' },
    ],
    priors: [
      { repo: 'ashlrai/phantom', arm: 'test-frontier', successes: 1, failures: 1, alpha: 2, beta: 2 },
    ],
    lessons: [
      { id: 'nightly:["ashlrai/phantom","test-verify","execution"]', repo: 'ashlrai/phantom', playbook: 'test-verify', cause: 'execution', status: 'pending', text: 'Run the affected repository checks before finishing a fix.', evidence: ['job:TEST-bad', 'review:TEST-r1'] },
    ],
    proposals: [
      { id: 'nightly:["ashlrai/phantom","test-verify","execution"]', status: 'proposed', repo: 'ashlrai/phantom', lessonId: 'nightly:["ashlrai/phantom","test-verify","execution"]', title: 'Investigate recurring execution findings', prompt: 'Run the affected repository checks before finishing a fix. Inspect the local evidence references before proposing a change. This proposal grants no execution or publication authority.', evaluation: 'Add a deterministic regression fixture for the evidenced failure and run affected checks.', metric: 'Fewer matching failures or blocking review findings in subsequent comparable jobs.' },
    ],
    ...overrides,
  };
}

async function seedState(value: unknown): Promise<void> {
  await mkdir(join(home, '.ashlr'), { mode: 0o700 });
  await mkdir(learnHome(), { mode: 0o700 });
  await writeFile(nightlyProposalsPath(), typeof value === 'string' ? value : `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'phantom-nightly-report-')));
  vi.stubEnv('HOME', home);
  vi.stubEnv('ASHLR_HOME', join(home, '.ashlr'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('nightly report core', () => {
  it('reports missing state with unknown counts, never zero-filled', async () => {
    const report = await readNightlyReport();
    expect(report).toMatchObject({
      schema: NIGHTLY_REPORT_SCHEMA,
      state: 'missing',
      completedNight: null,
      counts: null,
      priors: [],
      lessons: [],
      proposals: [],
    });
    expect(report.path).toBe(nightlyProposalsPath());
  });

  it('folds a valid state into exact counts and bounded items', async () => {
    await seedState(state());
    const report = await readNightlyReport();
    expect(report.state).toBe('read');
    expect(report.completedNight).toBe('2026-10-26');
    expect(report.counts).toEqual({ jobs: 2, reviews: 1, priors: 1, lessons: 1, proposals: 1 });
    expect(report.priors[0]).toMatchObject({ repo: 'ashlrai/phantom', arm: 'test-frontier', alpha: 2, beta: 2 });
    expect(report.proposals[0]).toMatchObject({ status: 'proposed', repo: 'ashlrai/phantom' });
    expect(report.lessons[0]).toMatchObject({ status: 'pending', cause: 'execution' });
  });

  it('caps listed items at the limit while counts stay exact', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`, status: 'proposed' as const, repo: 'ashlrai/phantom', lessonId: `l${i}`,
      title: `t${i}`, prompt: 'p', evaluation: 'e', metric: 'm',
    }));
    await seedState(state({ proposals: many }));
    const report = await readNightlyReport(2);
    expect(report.limit).toBe(2);
    expect(report.proposals).toHaveLength(2);
    expect(report.proposals.map((p) => p.id)).toEqual(['p0', 'p1']);
    expect(report.counts!.proposals).toBe(5);
  });

  it.each([
    ['corrupt JSON', '{"v":1,"jobs":'],
    ['wrong shape', { v: 2, advisoryOnly: true, completedNight: '2026-10-26', jobs: [], reviews: [], priors: [], lessons: [], proposals: [] }],
    ['not advisory', { v: 1, advisoryOnly: false, completedNight: '2026-10-26', jobs: [], reviews: [], priors: [], lessons: [], proposals: [] }],
    ['bad night', { v: 1, advisoryOnly: true, completedNight: '26-10-2026', jobs: [], reviews: [], priors: [], lessons: [], proposals: [] }],
  ])('reports %s state as unreadable with unknown counts', async (_label, value) => {
    await seedState(value);
    const report = await readNightlyReport();
    expect(report.state).toBe('unreadable');
    expect(report.completedNight).toBeNull();
    expect(report.counts).toBeNull();
    expect(report.proposals).toEqual([]);
  });

  it('buildNightlyReport is a pure fold that preserves stored order', () => {
    const s = state({ proposals: [
      { id: 'b', status: 'proposed', repo: 'r', lessonId: 'l', title: 'B', prompt: 'p', evaluation: 'e', metric: 'm' },
      { id: 'a', status: 'proposed', repo: 'r', lessonId: 'l', title: 'A', prompt: 'p', evaluation: 'e', metric: 'm' },
    ] });
    const report = buildNightlyReport(s, 1);
    expect(report.state).toBe('read');
    expect(report.proposals.map((p) => p.id)).toEqual(['b']);
    expect(report.counts!.proposals).toBe(2);
  });
});

describe('phm improve nightly', () => {
  it('prints the JSON report and exits 0 for missing and read states', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdImprove(['nightly', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ schema: NIGHTLY_REPORT_SCHEMA, state: 'missing' });
    await seedState(state());
    log.mockClear();
    expect(await cmdImprove(['nightly', '--json'])).toBe(0);
    const report = JSON.parse(String(log.mock.calls[0]![0])) as { state: string; completedNight: string; counts: { proposals: number } };
    expect(report).toMatchObject({ state: 'read', completedNight: '2026-10-26' });
    expect(report.counts.proposals).toBe(1);
  });

  it('prints a human summary for a read state', async () => {
    await seedState(state());
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdImprove(['nightly'])).toBe(0);
    const out = String(log.mock.calls[0]![0]);
    expect(out).toContain('completed=2026-10-26');
    expect(out).toContain('Investigate recurring execution findings');
    expect(out).toContain('proposals (1):');
  });

  it('exits 1 on unreadable state and 2 on bad usage', async () => {
    await seedState('{broken');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdImprove(['nightly', '--json'])).toBe(1);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ state: 'unreadable', counts: null });
    expect(await cmdImprove(['nightly', '--bogus'])).toBe(2);
    expect(await cmdImprove(['nightly', '--limit', '0'])).toBe(2);
    expect(await cmdImprove(['nightly', '--limit', '201'])).toBe(2);
    expect(error).toHaveBeenCalled();
  });
});
