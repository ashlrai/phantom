/** `phm route outcomes` reads the router.outcome.v1 fold of metrics/jobs.jsonl. All files are fakes under a temp dir. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdRoute } from '../src/cli/route.js';
import type { RouterOutcomeRead } from '../src/core/router/outcomes.js';

const LEDGER = [
  '{"job":"J1","lane":"alpha","model":"m1","tier":"work","phase":"MERGED","ts":"2026-11-01T00:00:00Z","cost_usd":1.5,"wall_s":120,"ci_first_pass":true,"review_findings":{"fixed":2,"rejected":0,"ignored":1}}',
  '{"job":"J2","lane":"beta","phase":"CLOSED"}',
  '{"job":"J3","pr_url":"https://github.com/o/r/pull/7","phase":"MERGED"}',
  '{"pr_url":"https://github.com/o/r/pull/7","cost_usd":0.25}',
  'not json',
].join('\n');

const dirs: string[] = [];
const logs: string[] = [];
const temp = async (ledger?: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'route-outcomes-'));
  dirs.push(dir);
  if (ledger !== undefined) {
    await mkdir(join(dir, 'metrics'));
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'), ledger);
  }
  return dir;
};
const stdout = async (args: string[]): Promise<{ code: number; report: RouterOutcomeRead | null }> => {
  logs.length = 0;
  const code = await cmdRoute(args);
  const line = logs[0];
  return { code, report: line === undefined ? null : JSON.parse(line) as RouterOutcomeRead };
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function capture(): void {
  vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => { logs.push(values.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

describe('phm route outcomes', () => {
  it('folds the jobs ledger into one router.outcome.v1 record per job', async () => {
    capture();
    const root = await temp(LEDGER);
    const { code, report } = await stdout(['outcomes', '--root', root, '--json']);
    expect(code).toBe(0);
    expect(report).toMatchObject({ state: 'read', malformed_rows: 1, unattached_rows: 0, ambiguous_urls: 0 });
    expect(report!.path).toBe(join(root, 'metrics', 'jobs.jsonl'));
    const byId = new Map(report!.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')).toMatchObject({
      schema: 'router.outcome.v1', lane: 'alpha', model: 'm1', tier: 'work',
      merged: true, ci_first_pass: true, cost_usd: 1.5, wall_s: 120, passk: null,
      review_findings: { fixed: 2, rejected: 0, ignored: 1 },
    });
    expect(byId.get('J2')).toMatchObject({ lane: 'beta', merged: false, cost_usd: null });
    // The URL-only row attached to J3 through its unambiguous PR claim.
    expect(byId.get('J3')).toMatchObject({ merged: true, cost_usd: 0.25 });
  });

  it('filters records by --lane without dropping the fold counters', async () => {
    capture();
    const root = await temp(LEDGER);
    const { code, report } = await stdout(['outcomes', '--root', root, '--lane', 'alpha', '--json']);
    expect(code).toBe(0);
    expect(report!.state).toBe('read');
    expect(report!.outcomes.map(o => o.job_id)).toEqual(['J1']);
    expect(report!.malformed_rows).toBe(1);
    const none = await stdout(['outcomes', '--root', root, '--lane', 'gamma', '--json']);
    expect(none.code).toBe(0);
    expect(none.report!.outcomes).toEqual([]);
    expect(none.report!.state).toBe('read');
  });

  it('reports a missing ledger as unknown, never as an empty read', async () => {
    capture();
    const root = await temp();
    const { code, report } = await stdout(['outcomes', '--root', root, '--json']);
    expect(code).toBe(0);
    expect(report).toMatchObject({ state: 'missing', outcomes: [], malformed_rows: 0 });
  });

  it('honors ASHLR_RUNS_DIR when --root is absent', async () => {
    capture();
    const root = await temp(LEDGER);
    const saved = process.env['ASHLR_RUNS_DIR'];
    process.env['ASHLR_RUNS_DIR'] = root;
    try {
      const { code, report } = await stdout(['outcomes', '--json']);
      expect(code).toBe(0);
      expect(report!.state).toBe('read');
      expect(report!.outcomes).toHaveLength(3);
    } finally {
      if (saved === undefined) delete process.env['ASHLR_RUNS_DIR'];
      else process.env['ASHLR_RUNS_DIR'] = saved;
    }
  });

  it('prints pretty JSON without --json and stays parseable', async () => {
    capture();
    const root = await temp(LEDGER);
    const { code, report } = await stdout(['outcomes', '--root', root]);
    expect(code).toBe(0);
    expect(report!.state).toBe('read');
    expect(report!.outcomes.length).toBeGreaterThan(0);
  });

  it.each([
    ['outcomes', '--bogus'],
    ['outcomes', '--lane'],
    ['outcomes', '--lane', '--json'],
    ['outcomes', '--root', 'relative-dir'],
    ['outcomes', '--json', '--json'],
    ['outcomes', '--lane', 'a', '--lane', 'b'],
    ['outcomes', 'extra'],
  ])('refuses bad usage %j with exit 2', async (...args: string[]) => {
    capture();
    expect(await cmdRoute(args)).toBe(2);
  });
});
