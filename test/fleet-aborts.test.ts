import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import {
  cmdFleetAborts,
  FLEET_ABORTS_SCHEMA,
  parseAbortTs,
  summarizeFleetAborts,
} from '../src/cli/fleet-aborts.js';

afterEach(() => vi.restoreAllMocks());

const NOW = Date.parse('2026-11-04T09:50:00Z'); // 04:50 at -0500
const row = (ts: string, cls: string, lane = 'codex') => JSON.stringify({ ts, class: cls, lane, secret: 'do-not-print' });
const jsonl = (...rows: string[]) => rows.join('\n') + '\n';

// 4 abort_push rows (3 in the newest 15 minutes) and 2 pr rows.
const FIXTURE = jsonl(
  row('2026-11-04T04:20:00-0500', 'abort_push', 'devin'),
  row('2026-11-04T04:36:30-0500', 'pr'),
  row('2026-11-04T04:40:15-0500', 'abort_push'),
  row('2026-11-04T04:45:15-0500', 'abort_push'),
  row('2026-11-04T04:48:00-0500', 'abort_push'),
  row('2026-11-04T04:49:00-0500', 'pr', 'devin'),
);

async function run(text: string, args: string[] = ['--json']) {
  const reader = vi.fn(async (_path: string) => text);
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const code = await cmdFleetAborts(args, reader, () => NOW);
  expect(reader).toHaveBeenCalledExactlyOnceWith(join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl'));
  const lines = out.mock.calls.map(call => String(call[0]));
  expect(lines.join('\n')).not.toContain('do-not-print');
  return { code, lines };
}

describe('parseAbortTs', () => {
  it('adds the colon to a numeric offset', () => {
    expect(parseAbortTs('2026-11-04T04:45:15-0500')).toBe(Date.parse('2026-11-04T09:45:15Z'));
    expect(parseAbortTs('2026-11-04T04:45:15+0530')).toBe(Date.parse('2026-11-03T23:15:15Z'));
    expect(parseAbortTs('2026-11-04T04:45:15Z')).toBe(Date.parse('2026-11-04T04:45:15Z'));
    expect(parseAbortTs('nope')).toBeNull();
    expect(parseAbortTs(5)).toBeNull();
  });
});

describe('summarizeFleetAborts', () => {
  it('counts abort_ rows by class, lane and 15 minute bucket and ignores pr rows', () => {
    const report = summarizeFleetAborts(FIXTURE, NOW);
    expect(report.total).toBe(4);
    expect(report.by_class).toEqual({ abort_push: 4 });
    expect(report.by_lane).toEqual({ codex: 3, devin: 1 });
    expect(report.by_bucket).toEqual({ '2026-11-04T09:15:00.000Z': 1, '2026-11-04T09:30:00.000Z': 1, '2026-11-04T09:45:00.000Z': 2 });
    expect(report.recent_abort_push).toBe(3);
  });

  it('drops rows older than 2 hours, in the future, malformed or without a valid ts', () => {
    const text = jsonl(
      row('2026-11-04T02:49:59-0500', 'abort_push'),
      row('2026-11-04T05:00:00-0500', 'abort_push'),
      row('garbage', 'abort_push'),
      row('2026-11-04T04:00:00-0500', 'abort_cap', 'x\ny'),
    ) + 'not json\n[]\n';
    const report = summarizeFleetAborts(text, NOW);
    expect(report.by_class).toEqual({ abort_cap: 1 });
    expect(report.by_lane).toEqual({ 'x y': 1 });
    expect(report.status).toBe('ok');
  });

  it('only reads the last 3000 lines', () => {
    const old = Array.from({ length: 10 }, () => row('2026-11-04T04:00:00-0500', 'abort_old'));
    const filler = Array.from({ length: 3000 }, () => row('2026-11-04T04:00:00-0500', 'pr'));
    expect(summarizeFleetAborts(jsonl(...old, ...filler), NOW).total).toBe(0);
  });
});

describe('ashlr fleet aborts', () => {
  it('loads through the generated fleet registry', async () => {
    expect((await FLEET_SUBCOMMAND_LOADERS.aborts!()).cmdFleetAborts).toBe(cmdFleetAborts);
  });

  it('prints one line per class, GITHUB_PUSH_FAILING, and exits 1 at 3 abort_push in 15 minutes', async () => {
    const { code, lines } = await run(FIXTURE, []);
    expect(code).toBe(1);
    expect(lines).toEqual(['abort_push 4', 'GITHUB_PUSH_FAILING']);
  });

  it('emits json with the verdict', async () => {
    const { code, lines } = await run(FIXTURE);
    expect(code).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      schema: FLEET_ABORTS_SCHEMA, readOnly: true, status: 'red', verdict: 'GITHUB_PUSH_FAILING', recent_abort_push: 3,
    });
  });

  it('exits 0 when abort_push is spread over older buckets', async () => {
    const { code, lines } = await run(jsonl(
      row('2026-11-04T04:20:00-0500', 'abort_push'),
      row('2026-11-04T04:25:00-0500', 'abort_push'),
      row('2026-11-04T04:30:00-0500', 'abort_push'),
      row('2026-11-04T04:49:00-0500', 'abort_push'),
      row('2026-11-04T04:49:30-0500', 'abort_merge'),
    ), []);
    expect(code).toBe(0);
    expect(lines).toEqual(['abort_merge 1', 'abort_push 4']);
  });

  it('says so when there are no aborts', async () => {
    const { code, lines } = await run(jsonl(row('2026-11-04T04:49:00-0500', 'pr')), []);
    expect(code).toBe(0);
    expect(lines).toEqual(['No aborts in the last 2 hours.']);
  });

  it('exits 2 without echoing the error when the ledger cannot be read, and rejects bad args', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdFleetAborts(['--json'], async () => { throw new Error('secret-path'); }, () => NOW)).toBe(2);
    expect(JSON.parse(String(out.mock.calls[0]![0]))).toEqual({ schema: FLEET_ABORTS_SCHEMA, readOnly: true, error: 'Jobs ledger is unreadable.' });
    expect(await cmdFleetAborts(['--nope'])).toBe(2);
    expect(err).toHaveBeenCalled();
    expect(await cmdFleetAborts(['--help'])).toBe(0);
  });
});
