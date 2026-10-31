import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runBusResume } from '../examples/agents/bus-resume.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'bus-resume-'));
  roots.push(home);
  return { home, root: join(home, 'fleet') };
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function post(root: string, id: string, to: string, ttl: number, now: number) {
  expect(appendBusInbox({ id, from: 'fake-a', to, priority: 'P2', ttl, body: { text: 'untrusted data' } },
    { root, now: () => now }).status).toBe('posted');
}
function run(args: string[], root: string, now = 100) {
  let stdout = '', stderr = '';
  const code = runBusResume(args, { options: { root, now: () => now },
    stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr };
}

it('resumes across nonmatching and expired records without persisting or executing bodies', () => {
  const { root } = setup();
  post(root, 'expired', 'fake-b', 10, 0);
  post(root, 'other', 'fake-c', 1000, 0);
  post(root, 'first', 'fake-b', 1000, 0);
  post(root, 'other-again', 'fake-c', 1000, 0);
  post(root, 'second', 'fake-b', 1000, 0);
  const file = join(root, 'bus-inbox', 'messages.json');
  const before = readFileSync(file, 'utf8');
  const first = run(['--to', 'fake-b', '--after', '0', '--limit', '2'], root);
  expect(first).toMatchObject({ code: 0, stderr: '' });
  const page = JSON.parse(first.stdout);
  expect(page).toMatchObject({ nextCursor: 3, messages: [{ cursor: 3, envelope: {
    id: 'first', ttl: 900, body: { text: 'untrusted data' },
  } }] });
  const second = run(['--to', 'fake-b', '--after', String(page.nextCursor), '--limit', '1'], root);
  expect(JSON.parse(second.stdout)).toEqual({ messages: [], nextCursor: 4 });
  const third = run(['--to', 'fake-b', '--after', '4', '--limit', '1'], root);
  expect(JSON.parse(third.stdout)).toMatchObject({ nextCursor: 5, messages: [{ cursor: 5, envelope: { id: 'second' } }] });
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(run(['--to', 'fake-b', '--after', '5'], root)).toMatchObject({ code: 0, stdout: '{"messages":[],"nextCursor":5}\n' });
  expect(run(['--to', 'fake-b'], root, 1000)).toMatchObject({ code: 0, stdout: '{"messages":[],"nextCursor":5}\n' });
});

it('rejects malformed arguments and out-of-range cursors without writing a result', () => {
  const { root } = setup();
  for (const args of [[], ['--to'], ['--to', ''], ['--to', 'bad address'], ['--to', 'a\n'],
    ['--to', 'x'.repeat(129)], ['--to', 'a', '--after', '-1'], ['--to', 'a', '--after', '1e2'],
    ['--to', 'a', '--after', '9007199254740992'], ['--to', 'a', '--limit', '0'],
    ['--to', 'a', '--limit', '101'], ['--to', 'a', '--limit', '1.5'],
    ['--to', 'a', '--to', 'b'], ['--unknown', 'x'], ['--to', 'a', '--after', '1']]) {
    const result = run(args, root);
    expect(result.code, JSON.stringify(args)).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toBe('');
  }
});

it('reports an unavailable or corrupt store without exposing its contents', () => {
  const { root } = setup();
  post(root, 'fake', 'fake-b', 1000, 0);
  writeFileSync(join(root, 'bus-inbox', 'messages.json'), 'fake-private-corrupt-data');
  const result = run(['--to', 'fake-b'], root);
  expect(result).toEqual({ code: 1, stdout: '', stderr: 'Inbox unavailable.\n' });
  const thrown = runBusResume(['--to', 'fake-b'], {
    read: () => { throw new Error('fake-private-detail'); }, stdout: () => { throw new Error('unexpected output'); },
    stderr: text => { expect(text).toBe('Inbox unavailable.\n'); },
  });
  expect(thrown).toBe(1);
});

it('runs as an executable against the default fleet inbox and accepts the returned cursor', () => {
  const { home, root } = setup();
  post(root, 'fake-cli', 'fake-b', 300_000, Date.now());
  const execute = (after: string) => spawnSync(process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'examples/agents/bus-resume.ts', '--to', 'fake-b', '--after', after],
    { encoding: 'utf8', env: { HOME: home, ASHLR_HOME: home, PATH: process.env['PATH'] ?? '' } });
  const first = execute('0');
  expect(first.status).toBe(0);
  expect(first.stderr).toBe('');
  const page = JSON.parse(first.stdout);
  expect(page).toMatchObject({ nextCursor: 1, messages: [{ envelope: { id: 'fake-cli' } }] });
  const second = execute(String(page.nextCursor));
  expect(second.status).toBe(0);
  expect(JSON.parse(second.stdout)).toEqual({ messages: [], nextCursor: 1 });
}, 60_000);
