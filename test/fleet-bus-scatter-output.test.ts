import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetBusScatter } from '../src/cli/fleet-bus-scatter.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { requestBusRoundtrip } from '../src/core/fleet/bus-request-roundtrip.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
const roots: string[] = [];
const envelope = (id: string) => ({ id, from: 'planner', to: `agent-${id}`, priority: 'P2' as const, ttl: 60000, body: { text: 'task' } });
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scatter-output-'))); roots.push(root);
  const file = join(root, 'input.json'), dest = join(root, 'result.json'), options = { root: join(root, 'bus') };
  writeFileSync(file, JSON.stringify({ version: 1, requests: [envelope('a'), envelope('b')] }), { mode: 0o600 });
  const output = vi.fn();
  const run = (extra: string[] = [], deps: Parameters<typeof cmdFleetBusScatter>[2] = {}) =>
    cmdFleetBusScatter(['--file', file, '--output', dest, '--json', ...extra], options, { ...deps, output });
  const saved = () => JSON.parse(readFileSync(dest, 'utf8'));
  return { root, file, dest, options, output, run, saved };
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('saves an all-replied report from the real bus', async () => {
  const h = setup();
  const answered = new Set<string>();
  const timer = setInterval(() => {
    const page = listBusInboxAfter(0, 100, h.options);
    if (page.status !== 'ok') return;
    for (const id of ['a', 'b']) {
      if (!answered.has(id) && page.messages.some(row => row.envelope.id === id)) {
        const posted = appendBusInbox({ ...envelope(`reply-${id}`), from: `agent-${id}`, to: 'planner',
          body: { inReplyTo: id, note: 'done' } }, h.options);
        if (posted.status === 'posted') answered.add(id);
      }
    }
  }, 20);
  try { expect(await h.run(['--apply', '--timeout-ms', '20000'])).toBe(0); }
  finally { clearInterval(timer); }
  expect(h.saved()).toEqual(JSON.parse(String(h.output.mock.lastCall![0])));
  expect(h.saved()).toMatchObject({ status: 'all-replied', counts: { replied: 2 } });
});

it('writes the same sanitized JSON and real partial replies to a private file', async () => {
  const h = setup();
  const timer = setInterval(() => {
    const page = listBusInboxAfter(0, 100, h.options);
    if (page.status === 'ok' && page.messages.some(row => row.envelope.id === 'a')) {
      clearInterval(timer);
      expect(appendBusInbox({ ...envelope('reply-a'), from: 'agent-a', to: 'planner',
        body: { inReplyTo: 'a', token: 'fake-value', note: 'done' } }, h.options).status).toBe('posted');
    }
  }, 20);
  try {
    expect(await h.run(['--apply', '--timeout-ms', '12000'])).toBe(1);
  } finally { clearInterval(timer); }
  const report = h.saved();
  expect(report).toEqual(JSON.parse(String(h.output.mock.lastCall![0])));
  expect(report).toMatchObject({ schema: 'fleet.bus-scatter.v1', status: 'partial', counts: { replied: 1, failed: 1 } });
  expect(report.requests[0].result.reply.envelope.body).toMatchObject({ inReplyTo: 'a', token: '[REDACTED]', note: 'done' });
  expect(readFileSync(h.dest, 'utf8')).not.toContain('fake-value');
  if (process.platform !== 'win32') expect(statSync(h.dest).mode & 0o777).toBe(0o600);
});

it('writes a preview without posting and saves before a disconnected output throws', async () => {
  const h = setup();
  expect(await h.run()).toBe(0);
  expect(h.saved()).toEqual(JSON.parse(String(h.output.mock.lastCall![0])));
  expect(h.saved().status).toBe('preview');
  expect(existsSync(h.options.root)).toBe(false);
  const other = join(h.root, 'detached.json');
  expect(await cmdFleetBusScatter(['--file', h.file, '--output', other], h.options,
    { output: () => { throw new Error('closed terminal'); } })).toBe(1);
  expect(JSON.parse(readFileSync(other, 'utf8')).status).toBe('preview');
});

it('rejects existing, aliased, symlinked and unsafe destinations before posting', async () => {
  const h = setup(), existing = join(h.root, 'existing'), alias = join(h.root, 'alias'), symlink = join(h.root, 'link');
  writeFileSync(existing, 'evidence'); linkSync(h.file, alias); symlinkSync(existing, symlink);
  const unsafe = join(h.root, 'unsafe'); mkdirSync(unsafe, { mode: 0o700 }); chmodSync(unsafe, 0o777);
  const parentLink = join(h.root, 'parent-link'); symlinkSync(h.root, parentLink);
  for (const destination of [h.file, join(h.root, '.', 'input.json'), alias, existing, symlink, h.root,
    join(unsafe, 'report'), join(parentLink, 'new'), `${parentLink}/../new`, 'relative']) {
    const append = vi.fn(appendBusInbox);
    expect(await cmdFleetBusScatter(['--file', h.file, '--output', destination, '--apply', '--json'], h.options,
      { output: h.output, append })).toBe(2);
    expect(append).not.toHaveBeenCalled();
    expect(existsSync(h.options.root)).toBe(false);
  }
  expect(readFileSync(existing, 'utf8')).toBe('evidence');
});

it('refuses a replaced reservation and never deletes or overwrites the replacement', async () => {
  const h = setup();
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const request: typeof requestBusRoundtrip = async () => {
    if (existsSync(h.dest)) { unlinkSync(h.dest); writeFileSync(h.dest, 'other evidence', { mode: 0o600 }); }
    return { schema: 'fleet.bus-request.v1', correlation: 'untrusted-routing-only', receipt: { status: 'not-attempted' },
      outcome: 'replied', reply: null, cursor: 0, elapsedMs: 0 };
  };
  expect(await h.run(['--apply'], { request })).toBe(1);
  expect(JSON.parse(String(h.output.mock.lastCall![0])).status).toBe('all-replied');
  expect(error).toHaveBeenCalledWith('bus-scatter: failed to save output report');
  expect(readFileSync(h.dest, 'utf8')).toBe('other evidence');
});

it.each(['SIGINT', 'SIGTERM'] as const)('persists the handled %s cancellation with queued work', async signalName => {
  const h = setup();
  let stop: (() => void) | undefined;
  const on = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((event: string, listener: (...args: never[]) => void) => {
    if (event === signalName) stop = listener;
    return on(event, listener);
  }) as typeof process.on);
  const request: typeof requestBusRoundtrip = async (input, timeout, interval, options, deps) => {
    const result = requestBusRoundtrip(input, timeout, interval, options, deps);
    stop?.();
    return result;
  };
  expect(await h.run(['--apply', '--timeout-ms', '10000', '--concurrency', '1'], { request })).toBe(1);
  expect(h.saved()).toEqual(JSON.parse(String(h.output.mock.lastCall![0])));
  expect(h.saved()).toMatchObject({ status: 'cancelled', counts: { notAttempted: 1 } });
});
