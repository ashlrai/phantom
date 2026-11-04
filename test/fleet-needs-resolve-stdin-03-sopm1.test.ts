import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetNeedsResolve } from '../src/cli/fleet-needs-resolve.js';
import { listNeedsMason, NEEDS_MASON_REPLY_MAX } from '../src/core/fleet/needs-mason-resolve.js';
import { readNeedsMasonAnswer } from '../src/core/fleet/needs-mason-answer.js';

const id = 'nm-0123456789ab';
const resolve = vi.fn(async () => ({ ok: true as const, itemId: id, cursor: 1, duplicate: false, inbox: 'appended' as const }));
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'needs-stdin-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_HOME', join(root, 'ashlr'));
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, 'runs'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  resolve.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it.each(['\n', '\r\n', ''])('preserves multiline Unicode and removes one final %j', async ending => {
  const reply = '你好 🌍\ncontinue\n';
  const bytes = Buffer.from(reply + ending);
  const stdin = Readable.from([...bytes].map(byte => Buffer.from([byte])));
  expect(await cmdFleetNeedsResolve([id, '--reply-stdin'], { stdin, resolve })).toBe(0);
  expect(resolve).toHaveBeenCalledWith({ itemId: id, reply: ending ? reply : reply.slice(0, -1) }, { runsDir: undefined, source: 'cli' });
});

it('accepts the UTF-8 limit with CRLF headroom', async () => {
  const reply = '界'.repeat(NEEDS_MASON_REPLY_MAX);
  expect(await cmdFleetNeedsResolve([id, '--reply-stdin'], { stdin: Readable.from([Buffer.from(reply + '\r\n')]), resolve })).toBe(0);
  expect(resolve).toHaveBeenCalledWith({ itemId: id, reply }, { runsDir: undefined, source: 'cli' });
});

it.each(['', '\n', ' \r\n', 'a'.repeat(501), '界'.repeat(501)])('rejects empty or oversized input without resolving', async reply => {
  expect(await cmdFleetNeedsResolve([id, '--reply-stdin'], { stdin: Readable.from([reply]), resolve })).toBe(1);
  expect(resolve).not.toHaveBeenCalled();
});

it('stops on streaming overflow without destroying the input', async () => {
  const stdin = new Readable({ read() { this.push(Buffer.alloc(1600)); } });
  const destroy = vi.spyOn(stdin, 'destroy');
  expect(await cmdFleetNeedsResolve([id, '--reply-stdin'], { stdin, resolve })).toBe(1);
  expect(destroy).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
  stdin.destroy();
});

it.each([
  [id, '--reply-stdin', '--reply', 'answer'], [id, '--reply', 'answer', '--reply-stdin'],
  [id, '--reply-stdin', '--reply-stdin'], ['--reply-stdin'], [id, '--reply-stdin', '--unknown'],
  [id, '--reply-stdin', '--runs-dir'],
])('validates all arguments before reading: %j', async (...args) => {
  const stdin = new Readable({ read() { throw new Error('must not read'); } });
  const iterator = vi.spyOn(stdin, 'iterator');
  expect(await cmdFleetNeedsResolve(args, { stdin, resolve })).toBe(2);
  expect(iterator).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
});

it('does not read stdin by default or for argv replies', async () => {
  const stdin = new Readable({ read() { throw new Error('must not read'); } });
  const iterator = vi.spyOn(stdin, 'iterator');
  expect(await cmdFleetNeedsResolve([id], { stdin, resolve })).toBe(0);
  expect(await cmdFleetNeedsResolve([id, '--reply', 'yes'], { stdin, resolve })).toBe(0);
  expect(iterator).not.toHaveBeenCalled();
});

it('reports stream errors without echoing the answer', async () => {
  const stdin = Readable.from((async function* () { yield 'private answer'; throw new Error('private answer'); })());
  expect(await cmdFleetNeedsResolve([id, '--reply-stdin', '--json'], { stdin, resolve })).toBe(1);
  expect(resolve).not.toHaveBeenCalled();
  expect(vi.mocked(process.stderr.write).mock.calls.flat().join('')).not.toContain('private answer');
  expect(console.log).not.toHaveBeenCalled();
});

it('documents trailing newline handling', async () => {
  expect(await cmdFleetNeedsResolve(['--help'])).toBe(0);
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('removes one final LF or CRLF'));
});

it('round trips through the real relay, retaining cli attribution and only one planner entry', async () => {
  const runsDir = join(root, 'runs');
  mkdirSync(runsDir);
  writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- [ ] Choose the next step\n');
  const itemId = listNeedsMason({ runsDir })[0]!.id;
  const args = [itemId, '--reply-stdin', '--runs-dir', runsDir];
  const reply = '你好 🌍\nProceed carefully';
  expect(await cmdFleetNeedsResolve(args, { stdin: Readable.from([reply + '\n']) })).toBe(0);
  expect(readNeedsMasonAnswer(itemId)).toMatchObject({ status: 'found', answer: { source: 'cli', reply: '你好 🌍 Proceed carefully' } });
  const inboxPath = join(runsDir, 'leader', 'MASON-INBOX.md');
  const inbox = readFileSync(inboxPath, 'utf8');
  expect(inbox).toContain(reply);
  expect(await cmdFleetNeedsResolve(args, { stdin: Readable.from([reply]) })).toBe(1);
  expect(readFileSync(inboxPath, 'utf8')).toBe(inbox);
  expect(inbox.match(/Re needs-you/g)).toHaveLength(1);
});
