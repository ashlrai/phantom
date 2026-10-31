import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runTaskFrontier } from '../examples/agents/task-frontier.js';
import * as frontier from '../src/core/fleet/task-ready-frontier.js';
import { readStableRegularFile } from '../src/core/util/stable-file-read.js';

const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-frontier-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function writeSnapshot(value: unknown): string {
  const file = join(temp(), 'snapshot.json');
  writeFileSync(file, JSON.stringify(value));
  return file;
}
function run(args: string[], read?: typeof readStableRegularFile) {
  const output: string[] = [];
  const code = runTaskFrontier(args, { read, write: text => output.push(text) });
  expect(output).toHaveLength(1);
  return { code, result: JSON.parse(output[0]!) };
}

describe('task frontier example', () => {
  it('calls the real frontier for a diamond, skips completed tasks, and preserves the snapshot', () => {
    const input = { tasks: [
      { id: 'fake-root' }, { id: 'fake-left', dependsOn: ['fake-root'] },
      { id: 'fake-right', dependsOn: ['fake-root'] }, { id: 'fake-end', dependsOn: ['fake-left', 'fake-right'] },
    ], completed: ['fake-root'] };
    const file = writeSnapshot(input);
    const before = readFileSync(file, 'utf8');
    const query = vi.spyOn(frontier, 'taskReadyFrontier');
    expect(run(['--file', file])).toEqual({ code: 0, result: {
      schemaVersion: 1, status: 'ready', readyIds: ['fake-left', 'fake-right'], blockedIds: ['fake-end'],
      unknownCompletedIds: [], unresolvedDependencyIds: [],
    } });
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(input.tasks, input.completed);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('reports unknown dependencies and cycles as blocked and distinguishes external completions', () => {
    const file = writeSnapshot({ tasks: [
      { id: 'fake-unknown', dependsOn: ['fake-missing', 'fake-missing'] },
      { id: 'fake-cycle-a', dependsOn: ['fake-cycle-b'] }, { id: 'fake-cycle-b', dependsOn: ['fake-cycle-a'] },
      { id: 'fake-external', dependsOn: ['fake-done-elsewhere'] }, { id: 'fake-finished', dependsOn: ['fake-old-missing'] },
    ], completed: ['fake-finished', 'fake-done-elsewhere', 'fake-done-elsewhere'] });
    expect(run(['--file', file])).toEqual({ code: 0, result: {
      schemaVersion: 1, status: 'ready', readyIds: ['fake-external'],
      blockedIds: ['fake-unknown', 'fake-cycle-a', 'fake-cycle-b'],
      unknownCompletedIds: ['fake-done-elsewhere'], unresolvedDependencyIds: ['fake-missing', 'fake-old-missing'],
    } });
  });

  it('returns an explicit ambiguity error for duplicate task IDs', () => {
    const file = writeSnapshot({ tasks: [{ id: 'fake-dup' }, { id: 'fake-dup' }], completed: [] });
    expect(run(['--file', file])).toMatchObject({ code: 1, result: { error: { code: 'DUPLICATE_TASK_ID' } } });
  });

  it('uses the bounded stable reader, and refuses changed, linked, or oversized sources', () => {
    const file = writeSnapshot({ tasks: [{ id: 'fake-a' }], completed: [] });
    const read = vi.fn<typeof readStableRegularFile>((path, options) => readStableRegularFile(path, options));
    expect(run(['--file', file], read).code).toBe(0);
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith(resolve(file), { anchorPath: dirname(resolve(file)), maxFileBytes: 1048576, remainingBytes: 1048576 });
    expect(run(['--file', file], () => ({ ok: false, reason: 'changed-during-read' })))
      .toMatchObject({ code: 1, result: { error: { code: 'READ_FAILED' } } });
    const link = join(dirname(file), 'fake-link.json');
    symlinkSync(file, link);
    expect(run(['--file', link])).toMatchObject({ code: 2, result: { error: { code: 'INVALID_FILE' } } });
    writeFileSync(file, 'x'.repeat(1048577));
    expect(run(['--file', file])).toMatchObject({ code: 2, result: { error: { code: 'INVALID_FILE' } } });
  });

  it('rejects invalid arguments, JSON, and snapshot shapes', () => {
    expect(run([])).toMatchObject({ code: 2, result: { error: { code: 'USAGE' } } });
    for (const input of [null, {}, { tasks: [], completed: [3] }, { tasks: [{ id: ' ' }], completed: [] },
      { tasks: [{ id: 'fake-a', dependsOn: null }], completed: [] }, { tasks: [], completed: [], extra: true }]) {
      expect(run(['--file', writeSnapshot(input)])).toMatchObject({ code: 2, result: { error: { code: 'INVALID_SNAPSHOT' } } });
    }
    const file = writeSnapshot({});
    writeFileSync(file, '{');
    expect(run(['--file', file])).toMatchObject({ code: 2, result: { error: { code: 'INVALID_JSON' } } });
    expect(run(['--file', join(dirname(file), 'fake-missing')])).toMatchObject({ code: 1, result: { error: { code: 'READ_FAILED' } } });
  });

  it('runs from the command line and shows runnable input in help', () => {
    const file = writeSnapshot({ tasks: [{ id: 'fake-a' }], completed: [] });
    const cli = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
    const env = { ...process.env, HOME: temp() };
    const command = [cli, 'examples/agents/task-frontier.ts'];
    expect(JSON.parse(execFileSync(process.execPath, [...command, '--file', file], { encoding: 'utf8', env }))).toMatchObject({ readyIds: ['fake-a'] });
    expect(JSON.parse(execFileSync(process.execPath, [...command, '--help'], { encoding: 'utf8', env })).usage).toContain('"tasks"');
  }, 30000);
});
