/**
 * `phm node enqueue --task-file <path>` (`-` reads stdin): the whole-text
 * spelling of the --task-part/--task-sha256 pair. The file's contents become
 * the embedded task — digest and part split computed for the caller — resolved
 * into the same argv the wire already carries, so the store's own validation
 * is unchanged. The mix with --task-part/--task-sha256, an unreadable source
 * and a text the embedded-task rules refuse are all named usage errors.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodesState, NodesStore } from '../src/core/drive/nodes/index.js';
import { NODE_TASK_LIMIT } from '../src/core/drive/nodes/task.js';
import { emptyState } from '../src/core/drive/nodes/state.js';
import { cmdNodeFleet, type NodeFleetDeps } from '../src/cli/node-fleet.js';

class MemoryStore implements NodesStore {
  state = emptyState();
  transaction<T>(fn: (state: NodesState) => T): T {
    const draft = structuredClone(this.state);
    const result = fn(draft);
    this.state = draft;
    return structuredClone(result);
  }
}

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); vi.restoreAllMocks(); });

function tmpdirPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'node-task-file-'));
  roots.push(dir);
  return dir;
}

function taskFile(text: string, name = 'task.md'): string {
  const path = join(tmpdirPath(), name);
  writeFileSync(path, text);
  return path;
}

function capture() {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => { lines.push(String(line)); });
  return lines;
}

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const deps = (store: MemoryStore, extra: Partial<NodeFleetDeps> = {}): NodeFleetDeps => ({ store, ...extra });

describe('phm node enqueue --task-file', () => {
  it('enqueues a codex-file job whose embedded task is the file text, digest computed', async () => {
    const lines = capture();
    const store = new MemoryStore();
    const text = 'Review this diff: it adds a greeting. Ünïcode ✓\nSecond line.';
    const file = taskFile(text);
    expect(await cmdNodeFleet('enqueue', [
      '--job', 'review-1', '--owner', 'acme', '--pack', 'codex-file',
      '--requires', 'codex,pack:codex-file', '--task-file', file, '--json',
    ], deps(store))).toBe(0);
    const out = JSON.parse(lines.at(-1)!);
    expect(out).toMatchObject({ command: 'enqueue', jobId: 'review-1', enqueued: true });
    const job = store.state.jobs.find(j => j.id === 'review-1');
    expect(job?.task).toEqual({ text, sha256: sha(text) });
    expect(job?.pack).toBe('codex-file');
  });

  it('reads the task from stdin when the path is -', async () => {
    const lines = capture();
    const store = new MemoryStore();
    const text = 'Task from stdin: summarize the changelog.';
    expect(await cmdNodeFleet('enqueue', [
      '--job', 'stdin-1', '--owner', 'acme', '--pack', 'codex-file', '--task-file', '-', '--json',
    ], deps(store, { readTaskStdin: async () => text }))).toBe(0);
    expect(JSON.parse(lines.at(-1)!).enqueued).toBe(true);
    expect(store.state.jobs.find(j => j.id === 'stdin-1')?.task).toEqual({ text, sha256: sha(text) });
  });

  it('accepts the --task-file=<path> spelling', async () => {
    capture();
    const store = new MemoryStore();
    const text = 'Inline equals form.';
    const file = taskFile(text);
    expect(await cmdNodeFleet('enqueue', [
      '--job', 'eq-1', '--owner', 'acme', '--pack', 'codex-file', `--task-file=${file}`, '--json',
    ], deps(store))).toBe(0);
    expect(store.state.jobs.find(j => j.id === 'eq-1')?.task?.text).toBe(text);
  });

  it('splits a long file into --task-part args that reassemble to the same text', async () => {
    capture();
    const store = new MemoryStore();
    // Varied prose, not a repeated character run — a long unbroken string is
    // secret-shaped and the store refuses it on its own rules.
    const text = Array.from({ length: 220 }, (_, i) => `Step ${i}: check the diff hunk ${i} for off-by-one errors.`).join('\n');
    const file = taskFile(text);
    expect(await cmdNodeFleet('enqueue', [
      '--job', 'long-1', '--owner', 'acme', '--pack', 'codex-file', '--task-file', file, '--json',
    ], deps(store))).toBe(0);
    const job = store.state.jobs.find(j => j.id === 'long-1');
    expect(job?.task?.text).toBe(text);
    expect(job?.task?.sha256).toBe(sha(text));
  });

  it('refuses --task-file mixed with --task-part or --task-sha256', async () => {
    const lines = capture();
    const store = new MemoryStore();
    const file = taskFile('one text');
    for (const extra of [['--task-part', 'other'], ['--task-sha256', 'sha256:' + '0'.repeat(64)], ['--task-part=other']]) {
      expect(await cmdNodeFleet('enqueue', [
        '--job', 'mix-1', '--owner', 'acme', '--pack', 'codex-file', '--task-file', file, ...extra, '--json',
      ], deps(store))).toBe(2);
      const out = JSON.parse(lines.at(-1)!);
      expect(out.error.code).toBe('conflicting-task');
      expect(out.error.message).toContain('cannot be combined');
    }
    expect(store.state.jobs).toEqual([]);
  });

  it('refuses a second --task-file and a --task-file with no value', async () => {
    const lines = capture();
    const store = new MemoryStore();
    const file = taskFile('text');
    expect(await cmdNodeFleet('enqueue', [
      '--job', 'dup-1', '--owner', 'acme', '--pack', 'codex-file', '--task-file', file, '--task-file', file, '--json',
    ], deps(store))).toBe(2);
    expect(JSON.parse(lines.at(-1)!).error.code).toBe('duplicate-flag');
    expect(await cmdNodeFleet('enqueue', [
      '--job', 'noval-1', '--owner', 'acme', '--pack', 'codex-file', '--task-file', '--json',
    ], deps(store))).toBe(2);
    expect(JSON.parse(lines.at(-1)!).error.code).toBe('missing-value');
    expect(store.state.jobs).toEqual([]);
  });

  it('names an unreadable task file instead of enqueuing nothing silently', async () => {
    const lines = capture();
    const store = new MemoryStore();
    expect(await cmdNodeFleet('enqueue', [
      '--job', 'nofile-1', '--owner', 'acme', '--pack', 'codex-file',
      '--task-file', join(tmpdirPath(), 'missing.md'), '--json',
    ], deps(store))).toBe(2);
    const out = JSON.parse(lines.at(-1)!);
    expect(out.error.code).toBe('bad-task-file');
    expect(out.error.message).toContain('Cannot read the task file');
    expect(store.state.jobs).toEqual([]);
  });

  it('refuses task text the embedded-task rules reject: empty, oversized, secret-shaped', async () => {
    const lines = capture();
    const store = new MemoryStore();
    const cases: Array<[string, string]> = [
      ['empty.md', '   \n  '],
      ['big.md', 'x'.repeat(NODE_TASK_LIMIT + 1)],
      ['secret.md', 'token AKIAIOSFODNN7EXAMPLE inside'],
    ];
    for (const [name, text] of cases) {
      const file = taskFile(text, name);
      expect(await cmdNodeFleet('enqueue', [
        '--job', `bad-${name}`, '--owner', 'acme', '--pack', 'codex-file', '--task-file', file, '--json',
      ], deps(store))).toBe(2);
      const out = JSON.parse(lines.at(-1)!);
      expect(out.error.code).toBe('bad-task');
      expect(out.error.message).toContain('Invalid embedded node task');
    }
    expect(store.state.jobs).toEqual([]);
  });

  it('still requires --pack codex-file for an embedded task', async () => {
    const lines = capture();
    const store = new MemoryStore();
    const file = taskFile('a task');
    expect(await cmdNodeFleet('enqueue', [
      '--job', 'nopack-1', '--owner', 'acme', '--task-file', file, '--json',
    ], deps(store))).toBe(2);
    const out = JSON.parse(lines.at(-1)!);
    expect(out.error.code).toBe('bad-pack');
    expect(out.error.message).toContain('requires --pack codex-file');
    expect(store.state.jobs).toEqual([]);
  });

  it('keeps --task-file off verbs that do not embed tasks', async () => {
    const lines = capture();
    const store = new MemoryStore();
    const file = taskFile('a task');
    expect(await cmdNodeFleet('plan', ['--task-file', file, '--json'], deps(store))).toBe(2);
    expect(JSON.parse(lines.at(-1)!).error.code).toBe('unknown-flag');
    expect(store.state.jobs).toEqual([]);
  });

  it('prints the plain enqueue answer in text mode', async () => {
    const lines = capture();
    const store = new MemoryStore();
    const file = taskFile('plain text task');
    expect(await cmdNodeFleet('enqueue', [
      '--job', 'text-1', '--owner', 'acme', '--pack', 'codex-file', '--task-file', file,
    ], deps(store))).toBe(0);
    expect(lines.at(-1)).toBe('Enqueued text-1.');
  });
});
