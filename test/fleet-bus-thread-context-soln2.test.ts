import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetBusThread } from '../src/cli/fleet-bus-thread.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { appendBusInbox, listBusInboxAfter, type BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';
import { projectBusThread } from '../src/core/fleet/bus-thread-context.js';

const roots: string[] = [];
const envelope = (id: string, body: unknown = null, ttl = 1000) => ({ id, from: 'fake-a', to: 'fake-b', priority: 'P2', ttl, body });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'bus-thread-')); roots.push(root);
  const options = { root, now: () => 100 };
  const post = (id: string, body: unknown = null, ttl = 1000) => expect(appendBusInbox(envelope(id, body, ttl), options).status).toBe('posted');
  const output = vi.fn(), error = vi.fn();
  const run = async (id: string, list = listBusInboxAfter, now = 150) => {
    const code = await cmdFleetBusThread(['--id', id, '--json'], { root, now: () => now }, { list, output, error });
    return { code, result: JSON.parse(output.mock.lastCall![0]) };
  };
  return { root, options, post, output, error, run };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('returns cursor-ordered live descendants even when replies precede parents, using exact own correlations', async () => {
  const h = setup();
  h.post('nested', { inReplyTo: 'reply', text: 'fake nested' });
  h.post('unrelated', null);
  h.post('root', { text: 'fake root' });
  h.post('wrong-case', { inReplyTo: 'Root' });
  h.post('array', [{ inReplyTo: 'root' }]);
  h.post('other-shape', { nested: { inReplyTo: 'root' } });
  h.post('reply', { inReplyTo: 'root', text: '\u001b[31mfake' });
  h.post('expired-reply', { inReplyTo: 'root' }, 50);
  h.post('orphan', { inReplyTo: 'expired-reply' });
  const before = readFileSync(join(h.root, 'bus-inbox', 'messages.json'), 'utf8');
  const { code, result } = await h.run('root');
  expect(code).toBe(0);
  expect(result).toMatchObject({ schema: 'fleet.bus-thread.v1', requestedId: 'root', rootFound: true, scannedThrough: 9, complete: true, sourceFailure: null });
  expect(result.messages.map((row: BusInboxReceipt) => row.envelope.id)).toEqual(['nested', 'root', 'reply']);
  expect(result.messages[2].envelope.ttl).toBe(950);
  expect(readFileSync(join(h.root, 'bus-inbox', 'messages.json'), 'utf8')).toBe(before);
  expect((await h.run('Root')).result).toMatchObject({ rootFound: false, messages: [], complete: true });
  expect(await cmdFleetBusThread(['--id', 'root'], { ...h.options, now: () => 150 }, { output: h.output })).toBe(0);
  expect(h.output.mock.calls.at(-1)![0]).not.toContain('\u001b');
}, 60000);

it('finds a thread spanning pages and handles expired and missing roots', async () => {
  const h = setup();
  h.post('early-child', { inReplyTo: 'late-parent' });
  h.post('expired-root', null, 50);
  h.post('expired-root-child', { inReplyTo: 'expired-root' });
  for (let i = 0; i < 105; i++) h.post(`filler-${i}`);
  h.post('root'); h.post('late-parent', { inReplyTo: 'root' });
  const list = vi.fn(listBusInboxAfter);
  const { code, result } = await h.run('root', list);
  expect(code).toBe(0);
  expect(list.mock.calls.map(call => call[0])).toEqual([0, 101]);
  expect(result.scannedThrough).toBe(110);
  expect(result.messages.map((row: BusInboxReceipt) => row.envelope.id)).toEqual(['early-child', 'root', 'late-parent']);
  const failing: typeof listBusInboxAfter = (after, limit, options) => after === 0 ? listBusInboxAfter(after, limit, options) : { status: 'unavailable' };
  const failed = await h.run('root', failing);
  expect(failed.code).toBe(1);
  expect(failed.result).toMatchObject({ rootFound: false, complete: false, sourceFailure: 'unavailable', scannedThrough: 101 });
  for (const id of ['expired-root', 'missing']) {
    const missing = await h.run(id);
    expect(missing.code).toBe(1);
    expect(missing.result).toMatchObject({ rootFound: false, messages: [], complete: true, sourceFailure: null });
  }
}, 300000);

it('rejects malformed pages without claiming completeness', async () => {
  const h = setup();
  const broken: typeof listBusInboxAfter = () => ({ status: 'ok', nextCursor: 0, messages: [
    { cursor: 1, receivedAt: 100, envelope: envelope('root') as BusInboxReceipt['envelope'] },
  ] });
  expect((await h.run('root', broken)).result).toMatchObject({ complete: false, sourceFailure: 'invalid-page', scannedThrough: 0 });
});

