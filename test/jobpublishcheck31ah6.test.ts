import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { cmdFleetJobRead } from '../src/cli/fleet-job-read.js';
import { getFleetJobChanges } from '../src/core/fleet/runs-job-changes.js';
import { getFleetJobDetail } from '../src/core/fleet/runs-job-detail.js';

const pr = 'https://github.com/example/project/pull/123';
let home: string;
let runs: string;
let output: string[];
let errors: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'job-publish-check-'));
  runs = join(home, '.ashlr-runs');
  await mkdir(runs);
  vi.stubEnv('HOME', home);
  output = [];
  errors = '';
  vi.spyOn(console, 'log').mockImplementation((message: unknown) => { output.push(String(message)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { errors += String(chunk); return true; });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

describe('fleet job published handoff check', () => {
  it('routes through fleet and returns the normal detail with a passing evidence check', async () => {
    await writeFile(join(runs, 'JOB1.publish'), `RESULT PR ${pr}\nTEST isolated suite exit 0\n`);
    expect(await cmdFleet(['job', 'JOB1', '--json'])).toBe(0);
    const detail = JSON.parse(output.pop()!);
    expect(detail).not.toHaveProperty('check');

    expect(await cmdFleet(['job', 'JOB1', '--require-published', '--json'])).toBe(0);
    expect(output).toHaveLength(1);
    const { check, ...checkedDetail } = JSON.parse(output[0]!);
    expect(checkedDetail).toEqual({ ...detail, generatedAt: checkedDetail.generatedAt });
    expect(check).toEqual({ kind: 'published_handoff_evidence', ok: true, hasPrUrl: true, hasTestLine: true });
    expect(checkedDetail.publish).toMatchObject({ prUrl: pr, testLine: 'TEST isolated suite exit 0' });
    expect(errors).toBe('');
  });

  it.each([
    ['missing', null, false, false],
    ['PR only', `RESULT PR ${pr}\n`, true, false],
    ['test only', 'TEST suite passed\n', false, true],
    ['empty', '', false, false],
  ])('reports %s evidence and exits 1', async (_name, content, hasPrUrl, hasTestLine) => {
    if (content !== null) await writeFile(join(runs, 'JOB1.publish'), content);
    expect(await cmdFleet(['job', 'JOB1', '--json', '--require-published'])).toBe(1);
    expect(output).toHaveLength(1);
    const result = JSON.parse(output[0]!);
    expect(result).toMatchObject({
      schema: 'fleet.job.v1', job: 'JOB1',
      check: { kind: 'published_handoff_evidence', ok: false, hasPrUrl, hasTestLine },
    });
    expect(errors).toBe('');
  });

  it('does not treat blank fields as evidence and does not change old detail behavior', async () => {
    const detail = await getFleetJobDetail('JOB1', { runsDir: runs });
    detail.publish = { prUrl: '  ', testLine: ' ', autoMerge: null, sensitive: null };
    const deps = { detail: vi.fn().mockResolvedValue(detail), changes: getFleetJobChanges };
    expect(await cmdFleetJobRead(['JOB1', '--require-published', '--json'], deps)).toBe(1);
    expect(JSON.parse(output.pop()!).check).toMatchObject({ ok: false, hasPrUrl: false, hasTestLine: false });
    expect(await cmdFleetJobRead(['JOB1', '--json'], deps)).toBe(0);
    expect(JSON.parse(output.pop()!)).toEqual(detail);
    expect(await cmdFleetJobRead(['JOB1'], deps)).toBe(0);
    expect(output.pop()).toContain('Fleet job JOB1:');
  });

  it('rejects incompatible, missing and duplicate flags before reading', async () => {
    const detail = vi.fn<typeof getFleetJobDetail>();
    const changes = vi.fn<typeof getFleetJobChanges>();
    for (const args of [
      ['JOB1', '--require-published'],
      ...['--changes', '--log', '--prompt', '--notes'].map(mode => ['JOB1', '--json', '--require-published', mode]),
      ['JOB1', '--json', '--require-published', '--require-published'],
      ['JOB1', '--json', '--log', '--log-find', '--require-published'],
    ]) {
      expect(await cmdFleetJobRead(args, { detail, changes })).toBe(2);
    }
    expect(detail).not.toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();
    expect(output).toEqual([]);
    expect(errors).toContain('invalid fleet job arguments');
  });

  it('documents the contract through the public dispatcher', async () => {
    expect(await cmdFleet(['job', '--help'])).toBe(0);
    expect(output.join('\n')).toContain('--require-published requires --json and default detail mode');
    expect(output.join('\n')).toContain('published handoff evidence');
    expect(output.join('\n')).toContain('exit 1 if either is absent');
    expect(output.join('\n')).toContain('does not verify a merge');
  });

  it('returns 1 without exposing a thrown reader error or corrupting stdout', async () => {
    const detail = vi.fn<typeof getFleetJobDetail>().mockRejectedValue(new Error('/private/fixture'));
    expect(await cmdFleetJobRead(['JOB1', '--json', '--require-published'], { detail, changes: getFleetJobChanges })).toBe(1);
    expect(output).toEqual([]);
    expect(errors).toBe('error: fleet job unavailable\n');
  });
});
