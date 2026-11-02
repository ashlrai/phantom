import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetBusReply } from '../src/cli/fleet-bus-reply.js';
import { cmdFleetBusRequest } from '../src/cli/fleet-bus-request.js';
import { ashlrHome } from '../src/core/cloud/store.js';
import { appendBusInbox, listBusInboxAfter, type BusInboxOptions, type BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
const request = { id: 'req-root-01', from: 'fake-a', to: 'fake-b', priority: 'P2', ttl: 60000, body: { text: 'fake-request-body' } };
function base(): string { const dir = mkdtempSync(join(tmpdir(), 'fleet-bus-root-')); roots.push(dir); return dir; }
function requestFile(dir: string): string {
  const file = join(dir, 'request.json');
  writeFileSync(file, JSON.stringify(request), { mode: 0o600 });
  return file;
}
function bodyFile(dir: string, body: unknown = { answer: 'fake-answer' }): string {
  const file = join(dir, 'reply-body.json');
  writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
  return file;
}
function messages(root: string, options: BusInboxOptions = {}): BusInboxReceipt[] {
  const page = listBusInboxAfter(0, 100, { root, ...options });
  expect(page.status).toBe('ok');
  return page.status === 'ok' ? page.messages : [];
}
async function waitForRow(root: string, id: string, options: BusInboxOptions = {}): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!messages(root, options).some(row => row.envelope.id === id) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(messages(root, options).some(row => row.envelope.id === id)).toBe(true);
}
async function runRequest(argv: string[], options: BusInboxOptions = {}, deps: Parameters<typeof cmdFleetBusRequest>[2] = {}) {
  const output: string[] = [];
  const code = await cmdFleetBusRequest(argv, options, { ...deps, output: text => output.push(text) });
  return { code, printed: output.join(''), result: JSON.parse(output.join('')) as Record<string, any> };
}
function runReply(argv: string[], options: BusInboxOptions = {}, deps: Parameters<typeof cmdFleetBusReply>[2] = {}) {
  const output: string[] = [];
  const code = cmdFleetBusReply(argv, options, { ...deps, output: text => output.push(text) });
  return { code, printed: output.join(''), result: JSON.parse(output.join('')) as Record<string, any> };
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('completes a request/reply roundtrip on an explicit --root and leaves other stores untouched', async () => {
  const dir = base(), rootA = join(dir, 'a'), rootB = join(dir, 'b');
  const file = requestFile(dir), body = bodyFile(dir, { answer: 'fake-answer', token: 'fake-token-value' });
  const pending = runRequest(['--file', file, '--timeout-ms', '15000', '--interval-ms', '100', '--root', rootA]);
  await waitForRow(rootA, request.id);
  expect(runReply(['--request-id', request.id, '--reply-id', 'reply-a', '--body-file', body, '--root', rootA]))
    .toMatchObject({ code: 0, result: { outcome: 'posted' } });
  const done = await pending;
  expect(done).toMatchObject({ code: 0, result: { schema: 'fleet.bus-request.v1', outcome: 'replied', receipt: { status: 'posted', id: request.id, cursor: 1 } } });
  expect(done.result.reply.envelope).toMatchObject({ id: 'reply-a', from: 'fake-b', to: 'fake-a', body: { inReplyTo: request.id } });
  expect(done.result.reply.envelope.ttl).toBeGreaterThan(0);
  expect(done.result.reply.envelope.ttl).toBeLessThanOrEqual(request.ttl);
  expect(done.printed).not.toContain('fake-token-value');
  expect(messages(rootA).map(row => row.envelope.id)).toEqual([request.id, 'reply-a']);
  expect(existsSync(rootB)).toBe(false);
  expect(existsSync(join(ashlrHome(), 'fleet'))).toBe(false);
}, 30000);

it('cannot be satisfied by matching-looking traffic on a different root', async () => {
  const dir = base(), rootA = join(dir, 'a'), rootB = join(dir, 'b');
  const file = requestFile(dir), body = bodyFile(dir);
  // Root B carries the same request id and a correctly correlated reply.
  expect(appendBusInbox(request, { root: rootB }).status).toBe('posted');
  expect(runReply(['--request-id', request.id, '--reply-id', 'reply-on-b', '--body-file', body, '--root', rootB]))
    .toMatchObject({ code: 0, result: { outcome: 'posted' } });
  const pending = runRequest(['--file', file, '--timeout-ms', '15000', '--interval-ms', '100', '--root', rootA]);
  await waitForRow(rootA, request.id);
  // Bounded pause long enough for several polls: B's reply stays invisible to A.
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(runReply(['--request-id', request.id, '--reply-id', 'reply-on-a', '--body-file', body, '--root', rootA]))
    .toMatchObject({ code: 0, result: { outcome: 'posted' } });
  const done = await pending;
  expect(done).toMatchObject({ code: 0, result: { outcome: 'replied', reply: { envelope: { id: 'reply-on-a' } } } });
  // A short wait on A times out while B still holds the matching reply.
  const timed = await runRequest(['--file', file, '--timeout-ms', '700', '--interval-ms', '100', '--root', join(dir, 'c')]);
  expect(timed).toMatchObject({ code: 1, result: { outcome: 'timeout', reply: null, receipt: { status: 'posted' } } });
  expect(messages(rootB).map(row => row.envelope.id)).toEqual([request.id, 'reply-on-b']);
  expect(existsSync(join(ashlrHome(), 'fleet'))).toBe(false);
}, 30000);

it('accepts --flag=value syntax on both verbs', async () => {
  const dir = base(), rootA = join(dir, 'a');
  const file = requestFile(dir), body = bodyFile(dir);
  const pending = runRequest([`--file=${file}`, '--timeout-ms=15000', '--interval-ms=100', `--root=${rootA}`]);
  await waitForRow(rootA, request.id);
  expect(runReply([`--request-id=${request.id}`, '--reply-id=reply-eq', `--body-file=${body}`, `--root=${rootA}`]))
    .toMatchObject({ code: 0, result: { outcome: 'posted' } });
  expect(await pending).toMatchObject({ code: 0, result: { outcome: 'replied', reply: { envelope: { id: 'reply-eq' } } } });
}, 30000);

it('keeps the injected root when --root is omitted and lets the CLI root override it with the injected clock', async () => {
  const dir = base(), injected = join(dir, 'injected'), cli = join(dir, 'cli');
  const file = requestFile(dir), body = bodyFile(dir);
  // Omission: the programmatic BusInboxOptions.root still selects the store.
  const omitted = await runRequest(['--file', file, '--timeout-ms', '700', '--interval-ms', '100'], { root: injected });
  expect(omitted).toMatchObject({ code: 1, result: { outcome: 'timeout', receipt: { status: 'posted', cursor: 1 } } });
  expect(messages(injected).map(row => row.envelope.id)).toEqual([request.id]);
  expect(existsSync(cli)).toBe(false);
  // Override: --root wins for post and wait while the injected clock still applies.
  const pending = runRequest(['--file', file, '--timeout-ms', '15000', '--interval-ms', '100', '--root', cli], { root: injected, now: () => 5000 });
  await waitForRow(cli, request.id, { now: () => 5000 });
  expect(messages(cli, { now: () => 5000 })[0]).toMatchObject({ cursor: 1, receivedAt: 5000 });
  expect(messages(injected)).toHaveLength(1);
  expect(runReply(['--request-id', request.id, '--reply-id', 'reply-override', '--body-file', body, '--root', cli], { root: injected, now: () => 5100 }))
    .toMatchObject({ code: 0, result: { outcome: 'posted' } });
  const done = await pending;
  expect(done).toMatchObject({ code: 0, result: { outcome: 'replied', reply: { envelope: { id: 'reply-override', ttl: request.ttl - 100 } } } });
  expect(messages(injected)).toHaveLength(1);
}, 30000);

const invalidRootArgs: [string, string[]][] = [
  ['relative', ['--root', 'relative/path']],
  ['dot-relative', ['--root', './store']],
  ['empty-separated', ['--root', '']],
  ['empty-equals', ['--root=']],
  ['dangling', ['--root']],
  ['flag-as-value', ['--root', '--file']],
];
it.each(invalidRootArgs)('rejects a %s root on both verbs before any file or store access', async (_name, rootArgs) => {
  const dir = base(), rootA = join(dir, 'a');
  const file = requestFile(dir), body = bodyFile(dir);
  const list = vi.fn(listBusInboxAfter), append = vi.fn(appendBusInbox);
  const req = await runRequest(['--file', file, '--timeout-ms', '1000', ...rootArgs], {}, { list, append });
  expect(req).toMatchObject({ code: 2, result: { outcome: 'invalid-input', receipt: { status: 'not-attempted' }, reply: null } });
  const rep = runReply(['--request-id', request.id, '--reply-id', 'reply-x', '--body-file', body, ...rootArgs], {}, { list, append });
  expect(rep).toMatchObject({ code: 2, result: { outcome: 'invalid-input' } });
  expect(list).not.toHaveBeenCalled(); expect(append).not.toHaveBeenCalled();
  expect(existsSync(rootA)).toBe(false);
  expect(existsSync(join(ashlrHome(), 'fleet'))).toBe(false);
});

it('rejects duplicate and NUL roots on both verbs before any file or store access', async () => {
  const dir = base(), rootA = join(dir, 'a'), rootB = join(dir, 'b');
  const file = requestFile(dir), body = bodyFile(dir);
  const list = vi.fn(listBusInboxAfter), append = vi.fn(appendBusInbox);
  const badRoots = [['--root', rootA, '--root', rootB], [`--root=${rootA}`, `--root=${rootB}`],
    ['--root', `${rootA}\0suffix`], [`--root=${rootA}\0`]];
  for (const rootArgs of badRoots) {
    const req = await runRequest(['--file', file, '--timeout-ms', '1000', ...rootArgs], {}, { list, append });
    expect(req).toMatchObject({ code: 2, result: { outcome: 'invalid-input', receipt: { status: 'not-attempted' } } });
    const rep = runReply(['--request-id', request.id, '--reply-id', 'reply-x', '--body-file', body, ...rootArgs], {}, { list, append });
    expect(rep).toMatchObject({ code: 2, result: { outcome: 'invalid-input' } });
  }
  expect(list).not.toHaveBeenCalled(); expect(append).not.toHaveBeenCalled();
  expect(existsSync(rootA)).toBe(false); expect(existsSync(rootB)).toBe(false);
  expect(existsSync(join(ashlrHome(), 'fleet'))).toBe(false);
});

it('documents --root and the authentication caveat in both help texts', async () => {
  let text = '';
  expect(await cmdFleetBusRequest(['--help'], {}, { output: value => { text = value; } })).toBe(0);
  expect(text).toContain('--root'); expect(text).toContain('do not authenticate');
  text = '';
  expect(cmdFleetBusReply(['--help'], {}, { output: value => { text = value; } })).toBe(0);
  expect(text).toContain('--root'); expect(text).toContain('do not authenticate');
});