it('drops messages that expire while pages are being read', async () => {
  const output = vi.fn(), now = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(150);
  const list: typeof listBusInboxAfter = () => ({ status: 'ok', nextCursor: 1, messages: [
    { cursor: 1, receivedAt: 100, envelope: envelope('root', null, 50) as BusInboxReceipt['envelope'] },
  ] });
  expect(await cmdFleetBusThread(['--id', 'root', '--json'], { now }, { list, output })).toBe(1);
  expect(JSON.parse(output.mock.lastCall![0])).toMatchObject({ rootFound: false, messages: [], complete: true });
});

it('guards cycles and only considers own plain-object data properties', () => {
  const row = (cursor: number, id: string, body: unknown): BusInboxReceipt => ({ cursor, receivedAt: 0, envelope: envelope(id, body) as BusInboxReceipt['envelope'] });
  const inherited = Object.create({ inReplyTo: 'a' });
  const rows = [row(3, 'b', { inReplyTo: 'a' }), row(1, 'a', { inReplyTo: 'b' }), row(2, 'bad', inherited), row(4, 'b', { inReplyTo: 'a' })];
  expect(projectBusThread(rows, 'a').map(r => r.envelope.id)).toEqual(['a', 'b']);
  expect(projectBusThread(rows, 'absent')).toEqual([]);
});

