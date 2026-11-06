import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../examples/upgrade/history-upgrade-audit.js';
import { readRunsHistory, type ReadRunsHistoryOptions, type RunsHistory, type RunsSample } from '../src/core/fleet/runs-history.js';

const now = Date.parse('2026-10-31T12:00:00.000Z');
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const sample = (minutesAgo: number): RunsSample => ({
  at: at(minutesAgo), lanes: [], workers: 1, leaders: 1, paused: false,
});
const args = ['--max-gap-minutes', '10', '--hours', '1'];
let root: string;
let file: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fake-history-audit-'));
  file = join(root, 'history.jsonl');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function audit(argv = args, read = (options: ReadRunsHistoryOptions) => readRunsHistory({ ...options, file, now: () => now })) {
  let output = '';
  const code = await run(argv, { read, write: text => { output += text; } });
  return { code, output, json: JSON.parse(output) };
}
const history = (samples: RunsSample[], extra: Partial<RunsHistory> = {}): RunsHistory => ({
  v: 1, generatedAt: at(0), from: at(60), to: at(0), sourceState: 'healthy', dropped: 0, samples, ...extra,
});

describe('history upgrade audit', () => {
  it('reads retained restart observations, sorting a copy and reporting a long gap and malformed row', async () => {
    const rows = [sample(60), sample(59), sample(5), sample(5), sample(10), sample(0)];
    const content = `${rows.map(row => JSON.stringify(row)).join('\n')}\n{bad-json\n`;
    await writeFile(file, content);
    const read = vi.fn((options: ReadRunsHistoryOptions) => readRunsHistory({ ...options, file, now: () => now }));
    const before = await read({ hours: 1 });
    const { code, json } = await audit(args, async () => before);
    expect(code).toBe(1);
    expect(json).toMatchObject({
      schema: 'phantom.history-upgrade-audit.v1', status: 'mismatch', sampleCount: 6, distinctInstants: 5,
      firstObservation: at(60), lastObservation: at(0), sourceState: 'degraded', dropped: 1,
      gapCount: 1, gaps: [{ from: at(59), to: at(10), minutes: 49 }], gapsTruncated: false,
    });
    expect(before.samples).toEqual(rows);
    expect(await readFile(file, 'utf8')).toBe(content);
    expect(read).toHaveBeenCalledWith({ hours: 1 });
  });

  it('verifies retained observations after restart when every interval meets the threshold', async () => {
    const rows = [60, 50, 40, 30, 20, 10, 0].map(sample);
    const content = `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;
    await writeFile(file, content);
    expect((await audit()).json).toMatchObject({ status: 'verified', sampleCount: 7, gapCount: 0 });
    const restarted = await audit();
    expect(restarted.code).toBe(0);
    expect(restarted.json).toMatchObject({ sourceState: 'healthy', firstObservation: at(60), lastObservation: at(0) });
    expect(await readFile(file, 'utf8')).toBe(content);
  });

  it('reads the same retained fixture across separate executable runs', async () => {
    const instant = Date.now();
    const rows = [instant - 120_000, instant - 60_000].map(time => ({ ...sample(0), at: new Date(time).toISOString() }));
    const content = `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;
    await writeFile(file, content);
    const script = resolve('examples/upgrade/history-upgrade-audit.ts');
    const env = { HOME: root, PATH: process.env.PATH, ASHLR_RUNS_HISTORY_FILE: file };
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), script,
        '--hours', '1', '--max-gap-minutes', '60'], { encoding: 'utf8', env });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'verified', sampleCount: 2 });
    }
    expect(await readFile(file, 'utf8')).toBe(content);
  }, 30_000);

  it('distinguishes missing, single, duplicate-only and degraded evidence from continuity', async () => {
    expect(await audit()).toMatchObject({ code: 3, json: { status: 'insufficient', sourceState: 'missing', sampleCount: 0 } });
    await writeFile(file, `${JSON.stringify(sample(30))}\n`);
    expect(await audit()).toMatchObject({ code: 3, json: { status: 'insufficient', sampleCount: 1, gapCount: 2 } });
    await writeFile(file, `${JSON.stringify(sample(30))}\n${JSON.stringify(sample(30))}\n`);
    expect(await audit()).toMatchObject({ code: 3, json: { sampleCount: 2, distinctInstants: 1 } });
    await writeFile(file, `${[60, 50, 40, 30, 20, 10, 0].map(n => JSON.stringify(sample(n))).join('\n')}\ninvalid\n`);
    expect(await audit()).toMatchObject({ code: 3, json: { status: 'insufficient', sourceState: 'degraded', dropped: 1, gapCount: 0 } });
  });

  it('includes window edges, excludes future rows, and requires strict threshold exceedance', async () => {
    const data = history([sample(50), sample(40), sample(30), sample(20), sample(10), sample(-1)]);
    const original = [...data.samples];
    const result = await audit(args, async () => data);
    expect(result).toMatchObject({ code: 3, json: { sampleCount: 5, futureSamples: 1, gapCount: 0 } });
    expect(data.samples).toEqual(original);
    const edge = await audit(args, async () => history([sample(49), sample(10)]));
    expect(edge.json).toMatchObject({ status: 'mismatch', gapCount: 2, gaps: [
      { from: at(60), to: at(49), minutes: 11 }, { from: at(49), to: at(10), minutes: 39 },
    ] });
  });

  it('bounds gap output while retaining the total', async () => {
    const rows = Array.from({ length: 121 }, (_, i) => sample(60 - i * 0.5));
    const { json } = await audit(['--max-gap-minutes', '0.1', '--hours', '1'], async () => history(rows));
    expect(json).toMatchObject({ status: 'mismatch', gapCount: 120, gapsTruncated: true });
    expect(json.gaps).toHaveLength(100);
  });

  it('validates arguments without reading and passes the default and boundary hours to the reader', async () => {
    const read = vi.fn(async () => history([]));
    for (const argv of [[], ['--help', '--hours', '1'], ['--max-gap-minutes'], ['--max-gap-minutes', '0'],
      ['--max-gap-minutes', 'Infinity'], ['--max-gap-minutes', '1', '--hours', '0'],
      ['--max-gap-minutes', '1', '--hours', '169'], ['--max-gap-minutes', '1', '--hours', '1.5'],
      ['--max-gap-minutes', '1', '--max-gap-minutes', '2'], ['--other', '1']]) {
      expect(await audit(argv, read)).toMatchObject({ code: 2, json: { error: expect.any(String) } });
    }
    expect(read).not.toHaveBeenCalled();
    for (const [argv, hours] of [[['--max-gap-minutes', '1'], 24], [['--max-gap-minutes', '1', '--hours', '1'], 1],
      [['--hours', '168', '--max-gap-minutes', '1'], 168]] as const) {
      await audit([...argv], read);
      expect(read).toHaveBeenLastCalledWith({ hours });
    }
  });

  it('returns static errors for reader failures and rejects invalid reader times', async () => {
    const thrown = await audit(args, async () => { throw new Error('/fake/private/path'); });
    expect(thrown).toMatchObject({ code: 1, json: { error: 'Unable to audit history.' } });
    expect(thrown.output).not.toContain('/fake/private/path');
    expect((await audit(args, async () => history([], { from: 'invalid' }))).code).toBe(1);
  });

  it('shows help without reading and guards direct execution on import', async () => {
    const read = vi.fn();
    let output = '';
    expect(await run(['--help'], { read, write: text => { output += text; } })).toBe(0);
    expect(output).toContain('--max-gap-minutes');
    expect(read).not.toHaveBeenCalled();
    const script = resolve('examples/upgrade/history-upgrade-audit.ts');
    const env = { HOME: root, PATH: process.env.PATH };
    const help = spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), script, '--help'], { encoding: 'utf8', env });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--max-gap-minutes');
    const imported = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import ${JSON.stringify(script)}`], { encoding: 'utf8', env });
    expect(imported.status).toBe(0);
    expect(imported.stdout).toBe('');
  }, 30_000);
});
