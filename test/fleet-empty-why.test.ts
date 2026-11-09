import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { classifyEmptyLog, cmdFleetEmptyWhy, emptyJobs, FLEET_EMPTY_WHY_SCHEMA } from '../src/cli/fleet-empty-why.js';

afterEach(() => { vi.restoreAllMocks(); delete process.env.ASHLR_RUNS_DIR; });

const NOW = Date.parse('2026-11-04T10:00:00Z');
const out = (job: string, ts: string, lane = 'codex', extra: object = {}) =>
  JSON.stringify({ event: 'outcome', job, ts, lane, empty: true, ...extra });
const LEDGER = [
  out('A1', '2026-11-04T04:00:00-0500'),
  out('B2', '2026-11-04T04:10:00-0500', 'devin'),
  out('C3', '2026-11-04T04:20:00-0500'),
  out('D4', '2026-11-04T04:30:00-0500', 'devin'),
  out('E5', '2026-11-04T04:40:00-0500'),
  out('A1', '2026-11-04T04:41:00-0500'), // duplicate
  out('OLD', '2026-11-01T04:00:00-0500'),
  out('../evil', '2026-11-04T04:00:00-0500'),
  JSON.stringify({ event: 'outcome', job: 'NE', ts: '2026-11-04T04:00:00-0500', empty: false }),
  'not json',
].join('\n');
const LOGS: Record<string, string> = {
  'metrics/jobs.jsonl': LEDGER,
  'A1.log': 'x\nESLint couldn\'t find config\n',
  'B2.log': 'work\nexited 130\n',
  'C3.log': 'task is blocked\n',
  'D4.log': 'You hit your usage limit\n',
};

async function run(args: string[]) {
  process.env.ASHLR_RUNS_DIR = '/runs';
  const paths: string[] = [];
  const reader = vi.fn(async (p: string) => { paths.push(p); return LOGS[p.slice('/runs/'.length)] ?? null; });
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const code = await cmdFleetEmptyWhy(args, reader, () => NOW);
  return { code, text: log.mock.calls.map(c => c[0]).join('\n'), paths };
}

describe('fleet empty-why', () => {
  it('is registered', () => expect(FLEET_SUBCOMMAND_LOADERS['empty-why']).toBeTypeOf('function'));

  it('classifies logs by the first matching rule', () => {
    expect(classifyEmptyLog('lib/cli failed; blocked')).toBe('lint-env');
    expect(classifyEmptyLog('Exited 130')).toBe('interrupted');
    expect(classifyEmptyLog('not implemented')).toBe('blocked');
    expect(classifyEmptyLog('Rate limit hit')).toBe('limit');
    expect(classifyEmptyLog('fine')).toBe('other');
    expect(classifyEmptyLog(null)).toBe('other');
    expect(classifyEmptyLog('eslint\n' + 'x\n'.repeat(60))).toBe('other'); // outside the last 60 lines
  });

  it('filters to distinct in-window empty outcomes with safe ids', () => {
    expect(emptyJobs(LEDGER, NOW, 24).map(j => j.id)).toEqual(['A1', 'B2', 'C3', 'D4', 'E5']);
    expect(emptyJobs(LEDGER, NOW, 100).map(j => j.id)).toContain('OLD');
  });

  it('reports counts per reason and lane as JSON, reading ASHLR_RUNS_DIR', async () => {
    const { code, text, paths } = await run(['--json']);
    expect(code).toBe(0);
    expect(paths[0]).toBe('/runs/metrics/jobs.jsonl');
    const r = JSON.parse(text);
    expect(r.schema).toBe(FLEET_EMPTY_WHY_SCHEMA);
    expect(r.total).toBe(5);
    expect(r.by_reason).toEqual({ 'lint-env': 1, interrupted: 1, blocked: 1, limit: 1, other: 1 });
    expect(r.by_lane.devin).toEqual({ 'lint-env': 0, interrupted: 1, blocked: 0, limit: 1, other: 0 });
    expect(r.ids.other).toEqual(['E5']);
  });

  it('honours --hours and prints plain text', async () => {
    expect((await run(['--hours', '0.25'])).text).toBe('No empty jobs in the last 0.25 hours.');
    const t = (await run([])).text;
    expect(t).toContain('5 empty jobs in the last 24 hours');
    expect(t).toContain('interrupted 1: B2');
  });

  it('rejects bad arguments and reports an unreadable ledger', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdFleetEmptyWhy(['--hours', '0'])).toBe(2);
    expect(await cmdFleetEmptyWhy(['--bogus'])).toBe(2);
    expect(err).toHaveBeenCalledTimes(2);
    process.env.ASHLR_RUNS_DIR = '/runs';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetEmptyWhy(['--json'], async () => null)).toBe(2);
  });
});
