import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetReadyDups, inspectReadyDups } from '../src/cli/fleet-ready-dups.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

let root = '';
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); root = ''; });

describe('fleet ready-dups', () => {
  it('reports every affected row and overlapping reasons by lane', async () => {
    root = await mkdtemp(join(tmpdir(), 'ready-dups-'));
    await writeFile(join(root, 'prompt.md'), 'fixture');
    const ready = ['# comment', 'id\trepo\tlane\ttier\tprompt', 'RQ-A\tphantom\tone\twork\tprompt.md', 'RQ-A\tphantom\ttwo\twork\tmissing.md', 'RQ-B\tphantom\tone\twork\tprompt.md', 'RQ-C\tphantom\tone\twork\tprompt.md'].join('\r\n');
    const jobs = [JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'RQ-A' }), JSON.stringify({ event: 'outcome', state: 'MERGED', job_id: 'RQ-B' }), JSON.stringify({ event: 'launch', state: 'MERGED', job: 'RQ-C' })].join('\n');
    const report = await inspectReadyDups(ready, jobs, root);
    expect(report.total).toEqual({ rows: 3, duplicate: 2, missingPrompt: 1, merged: 3 });
    expect(report.lanes.two).toEqual({ rows: 1, duplicate: 1, missingPrompt: 1, merged: 1 });
    expect(report.rows.map(row => [row.line, row.id, row.reasons])).toEqual([[3, 'RQ-A', ['duplicate', 'merged']], [4, 'RQ-A', ['duplicate', 'missingPrompt', 'merged']], [5, 'RQ-B', ['merged']]]);
  });
  it('dispatches JSON through the registry and fails when evidence is unavailable', async () => {
    root = await mkdtemp(join(tmpdir(), 'ready-dups-'));
    await mkdir(join(root, 'queue')); await mkdir(join(root, 'metrics'));
    await writeFile(join(root, 'queue', 'ready.tsv'), 'RQ-X\tphantom\tlane\twork\tmissing\n');
    await writeFile(join(root, 'metrics', 'jobs.jsonl'), '');
    vi.stubEnv('ASHLR_RUNS_DIR', root);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const module = await FLEET_SUBCOMMAND_LOADERS['ready-dups']!();
    expect(module.cmdFleetReadyDups).toBe(cmdFleetReadyDups);
    expect(await cmdFleetReadyDups(['--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]![0])).total.missingPrompt).toBe(1);
    expect(await cmdFleetReadyDups([])).toBe(0);
    expect(log.mock.calls[1]![0]).toContain('Affected ready rows: 1');
    await writeFile(join(root, 'metrics', 'jobs.jsonl'), '{broken');
    expect(await cmdFleetReadyDups([])).toBe(1);
    await rm(join(root, 'metrics', 'jobs.jsonl'));
    expect(await cmdFleetReadyDups([])).toBe(1);
    expect(error).toHaveBeenCalled();
    expect(await cmdFleetReadyDups(['--bad'])).toBe(2);
  });
});