it('applies the shared bus-read filters to the projected chain members only', async () => {
  const h = setup();
  const postAt = (env: Record<string, unknown>, at: number) =>
    expect(appendBusInbox(env, { root: h.root, now: () => at }).status).toBe('posted');
  postAt({ id: 'root', from: 'fake-a', to: 'fake-b', priority: 'P2', ttl: 60_000,
    body: { kind: 'note', text: 'root ask', thread: 'rq-1' } }, 1000);
  postAt({ id: 'mid', from: 'fake-b', to: 'fake-a', priority: 'P2', ttl: 60_000,
    body: { inReplyTo: 'root', kind: 'note', text: 'alpha note', thread: 'rq-1' } }, 2000);
  postAt({ id: 'deep', from: 'fake-a', to: 'fake-b', priority: 'P0', ttl: 60_000,
    body: { inReplyTo: 'mid', kind: 'work.result', outcome: 'failed', jobId: 'RQ-9', text: 'result reply' } }, 3000);
  postAt({ id: 'chan', from: 'fake-b', to: 'group:ops:general', priority: 'P2', ttl: 60_000,
    body: { inReplyTo: 'root', kind: 'note', text: 'channel note' } }, 4000);
  postAt({ id: 'g-alerts', from: 'fake-b', to: 'group:ops:alerts', priority: 'P2', ttl: 60_000,
    body: { inReplyTo: 'root', kind: 'note', text: 'alerts note' } }, 4100);
  postAt({ id: 'g-dev', from: 'fake-b', to: 'group:dev:general', priority: 'P2', ttl: 60_000,
    body: { inReplyTo: 'root', kind: 'note', text: 'dev note' } }, 4200);
  postAt({ id: 'g-bare', from: 'fake-b', to: 'group:ops', priority: 'P2', ttl: 60_000,
    body: { inReplyTo: 'root', kind: 'note', text: 'bare room note' } }, 4300);
  postAt({ id: 'g-deep', from: 'fake-b', to: 'group:ops:general:deep', priority: 'P2', ttl: 60_000,
    body: { inReplyTo: 'root', kind: 'note', text: 'deep label note' } }, 4400);
  postAt({ id: 'other', from: 'fake-a', to: 'fake-b', priority: 'P2', ttl: 60_000,
    body: { inReplyTo: 'root', text: 'kindless other' } }, 5000);
  // An unrelated message stays out of the projection itself, filters or not.
  postAt({ id: 'sibling', from: 'fake-a', to: 'fake-b', priority: 'P2', ttl: 60_000,
    body: { inReplyTo: 'ghost', kind: 'note', text: 'not in root chain' } }, 6000);
  const runArgs = async (args: string[]) => {
    const output = vi.fn(), error = vi.fn();
    const code = await cmdFleetBusThread(['--id', 'root', '--json', ...args], { root: h.root, now: () => 7000 }, { output, error });
    return { code, result: JSON.parse(output.mock.lastCall?.[0] ?? 'null'), error: error.mock.calls.flat().join(' ') };
  };
  const ids = (result: { messages: BusInboxReceipt[] }) => result.messages.map(row => row.envelope.id);
  // The unfiltered baseline: cursor order, sibling excluded by the walk itself.
  const all = await runArgs([]);
  expect(all.code).toBe(0);
  expect(ids(all.result)).toEqual(['root', 'mid', 'deep', 'chan', 'g-alerts', 'g-dev', 'g-bare', 'g-deep', 'other']);
  // Sender include/exclude through exact labels (no registry in this root).
  expect(ids((await runArgs(['--from', 'fake-a'])).result)).toEqual(['root', 'deep', 'other']);
  expect(ids((await runArgs(['--exclude-from', 'fake-a'])).result))
    .toEqual(['mid', 'chan', 'g-alerts', 'g-dev', 'g-bare', 'g-deep']);
  expect(ids((await runArgs(['--to', 'fake-b'])).result)).toEqual(['root', 'deep', 'other']);
  // Priority band, receivedAt window, contains needle and reply citation.
  expect(ids((await runArgs(['--priority', 'P0'])).result)).toEqual(['deep']);
  expect(ids((await runArgs(['--since', '2500', '--before', '4500'])).result))
    .toEqual(['deep', 'chan', 'g-alerts', 'g-dev', 'g-bare', 'g-deep']);
  expect(ids((await runArgs(['--contains', 'ALPHA'])).result)).toEqual(['mid']);
  expect(ids((await runArgs(['--in-reply-to', 'mid'])).result)).toEqual(['deep']);
  expect(ids((await runArgs(['--in-reply-to', 'root'])).result))
    .toEqual(['mid', 'chan', 'g-alerts', 'g-dev', 'g-bare', 'g-deep', 'other']);
  // Body discriminators: work.result outcome, v2 kind and thread label, job citation, channel prefix.
  expect(ids((await runArgs(['--result', 'failed'])).result)).toEqual(['deep']);
  expect(ids((await runArgs(['--body-kind', 'note'])).result))
    .toEqual(['root', 'mid', 'chan', 'g-alerts', 'g-dev', 'g-bare', 'g-deep']);
  expect(ids((await runArgs(['--thread', 'rq-1'])).result)).toEqual(['root', 'mid']);
  expect(ids((await runArgs(['--job', 'RQ-9'])).result)).toEqual(['deep']);
  // --channel keeps every member under the room's prefix, whatever its topic
  // segment parses to — including the bare 'group:ops' room label, which has
  // no topic component at all and a four-segment 'general:deep' label, whose
  // topic part fails the channel-name grammar.
  expect(ids((await runArgs(['--channel', 'ops'])).result)).toEqual(['chan', 'g-alerts', 'g-deep']);
  // --topic keeps only members whose to parses to that exact topic component:
  // 'group:dev:general' matches 'general' in its own room, the bare room and
  // the malformed four-segment label never match, and --channel composes
  // into one room AND one topic.
  expect(ids((await runArgs(['--topic', 'general'])).result)).toEqual(['chan', 'g-dev']);
  expect(ids((await runArgs(['--topic', 'alerts'])).result)).toEqual(['g-alerts']);
  expect(ids((await runArgs(['--channel', 'ops', '--topic', 'general'])).result)).toEqual(['chan']);
  expect(ids((await runArgs(['--channel', 'ops', '--topic', 'alerts'])).result)).toEqual(['g-alerts']);
  expect(ids((await runArgs(['--channel', 'dev', '--topic', 'general'])).result)).toEqual(['g-dev']);
  expect(ids((await runArgs(['--topic', 'work'])).result)).toEqual([]);
  // Filters compose conjunctively.
  expect(ids((await runArgs(['--from', 'fake-a', '--priority', 'P2'])).result)).toEqual(['root', 'other']);
  // A filter that excludes every member keeps rootFound — an honest no-match,
  // never a proven miss — and the walk honesty fields still describe the chain.
  const none = await runArgs(['--priority', 'P3']);
  expect(none.code).toBe(0);
  expect(none.result).toMatchObject({ rootFound: true, messages: [], complete: true, scannedThrough: 10 });
  // --since/--before take the shared grammar; epoch-ms bounds work the same.
  expect(ids((await runArgs(['--since', '4000'])).result))
    .toEqual(['chan', 'g-alerts', 'g-dev', 'g-bare', 'g-deep', 'other']);
  expect(ids((await runArgs(['--before', '2000'])).result)).toEqual(['root']);
  // Invalid filter values are usage errors before any store read.
  for (const bad of [['--priority', 'P9'], ['--result', 'lost'], ['--channel', 'Bad Name'],
    ['--topic', 'Bad Name'], ['--topic'],
    ['--since', 'whenever'], ['--contains', ''], ['--from', 'bad id'], ['--in-reply-to', 'has space'],
    ['--body-kind', 'has space'], ['--thread', 'has space'], ['--job', 'has space'],
    ['--to', 'has space'], ['--exclude-from', 'has space'], ['--contains', 'x'.repeat(600)],
    ['--priority'], ['--from', 'a', '--from', 'b']]) {
    const refused = await runArgs(bad);
    expect(refused.code, JSON.stringify(bad)).toBe(2);
    expect(refused.result).toBeNull();
  }
}, 60000);

