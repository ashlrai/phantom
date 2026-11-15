import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordFleetAction } from '../src/core/fleet/action-intent.js';
import { cmdFleetAct } from '../src/cli/fleet-act.js';

let home: string;
let queue: string;
const output = vi.fn();
beforeEach(() => {
  home = mkdtempSync(join(realpathSync(tmpdir()), 'fleet-act-'));
  vi.stubEnv('HOME', home);
  queue = join(home, '.ashlr', 'router-queue');
  mkdirSync(queue, { recursive: true, mode: 0o700 });
  output.mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

it('appends one independent audited intent for each allowed verb without applying it', async () => {
  const target = join(home, '.ashlr', 'vision', 'leader', 'memo.md');
  for (const verb of ['pause', 'resume', 'kill', 'reassign', 'set-slot', 'vision-edit']) {
    expect(await cmdFleetAct([verb, '--dry-run', '--path', target, '--json'], output)).toBe(0);
  }
  const lines = readFileSync(join(queue, 'actions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(lines).toHaveLength(6);
  expect(new Set(lines.map((line) => line.id)).size).toBe(6);
  for (const line of lines) {
    expect(line).toMatchObject({ v: 1, target, dryRun: true, status: 'intent' });
    expect(Number.isFinite(Date.parse(line.at))).toBe(true);
  }
  expect(lines.map((line) => line.verb)).toEqual(['pause', 'resume', 'kill', 'reassign', 'set-slot', 'vision-edit']);
  expect(existsSync(target)).toBe(false);
  expect(existsSync(join(home, '.ashlr', 'KILL'))).toBe(false);
});
it('rejects unknown verbs, live actions, duplicate options and trailing arguments before auditing', async () => {
  for (const args of [['exec', '--dry-run'], ['__proto__', '--dry-run'], ['pause'], ['pause', '--dry-run', '--dry-run'], ['kill', '--dry-run', 'extra'], ['pause', '--dry-run', '--path']]) {
    expect(await cmdFleetAct(args, output)).toBe(2);
  }
  expect(() => recordFleetAction('exec', true)).toThrow();
  expect(existsSync(join(queue, 'actions.jsonl'))).toBe(false);
});
it('rejects lexical escapes, prefix siblings and symlink components without audit writes', () => {
  symlinkSync(home, join(queue, 'escape'), 'dir');
  for (const target of [home, join(queue, '..', 'other'), `${queue}-other/file`, join(queue, 'escape', 'new')]) {
    expect(() => recordFleetAction('pause', true, target)).toThrow();
  }
  expect(existsSync(join(queue, 'actions.jsonl'))).toBe(false);
});
it('refuses symlink and hardlink audit sinks without modifying their contents', () => {
  const sink = join(home, 'sink');
  const audit = join(queue, 'actions.jsonl');
  writeFileSync(sink, 'untouched', { mode: 0o600 });
  symlinkSync(sink, audit);
  expect(() => recordFleetAction('pause', true)).toThrow();
  rmSync(audit);
  linkSync(sink, audit);
  expect(() => recordFleetAction('pause', true)).toThrow();
  expect(readFileSync(sink, 'utf8')).toBe('untouched');
});
it('help writes nothing and the default target is the queue', async () => {
  expect(await cmdFleetAct(['pause', '--help'], output)).toBe(0);
  expect(existsSync(join(queue, 'actions.jsonl'))).toBe(false);
  expect(recordFleetAction('set-slot', true).target).toBe(queue);
});
