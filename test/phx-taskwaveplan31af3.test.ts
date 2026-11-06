import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runTaskWavePlan } from '../examples/agents/task-wave-plan.js';

const directories: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), 'fake-wave-plan-'));
  directories.push(path);
  return path;
}
function run(input: unknown) {
  let output = '';
  const text = JSON.stringify(input);
  const code = runTaskWavePlan(['--file', 'fake-snapshot.json'], {
    read: () => ({ ok: true, text, bytesRead: Buffer.byteLength(text), mtimeMs: 0 }),
    write: value => { output += value; },
  });
  return { code, result: JSON.parse(output) };
}
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('hypothetical task wave planning', () => {
  it('plans a chain one wave at a time', () => {
    const { code, result } = run({ tasks: [
      { id: 'fake-a' }, { id: 'fake-b', dependsOn: ['fake-a'] }, { id: 'fake-c', dependsOn: ['fake-b'] },
    ], completed: [] });
    expect(code).toBe(0);
    expect(result.waves).toEqual([['fake-a'], ['fake-b'], ['fake-c']]);
    expect(result.maximumPotentialParallelism).toBe(1);
    expect(result.unresolved).toEqual([]);
    expect(result.notice).toMatch(/HYPOTHETICAL PLANNING ONLY.*not actual completions.*worker capacity.*dispatch authorization/);
  });

  it('plans diamond and independent tasks in source order at every wave', () => {
    const { result } = run({ tasks: [
      { id: 'fake-end', dependsOn: ['fake-left', 'fake-right'] },
      { id: 'fake-right', dependsOn: ['fake-root'] },
      { id: 'fake-extra' }, { id: 'fake-root' },
      { id: 'fake-left', dependsOn: ['fake-root'] },
      { id: 'fake-last', dependsOn: ['fake-extra'] },
    ], completed: [] });
    expect(result.waves).toEqual([['fake-extra', 'fake-root'], ['fake-right', 'fake-left', 'fake-last'], ['fake-end']]);
    expect(result.maximumPotentialParallelism).toBe(3);
    expect(result.unresolved).toEqual([]);
  });

  it('reports direct missing external dependencies and retains downstream unresolved tasks', () => {
    const { result } = run({ tasks: [
      { id: 'fake-ready' },
      { id: 'fake-blocked', dependsOn: ['fake-absent', 'fake-ready', 'fake-absent', 'fake-other'] },
      { id: 'fake-downstream', dependsOn: ['fake-blocked'] },
    ], completed: [] });
    expect(result.waves).toEqual([['fake-ready']]);
    expect(result.unresolved).toEqual([
      { id: 'fake-blocked', missingExternalDependencies: ['fake-absent', 'fake-other'] },
      { id: 'fake-downstream', missingExternalDependencies: [] },
    ]);
  });

  it('leaves cycles and their dependents unresolved', () => {
    const { result } = run({ tasks: [
      { id: 'fake-a', dependsOn: ['fake-b'] }, { id: 'fake-b', dependsOn: ['fake-a'] },
      { id: 'fake-self', dependsOn: ['fake-self'] }, { id: 'fake-tail', dependsOn: ['fake-a'] },
    ], completed: [] });
    expect(result.waves).toEqual([]);
    expect(result.maximumPotentialParallelism).toBe(0);
    expect(result.unresolved).toEqual(['fake-a', 'fake-b', 'fake-self', 'fake-tail'].map(id => ({ id, missingExternalDependencies: [] })));
  });

  it('honors supplied completed task and external IDs, without emitting them as waves', () => {
    const { result } = run({ tasks: [
      { id: 'fake-a' }, { id: 'fake-b', dependsOn: ['fake-a', 'fake-external'] },
      { id: 'fake-c', dependsOn: ['fake-b'] },
    ], completed: ['fake-a', 'fake-external'] });
    expect(result.waves).toEqual([['fake-b'], ['fake-c']]);
    expect(result.unresolved).toEqual([]);
  });

  it('rejects duplicate IDs even if already completed', () => {
    const { code, result } = run({ tasks: [{ id: 'fake-a' }, { id: 'fake-a' }], completed: ['fake-a'] });
    expect(code).toBe(2);
    expect(result.error).toBe('duplicate-task-id');
  });

  it('validates input and bounds before planning', () => {
    expect(run({ tasks: Array.from({ length: 2001 }, (_, i) => ({ id: `fake-${i}` })), completed: [] }).result.error).toBe('invalid-snapshot');
    expect(run({ tasks: [{ id: 'fake-a', dependsOn: [''] }], completed: [] }).result.error).toBe('invalid-snapshot');
    expect(run({ tasks: [], completed: null }).result.error).toBe('invalid-snapshot');
    expect(run({ tasks: [], completed: [] }).result.waves).toEqual([]);
    const oversized = run({ tasks: [], completed: ['x'.repeat(1024 * 1024)] });
    expect(oversized.result.error).toBe('file-too-large');
  });

  it('uses the stable reader on a real isolated file without changing input or neighboring state', () => {
    const dir = directory();
    const path = join(dir, 'fake-snapshot.json');
    const state = join(dir, 'fake-state.json');
    const original = JSON.stringify({ tasks: [{ id: 'fake-a' }, { id: 'fake-b', dependsOn: ['fake-a'] }], completed: [] });
    writeFileSync(path, original, { mode: 0o600 });
    writeFileSync(state, '{"fakeState":"unchanged"}', { mode: 0o600 });
    let output = '';
    expect(runTaskWavePlan(['--file', path], { write: value => { output += value; } })).toBe(0);
    expect(JSON.parse(output).waves).toEqual([['fake-a'], ['fake-b']]);
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(readFileSync(state, 'utf8')).toBe('{"fakeState":"unchanged"}');
  });

  it('rejects a symbolic link through the real stable reader', () => {
    const dir = directory();
    const path = join(dir, 'fake-snapshot.json');
    writeFileSync(path, '{"tasks":[],"completed":[]}', { mode: 0o600 });
    const link = join(dir, 'fake-link.json');
    symlinkSync(path, link);
    let output = '';
    expect(runTaskWavePlan(['--file', link], { write: value => { output += value; } })).toBe(1);
    expect(JSON.parse(output).error).toBe('file-unavailable');
  });

  it('passes a bounded read request and does not mutate injected input', () => {
    const input = Object.freeze({ tasks: Object.freeze([Object.freeze({ id: 'fake-a' })]), completed: Object.freeze([]) });
    const original = JSON.stringify(input);
    let output = '';
    const code = runTaskWavePlan(['--file', 'fake.json'], {
      read: (path, options) => {
        expect(path.endsWith('/fake.json')).toBe(true);
        expect(options.maxFileBytes).toBe(1024 * 1024);
        expect(options.remainingBytes).toBe(1024 * 1024);
        return { ok: true, text: original, bytesRead: Buffer.byteLength(original), mtimeMs: 0 };
      },
      write: value => { output += value; },
    });
    expect(code).toBe(0);
    expect(JSON.stringify(input)).toBe(original);
    expect(JSON.parse(output).waves).toEqual([['fake-a']]);
  });
});
