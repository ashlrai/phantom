import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetMergePlan } from '../src/cli/fleet-merge-plan.js';
import type { MergePlanReport } from '../src/core/fleet/merge-plan.js';

it('reports incomplete evidence and supersession as data without changing the input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'merge-plan-owner-'));
  try {
    const path = join(dir, 'snapshot.json');
    const bytes = '[\n  {"number":100,"title":"synthetic origin","state":"OPEN"},\n  {"number":101,"title":"bridge: RQ-FIX-PHANTOM-100","state":"OPEN"}\n]\n';
    await writeFile(path, bytes);
    const readText = vi.fn((file: string) => readFile(file, 'utf8'));
    const prompts = vi.fn(async () => new Map<string, string>());
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await cmdFleetMergePlan(['--input', path, '--repo', 'example/phantom', '--json'], {
      readText, prompts, stdout: text => stdout.push(text), stderr: text => stderr.push(text),
      now: () => new Date('2026-11-10T18:00:00Z'),
    });
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join('')) as MergePlanReport;
    expect(report.throughput).toBeNull();
    expect(report.open.states_evidence).toBe('unknown');
    expect(report.actions.rebase_candidates).toEqual({ state: 'unknown', count: 0, prs: [] });
    expect(report.duplicates.state).toBe('no-body-evidence');
    expect(report.actions.superseded_merged.state).toBe('no-merged-rows');
    expect(report.actions.superseded_open).toBe(1);
    expect(report.duplicates.proposals).toEqual([
      expect.objectContaining({ number: 100, supersededBy: 101, kind: 'origin', reason: expect.stringContaining('#101') }),
    ]);
    expect(readText).toHaveBeenCalledTimes(1);
    expect(readText).toHaveBeenCalledWith(path);
    expect(prompts).not.toHaveBeenCalled();
    expect(await readFile(path, 'utf8')).toBe(bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
