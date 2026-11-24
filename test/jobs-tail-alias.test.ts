import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdJobs } from '../src/cli/jobs-empty.js';

let runs: string;
beforeEach(async () => { runs = await mkdtemp(join(tmpdir(), 'jobs-tail-alias-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(runs, { recursive: true, force: true }); });

describe('phm jobs tail', () => {
  it('is the same stream as `phm job tail`: last lines of a fixture log', async () => {
    await writeFile(join(runs, 'JOB1.log'), 'one\ntwo\nthree\n');
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await cmdJobs(['tail', 'JOB1', '--lines', '2', '--runs-dir', runs]);
    const printed = out.mock.calls.map(c => String(c[0])).join('\n');
    expect(code).toBe(0);
    expect(printed).toContain('three');
    expect(printed).not.toContain('one');
  });

  it('needs a job id', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdJobs(['tail'])).toBe(2);
  });
});