it('frames the reply chain as one bounded untrusted block', async () => {
  const h = setup();
  h.post('tf-root', { text: 'root question' });
  h.post('tf-reply', { inReplyTo: 'tf-root', text: 'classified answer' });
  h.post('tf-kid', { inReplyTo: 'tf-reply', text: 'kindless follow-up' });
  // --json --frame carries the bounded block on `framed` beside the full projection.
  const framedOut = vi.fn();
  expect(await cmdFleetBusThread(['--id', 'tf-root', '--json', '--frame', 'claude'],
    { root: h.root, now: () => 150 }, { output: framedOut })).toBe(0);
  const result = JSON.parse(framedOut.mock.lastCall![0]);
  expect(result.framed).toContain('BEGIN UNTRUSTED AGENT BUS THREAD');
  expect(result.framed).toContain('tf-root');
  expect(result.framed).toContain('tf-reply');
  expect(result.framed).toContain('tf-kid');
  expect(result.framed).toContain('root question');
  expect(result.framed).toContain('classified answer');
  expect(result.framed).toContain('kindless follow-up');
  expect(result.framed).toContain('END UNTRUSTED AGENT BUS THREAD');
  // A thread block can never pass for an inbox page, a digest or a feed.
  expect(result.framed).not.toContain('BEGIN UNTRUSTED AGENT BUS MESSAGES');
  expect(result.framed).not.toContain('WORK DIGEST');
  expect(result.framed).not.toContain('WORK FEED');
  // Human (non-json) output is the bare frame — one bounded block, not the
  // per-line envelope dump the unframed read prints.
  const framedText = vi.fn();
  expect(await cmdFleetBusThread(['--id', 'tf-root', '--frame', 'grok'],
    { root: h.root, now: () => 150 }, { output: framedText })).toBe(0);
  expect(framedText).toHaveBeenCalledTimes(1);
  expect(framedText.mock.calls[0]![0]).toContain('BEGIN UNTRUSTED AGENT BUS THREAD');
  expect(framedText.mock.calls[0]![0]).toContain('kindless follow-up');
  // A proven miss frames its own not-found verdict, never an invented chain.
  const miss = vi.fn();
  expect(await cmdFleetBusThread(['--id', 'tf-404', '--json', '--frame', 'claude'],
    { root: h.root, now: () => 150 }, { output: miss })).toBe(1);
  const missResult = JSON.parse(miss.mock.lastCall![0]);
  expect(missResult.framed).toContain('not found');
  expect(missResult.framed).toContain('BEGIN UNTRUSTED AGENT BUS THREAD');
  // --frame takes one of the five session CLIs; anything else is a usage error.
  for (const bad of [['--frame'], ['--frame', 'gemini'], ['--frame', '--json'],
    ['--frame='], ['--id', 'tf-root', '--frame', 'claude', '--frame', 'codex']]) {
    const refused = vi.fn(), refusedError = vi.fn();
    expect(await cmdFleetBusThread(bad, { root: h.root }, { output: refused, error: refusedError }),
      JSON.stringify(bad)).toBe(2);
  }
}, 60000);

it('rejects invalid options before reading and exposes the convention-resolved export', async () => {
  const list = vi.fn(listBusInboxAfter), output = vi.fn(), error = vi.fn();
  for (const args of [[], ['--id'], ['--id', '--json'], ['--id='], ['--id', 'bad id'], ['--id', 'x', '--id', 'y'], ['--id', 'x', '--unknown'], ['--id', 'x', '--json', '--json']]) {
    expect(await cmdFleetBusThread(args, {}, { list, output, error })).toBe(2);
  }
  expect(list).not.toHaveBeenCalled();
  const resolved = resolveFleetSubcommand('bus-thread');
  expect(resolved).toEqual({ module: './fleet-bus-thread.js', exportName: 'cmdFleetBusThread' });
  const module = await import('../src/cli/fleet-bus-thread.js');
  expect(module[resolved!.exportName as keyof typeof module]).toBe(cmdFleetBusThread);
});
