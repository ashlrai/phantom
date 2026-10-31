import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runBusTaskRoundtrip } from '../examples/agents/bus-task-roundtrip.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';

const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bus-roundtrip-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const args = ['--from', 'fake-a', '--to', 'fake-b', '--id', 'fake-task', '--text', 'hello'];
function run(mode: string, root: string, input = args, now = 100) {
  const lines: string[] = [];
  const code = runBusTaskRoundtrip([mode, ...input], { options: { root, now: () => now }, write: line => lines.push(line) });
  expect(lines).toHaveLength(1);
  return { code, result: JSON.parse(lines[0]) };
}

it('runs directly as a deterministic dry-run without creating an inbox', () => {
  const home = temp();
  const cli = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
  const command = [cli, 'examples/agents/bus-task-roundtrip.ts', '--dry-run', ...args];
  const env = { ...process.env, HOME: home, ASHLR_HOME: join(home, 'ashlr') };
  const output = execFileSync(process.execPath, command, { encoding: 'utf8', env });
  expect(JSON.parse(output)).toEqual({ id: 'fake-task', from: 'fake-a', to: 'fake-b', priority: 'P2', ttl: 60_000, body: { text: 'hello' } });
  expect(execFileSync(process.execPath, command, { encoding: 'utf8', env })).toBe(output);
  expect(readdirSync(home)).toEqual([]);
});

it('posts and reads only its own receipt at the cursor boundary, then handles a duplicate', () => {
  const root = temp();
  expect(appendBusInbox({ id: 'earlier', from: 'fake-x', to: 'fake-y', priority: 'P2', ttl: 60000, body: 'unrelated' }, { root, now: () => 100 }).status).toBe('posted');
  const posted = run('--post', root);
  expect(posted.code).toBe(0);
  expect(posted.result).toMatchObject({ status: 'posted', nextCursor: 2, receipt: { cursor: 2, receivedAt: 100, envelope: { id: 'fake-task', body: { text: 'hello' } } } });
  expect(JSON.stringify(posted.result)).not.toContain('unrelated');
  const duplicate = run('--post', root, args, 150);
  expect(duplicate.code).toBe(0);
  expect(duplicate.result).toMatchObject({ status: 'duplicate', receipt: { cursor: 2, envelope: { ttl: 59950 } } });
  const expired = run('--post', root, args, 60100);
  expect(expired).toMatchObject({ code: 4, result: { status: 'read-failed', post: { status: 'duplicate', cursor: 2 }, reason: 'receipt-unavailable' } });
});

it('refuses invalid input without writing, and reports a conflicting ID', () => {
  const root = temp();
  expect(run('--dry-run', root, ['--from', 'bad address', ...args.slice(2)]).result.status).toBe('invalid-envelope');
  expect(run('--post', root, args.slice(0, -2))).toMatchObject({ code: 2, result: { status: 'invalid-arguments' } });
  expect(run('--post', root, [...args, '--root', 'relative'])).toMatchObject({ code: 2, result: { status: 'invalid-arguments' } });
  expect(readdirSync(root)).toEqual([]);
  expect(run('--post', root).code).toBe(0);
  expect(run('--post', root, [...args.slice(0, -1), 'different'])).toEqual({ code: 3, result: { status: 'conflict' } });
});

it('reports a full store without claiming the new task was posted', () => {
  const root = temp();
  for (let i = 0; i < 17; i++) {
    expect(appendBusInbox({ id: `fill-${i}`, from: 'fake-a', to: 'fake-b', priority: 'P2', ttl: 60000, body: 'x'.repeat(60000) }, { root, now: () => 100 }).status).toBe('posted');
  }
  expect(run('--post', root, [...args.slice(0, -1), 'x'.repeat(60000)])).toEqual({ code: 3, result: { status: 'full' } });
});
