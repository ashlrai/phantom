import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetReadyBad, inspectReadyBad } from '../src/cli/fleet-ready-bad.js';

let root = '';
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

describe('fleet ready-bad', () => {
  it('assigns the first failure, counts all rows and limits the sample', async () => {
    root = await mkdtemp(join(tmpdir(), 'ready-bad-'));
    const runs = join(root, 'runs'), prompts = join(runs, 'queue', 'prompts');
    await mkdir(prompts, { recursive: true });
    await mkdir(join(root, 'Projects', 'ashlrai', 'phantom'), { recursive: true });
    const prompt = join(prompts, 'job.md');
    await writeFile(prompt, 'fixture');
    const outside = join(root, 'outside.md'); await writeFile(outside, 'fixture');
    await symlink(outside, join(prompts, 'escape.md'));
    const row = (id: string, repo = 'phantom', lane = 'devin', tier = 'mid', file = prompt) => [id, repo, lane, tier, file].join('\t');
    const text = ['# comment', '', row('OK'), 'short\trow', row('bad id'), row('LANE', 'phantom', 'nope'), row('TIER', 'phantom', 'devin', 'standard'), row('REPO', '../escape'), row('MISSING', 'phantom', 'devin', 'mid', join(prompts, 'missing')), row('ESCAPE', 'phantom', 'devin', 'mid', join(prompts, 'escape.md')), ...Array.from({ length: 8 }, (_, i) => row(`BAD${i}`, 'phantom', 'nope'))].join('\n');
    const report = await inspectReadyBad(text, runs, root);
    expect(report.total).toBe(15);
    expect(Object.values(report.counts)).toEqual([1, 1, 9, 1, 1, 2]);
    expect(report.rows).toHaveLength(10);
    expect(report.rows[0]).toEqual({ line: 4, id: 'short', reason: 'under 5 fields' });
    expect(report.rows[1]?.id).toBeNull();
  });
  it('supports JSON, reports missing input and rejects unknown flags', async () => {
    root = await mkdtemp(join(tmpdir(), 'ready-bad-'));
    vi.stubEnv('ASHLR_RUNS_DIR', root);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetReadyBad(['--json'])).toBe(1);
    await mkdir(join(root, 'queue')); await writeFile(join(root, 'queue', 'ready.tsv'), 'one\ttwo\n');
    expect(await cmdFleetReadyBad(['--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).total).toBe(1);
    expect(await cmdFleetReadyBad([])).toBe(0);
    expect(log.mock.calls.some(call => call[0] === 'under 5 fields: 1')).toBe(true);
    expect(await cmdFleetReadyBad(['--bad'])).toBe(2);
    expect(error).toHaveBeenCalledTimes(2);
  });
});
