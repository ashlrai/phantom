import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdWorktrees, reportWorktrees } from '../src/cli/worktrees.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('worktrees report', () => {
  it('reports fixture data without following links or changing files', () => {
    const root = mkdtempSync(join(tmpdir(), 'worktree-report-')); roots.push(root);
    const job = join(root, 'job'); mkdirSync(job); mkdirSync(join(job, 'nested'));
    writeFileSync(join(job, 'status.json'), '{"state":"running"}');
    writeFileSync(join(job, 'nested', 'run.log'), 'hello');
    const time = new Date('2024-01-01T00:00:00Z'); utimesSync(join(job, 'nested', 'run.log'), time, time);
    symlinkSync(root, join(job, 'link'));
    const before = readFileSync(join(job, 'status.json'), 'utf8');
    const [row] = reportWorktrees(root);
    expect(row).toMatchObject({ name: 'job', path: job, lastLogMtime: time.toISOString(), jobState: 'running' });
    expect(row!.ageMs).toBeGreaterThanOrEqual(0);
    expect(row!.sizeBytes).toBeGreaterThanOrEqual(24);
    expect(readFileSync(join(job, 'status.json'), 'utf8')).toBe(before);
  });
  it('handles missing and malformed status and renders JSON and table', () => {
    const root = mkdtempSync(join(tmpdir(), 'worktree-report-')); roots.push(root);
    mkdirSync(join(root, 'a')); mkdirSync(join(root, 'b'));
    writeFileSync(join(root, 'b', 'status.json'), '{');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(cmdWorktrees(['report', '--dir', root, '--json'])).toBe(0);
    expect(JSON.parse(String(output.mock.calls[0]![0])).map((row: { jobState: string | null }) => row.jobState)).toEqual([null, null]);
    output.mockClear();
    expect(cmdWorktrees(['report', '--dir', root])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('LAST LOG MTIME');
    expect(output).toHaveBeenCalledTimes(3);
  });
  it('rejects invalid arguments and missing directories', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(cmdWorktrees(['report', '--bad'])).toBe(1);
    expect(cmdWorktrees(['report', '--dir'])).toBe(1);
    expect(cmdWorktrees(['report', '--dir', '/nonexistent-worktree-report'])).toBe(1);
  });
  it.each([['--help'], ['-h'], ['report', '--help'], ['report', '-h']])('prints usage and exits 0 for %j', (...args: string[]) => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(cmdWorktrees(args)).toBe(0);
    expect(String(output.mock.calls[0]![0])).toContain('Usage: phm worktrees report');
  });
});
