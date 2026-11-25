import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdBus } from '../src/cli/bus.js';
import { registerAgentIdentity } from '../src/core/agents/bus-identity.js';
import { createBusMailbox, type BusMailbox } from '../src/core/fleet/bus-mailbox.js';
import { MAX_BUS_ENVELOPE_BYTES, validateBusEnvelope, type BusEnvelope } from '../src/core/fleet/bus-envelope.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
let home: string;
let time: number;
let bus: BusMailbox;
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;
const envelope = (overrides: Partial<BusEnvelope> = {}): BusEnvelope => ({
  id: 'message-1', from: 'codex-cmp', to: 'fleet', priority: 'P2', ttl: 1000,
  body: { text: 'FAKE local test message', reference: 'phm_example' }, ...overrides,
});
const sendArgs = ['send', '--from', 'codex-cmp', '--to', 'fleet', '--body', '{"hello":"world"}'];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'phm-bus-test-'));
  time = 1000;
  bus = createBusMailbox(home, () => time);
  stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });

async function invoke(args: string[], load = () => bus) {
  stdout.mockClear(); stderr.mockClear();
  const code = await cmdBus(args, load);
  const lines = stdout.mock.calls.map(call => String(call[0]));
  return { code, lines, error: stderr.mock.calls.map(call => String(call[0])).join('\n') };
}
async function json(args: string[], load = () => bus) {
  const result = await invoke([...args, '--json'], load);
  expect(result.lines).toHaveLength(1);
  expect(result.error).toBe('');
  return { ...result, value: JSON.parse(result.lines[0]!) };
}
function child(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'bus', ...args], {
    cwd: repo, encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, ASHLR_HOME: join(home, '.ashlr'), NO_COLOR: '1' },
  });
}

describe('phm bus CLI', () => {
  it('sends an opaque body with defaults and reads it without acknowledging', async () => {
    const sent = await json(sendArgs);
    expect(sent.code).toBe(0);
    expect(sent.value).toEqual({ ok: true, id: expect.stringMatching(/^[a-f0-9-]{36}$/), replayed: false });
    const first = await json(['inbox', '--to', 'fleet']);
    expect(first.value).toEqual({ ok: true, hasMore: false, messages: [{
      id: sent.value.id, from: 'codex-cmp', to: 'fleet', priority: 'P2', ttl: 300000, body: { hello: 'world' },
    }] });
    expect((await json(['inbox', '--to', 'fleet'])).value).toEqual(first.value);
    expect((await json(['inbox', '--to', 'other'])).value.messages).toEqual([]);
  });

  it('honors explicit identity, priority, TTL and idempotent ack', async () => {
    const args = [...sendArgs, '--id', 'retry-1', '--priority', 'P0', '--ttl', '50'];
    expect((await json(args)).value.replayed).toBe(false);
    expect((await json(args)).value.replayed).toBe(true);
    time += 10;
    expect((await json(['inbox', '--to', 'fleet'])).value.messages[0]).toMatchObject({ id: 'retry-1', priority: 'P0', ttl: 40 });
    expect((await json(['ack', 'retry-1', '--to', 'other'])).code).toBe(1);
    expect((await json(['ack', 'retry-1', '--to', 'fleet'])).value).toEqual({ ok: true, id: 'retry-1', acknowledged: true, replayed: false });
    expect((await json(['ack', 'retry-1', '--to', 'fleet'])).value.replayed).toBe(true);
    expect((await json(['inbox', '--to', 'fleet'])).value.messages).toEqual([]);
  });

  it.each(['null', 'false', '0', '""', '[]', '{"nested":[true,"東京"]}'])(
    'preserves JSON body %s', async body => {
      expect((await json(['send', '--from', 'a', '--to', 'b', '--body', body])).code).toBe(0);
      expect((await json(['inbox', '--to', 'b'])).value.messages[0].body).toEqual(JSON.parse(body));
    },
  );

  it.each([
    [], ['send'], ['unknown'], ['toString'], ['constructor'], ['send', '--json', '--json'],
    ['send', '--from'], [...sendArgs, '--ttl'], [...sendArgs, '--ttl', '--id', 'm'],
    [...sendArgs, '--to', 'second'], [...sendArgs, '--priority', 'urgent'],
    [...sendArgs, '--typo'], [...sendArgs, 'extra'], ['inbox'], ['inbox', '--to', 'fleet', 'extra'],
    ['inbox', '--to', 'fleet', '--body', '{}'], ['ack', '--to', 'fleet'],
    ['ack', 'a', 'b', '--to', 'fleet'], ['ack', 'a', '--to', 'fleet', '--ttl', '5'],
    ['inbox', '--to', ''], ['inbox', '--to', 'two words'], ['inbox', '--to', 'trailing\n'],
    ['send', '--from', 'a', '--to', 'b', '--body', '{'],
    ['send', '--from', 'a', '--to', 'b', '--body', '--help'],
  ].map(args => [args]))('rejects malformed argv before loading core: %j', async args => {
    const load = vi.fn(() => bus);
    const result = await json(args, load);
    expect(result.code).toBe(2);
    expect(result.value.ok).toBe(false);
    expect(result.value.error.code).toBe('usage');
    expect(load).not.toHaveBeenCalled();
    expect(readdirSync(home)).toEqual([]);
  });

  it.each(['0', '-1', '1.2', '1e3', '10ms', '9007199254740992', 'Infinity', 'NaN'])(
    'rejects an invalid TTL without coercion: %s', async ttl => {
      expect((await json([...sendArgs, '--ttl', ttl])).code).toBe(2);
      expect(readdirSync(home)).toEqual([]);
    },
  );
  it.each(['0', '1001', '-2', '2.5', '2items'])(
    'rejects invalid inbox limit %s', async limit => {
      expect((await json(['inbox', '--to', 'fleet', '--limit', limit])).code).toBe(2);
      expect(readdirSync(home)).toEqual([]);
    },
  );

  it.each([['--help'], ['-h'], ['send', '--help'], ['ack', '-h'], ['inbox', '--help']].map(args => [args]))(
    'help is side-effect free: %j', async args => {
      const load = vi.fn(() => bus);
      const result = await json(args, load);
      expect(result.code).toBe(0);
      expect(result.value.usage).toContain('phm bus');
      expect(load).not.toHaveBeenCalled();
      expect(readdirSync(home)).toEqual([]);
    },
  );

  it('accepts the global JSON flag before the verb', async () => {
    const result = await invoke(['--json', ...sendArgs]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.lines[0]!).ok).toBe(true);
  });

  it.each(['-message', '-h', '--json', '--id'])('round-trips flag-shaped message ID %s', async id => {
    expect((await json([...sendArgs, `--id=${id}`])).code).toBe(0);
    const ack = await invoke(['ack', '--to', 'fleet', '--json', '--', id]);
    expect(ack.code).toBe(0);
    expect(JSON.parse(ack.lines[0]!)).toEqual({ ok: true, id, acknowledged: true, replayed: false });
    expect(bus.inbox('fleet').messages).toEqual([]);
  });

  it('does not interpret literal --json as a JSON output flag', async () => {
    await json([...sendArgs, '--id=--json']);
    const result = await invoke(['ack', '--to', 'fleet', '--', '--json']);
    expect(result.code).toBe(0);
    expect(result.lines).toEqual(['Acknowledged: --json']);
  });

  it('accepts equals syntax for flag-shaped routing labels and body strings', async () => {
    expect((await json(['send', '--from=--sender', '--to=--recipient', '--body="--help"'])).code).toBe(0);
    expect((await json(['inbox', '--to=--recipient'])).value.messages[0]).toMatchObject({ from: '--sender', to: '--recipient', body: '--help' });
  });

  it('has useful human success, empty inbox and error output', async () => {
    expect((await invoke(['inbox', '--to', 'fleet'])).lines).toEqual(['No pending messages.']);
    expect((await invoke([...sendArgs, '--id', 'm'])).lines[0]).toContain('accepted: m');
    expect((await invoke(['inbox', '--to', 'fleet'])).lines[0]).toContain('{"hello":"world"}');
    expect((await invoke(['ack', 'm', '--to', 'fleet'])).lines).toEqual(['Acknowledged: m']);
    const invalid = await invoke(['unknown']);
    expect(invalid.code).toBe(2);
    expect(invalid.lines).toEqual([]);
    expect(invalid.error).toContain('Usage: phm bus');
  });

  it('never prints or persists runtime-built FAKE credentials', async () => {
    const FAKE = ['gh', 'p_', 'FAKE', 'Ab12'.repeat(10)].join('');
    const result = await json(['send', '--from', 'a', '--to', 'b', '--body', JSON.stringify({ value: FAKE })]);
    expect(result.code).toBe(1);
    expect(result.value.error.code).toBe('credentials');
    expect(result.lines.join('').includes(FAKE)).toBe(false);
    expect(readdirSync(home)).toEqual([]);
    const unknown = await json([...sendArgs, '--' + FAKE]);
    expect(unknown.code).toBe(2);
    expect(unknown.lines.join('').includes(FAKE)).toBe(false);
  });

  it('keeps unexpected core exceptions out of stdout and stderr', async () => {
    const result = await json(sendArgs, () => { throw new Error('FAKE private path and raw data'); });
    expect(result.code).toBe(1);
    expect(result.value).toEqual({ ok: false, error: { code: 'operation-failed', message: 'Bus operation failed.' } });
  });

  it('rejects oversized and excessively nested JSON before storage', async () => {
    const large = await json(['send', '--from', 'a', '--to', 'b', '--body', JSON.stringify('x'.repeat(MAX_BUS_ENVELOPE_BYTES))]);
    expect(large.code).toBe(2);
    const deep = await json(['send', '--from', 'a', '--to', 'b', '--body', '['.repeat(33) + '0' + ']'.repeat(33)]);
    expect(deep.code).toBe(2);
    expect(readdirSync(home)).toEqual([]);
  });
});

describe('phm bus inbox read filters', () => {
  const ids = (value: { messages: { id: string }[] }): string[] => value.messages.map(m => m.id);

  it('keeps one priority band and reports the filtered truncation honestly', async () => {
    bus.send(envelope({ id: 'urgent', priority: 'P0' }));
    time++;
    bus.send(envelope({ id: 'urgent-later', priority: 'P0' }));
    bus.send(envelope({ id: 'normal', priority: 'P2' }));
    bus.send(envelope({ id: 'low', priority: 'P3' }));
    const result = await json(['inbox', '--to', 'fleet', '--priority', 'P0']);
    expect(ids(result.value)).toEqual(['urgent', 'urgent-later']);
    expect(result.value.hasMore).toBe(false);
    // hasMore counts the filtered pending set: two P0 matches against limit 1 truncates even though three other priorities wait.
    const limited = await json(['inbox', '--to', 'fleet', '--priority', 'P0', '--limit', '1']);
    expect(ids(limited.value)).toEqual(['urgent']);
    expect(limited.value.hasMore).toBe(true);
    const none = await json(['inbox', '--to', 'fleet', '--priority', 'P1']);
    expect(none.value).toEqual({ ok: true, hasMore: false, messages: [] });
  });

  it('filters by sender label and excludes one, resolving identities through the registry', async () => {
    bus.send(envelope({ id: 'from-alice', from: 'alice' }));
    bus.send(envelope({ id: 'from-bob', from: 'bob' }));
    expect(ids((await json(['inbox', '--to', 'fleet', '--from', 'alice'])).value)).toEqual(['from-alice']);
    expect(ids((await json(['inbox', '--to', 'fleet', '--exclude-from', 'alice'])).value)).toEqual(['from-bob']);
    // An unresolvable ref keeps exact-label matching: no identity named 'carol' exists.
    expect(ids((await json(['inbox', '--to', 'fleet', '--from', 'carol'])).value)).toEqual([]);
  });

  it('matches every label of one registered identity for --from and --exclude-from', async () => {
    const registered = registerAgentIdentity({ handle: 'devin', aliases: ['legacy-dv'] });
    expect(registered.status).toBe('created');
    bus.send(envelope({ id: 'via-handle', from: 'agent:devin' }));
    bus.send(envelope({ id: 'via-alias', from: 'legacy-dv' }));
    bus.send(envelope({ id: 'via-other', from: 'other' }));
    const from = await json(['inbox', '--to', 'fleet', '--from', 'devin']);
    expect(ids(from.value).sort()).toEqual(['via-alias', 'via-handle']);
    const excluded = await json(['inbox', '--to', 'fleet', '--exclude-from', 'devin']);
    expect(ids(excluded.value)).toEqual(['via-other']);
  });

  it('keeps mail inside the [since, before) acceptance-time window', async () => {
    // ttl outlives the whole window so expiry never masquerades as a filter miss.
    const live = { ttl: 86_400_000 };
    time = 1000; bus.send(envelope({ id: 'early', ...live }));
    time = 2000; bus.send(envelope({ id: 'middle', ...live }));
    time = 3000; bus.send(envelope({ id: 'late', ...live }));
    time = 3000;
    // --since is inclusive, --before exclusive: the pair reads one [since, before) window.
    expect(ids((await json(['inbox', '--to', 'fleet', '--since', '2000', '--before', '3000'])).value)).toEqual(['middle']);
    expect(ids((await json(['inbox', '--to', 'fleet', '--since', '2000'])).value)).toEqual(['middle', 'late']);
    expect(ids((await json(['inbox', '--to', 'fleet', '--before', '2000'])).value)).toEqual(['early']);
    expect(ids((await json(['inbox', '--to', 'fleet', '--before', '1000'])).value)).toEqual([]);
    expect(ids((await json(['inbox', '--to', 'fleet', '--since', '15m'])).value)).toEqual([]);
  });

  it('keeps envelopes whose body cites the job, thread or reply id', async () => {
    bus.send(envelope({ id: 'job-mail', body: { kind: 'note', thread: 'job:RQ-7', text: 'about the feed' } }));
    bus.send(envelope({ id: 'thread-mail', body: { kind: 'note', thread: 't-42', text: 'side chat' } }));
    bus.send(envelope({ id: 'reply-mail', body: { inReplyTo: 'orig-1', text: 'the answer' } }));
    bus.send(envelope({ id: 'plain', body: { text: 'unrelated' } }));
    expect(ids((await json(['inbox', '--to', 'fleet', '--job', 'RQ-7'])).value)).toEqual(['job-mail']);
    expect(ids((await json(['inbox', '--to', 'fleet', '--thread', 't-42'])).value)).toEqual(['thread-mail']);
    expect(ids((await json(['inbox', '--to', 'fleet', '--in-reply-to', 'orig-1'])).value)).toEqual(['reply-mail']);
    expect(ids((await json(['inbox', '--to', 'fleet', '--in-reply-to', 'job-mail'])).value)).toEqual([]);
  });

  it('keeps envelopes addressed to the channel prefix and matches --contains on the rendered summary', async () => {
    bus.send(envelope({ id: 'chan-work', to: 'group:general:work', body: { text: 'deploy the fix' } }));
    bus.send(envelope({ id: 'chan-alerts', to: 'group:general:alerts', body: { text: 'deploy the alarm' } }));
    bus.send(envelope({ id: 'dm', to: 'fleet', body: { text: 'deploy the plan' } }));
    // --channel keeps the room's whole traffic under every topic on the same to label.
    expect(ids((await json(['inbox', '--to', 'group:general:work', '--channel', 'general'])).value)).toEqual(['chan-work']);
    expect(ids((await json(['inbox', '--to', 'group:general:work', '--channel', 'alerts'])).value)).toEqual([]);
    // --contains is a case-insensitive substring of the scrubbed one-line summary.
    expect(ids((await json(['inbox', '--to', 'fleet', '--contains', 'DEPLOY THE'])).value)).toEqual(['dm']);
    expect(ids((await json(['inbox', '--to', 'fleet', '--contains', 'nomatch'])).value)).toEqual([]);
  });

  it('keeps only the envelope whose own id is strictly equal', async () => {
    bus.send(envelope({ id: 'want-me' }));
    bus.send(envelope({ id: 'want-me-too' }));
    bus.send(envelope({ id: 'other' }));
    expect(ids((await json(['inbox', '--to', 'fleet', '--id', 'want-me'])).value)).toEqual(['want-me']);
    // The match is the whole id, never a substring or prefix.
    expect(ids((await json(['inbox', '--to', 'fleet', '--id', 'want'])).value)).toEqual([]);
    expect(ids((await json(['inbox', '--to', 'fleet', '--id', 'missing'])).value)).toEqual([]);
    // --id scopes inside the --to recipient's pending set, like every other filter.
    bus.send(envelope({ id: 'shared-id', to: 'other' }));
    expect(ids((await json(['inbox', '--to', 'other', '--id', 'shared-id'])).value)).toEqual(['shared-id']);
    expect(ids((await json(['inbox', '--to', 'fleet', '--id', 'shared-id'])).value)).toEqual([]);
  });

  it('keeps only mail whose retained body carries the kind discriminator', async () => {
    bus.send(envelope({ id: 'v2-note', body: { kind: 'note', thread: 't-1', text: 'hi' } }));
    bus.send(envelope({ id: 'v2-claim', body: { kind: 'work.claim', claimKey: 'pr:1' } }));
    bus.send(envelope({ id: 'proto', body: { protocol: { version: 1, kind: 'task' }, text: 'wrapped' } }));
    bus.send(envelope({ id: 'typed', body: { type: 'handoff', text: 'typed' } }));
    bus.send(envelope({ id: 'kindless', body: { text: 'no discriminator' } }));
    expect(ids((await json(['inbox', '--to', 'fleet', '--body-kind', 'note'])).value)).toEqual(['v2-note']);
    expect(ids((await json(['inbox', '--to', 'fleet', '--body-kind', 'work.claim'])).value)).toEqual(['v2-claim']);
    expect(ids((await json(['inbox', '--to', 'fleet', '--body-kind', 'task'])).value)).toEqual(['proto']);
    expect(ids((await json(['inbox', '--to', 'fleet', '--body-kind', 'handoff'])).value)).toEqual(['typed']);
    // A body with no kind discriminator never matches, and the match is exact
    // and case-sensitive like every other own-field bus filter.
    expect(ids((await json(['inbox', '--to', 'fleet', '--body-kind', 'text'])).value)).toEqual([]);
    expect(ids((await json(['inbox', '--to', 'fleet', '--body-kind', 'Note'])).value)).toEqual([]);
    expect(ids((await json(['inbox', '--to', 'fleet', '--body-kind', 'missing'])).value)).toEqual([]);
  });

  it('keeps only work.result mail whose own outcome strictly equals the code', async () => {
    bus.send(envelope({ id: 'res-received', body: { kind: 'work.result', outcome: 'reserved' } }));
    bus.send(envelope({ id: 'res-complete', body: { kind: 'work.result', outcome: 'complete' } }));
    bus.send(envelope({ id: 'res-failed', body: { kind: 'work.result', outcome: 'failed' } }));
    bus.send(envelope({ id: 'res-nooutcome', body: { kind: 'work.result' } }));
    bus.send(envelope({ id: 'release', body: { kind: 'work.release', outcome: 'released' } }));
    bus.send(envelope({ id: 'borrowing', body: { kind: 'note', outcome: 'complete', text: 'borrowing the word' } }));
    bus.send(envelope({ id: 'kindless', body: { outcome: 'complete' } }));
    expect(ids((await json(['inbox', '--to', 'fleet', '--result', 'reserved'])).value)).toEqual(['res-received']);
    expect(ids((await json(['inbox', '--to', 'fleet', '--result', 'complete'])).value)).toEqual(['res-complete']);
    expect(ids((await json(['inbox', '--to', 'fleet', '--result', 'failed'])).value)).toEqual(['res-failed']);
    // A work.result carrying no outcome, a work.release's own outcome vocabulary,
    // every other body kind and a kindless outcome field never match.
    expect(ids((await json(['inbox', '--to', 'fleet', '--result', 'admitted'])).value)).toEqual([]);
  });

  it('ANDs every supplied filter and keeps hasMore honest about the filtered set', async () => {
    bus.send(envelope({ id: 'hit', from: 'alice', priority: 'P0', body: { kind: 'note', thread: 'job:RQ-9', text: 'needle here' } }));
    bus.send(envelope({ id: 'miss-priority', from: 'alice', priority: 'P2', body: { kind: 'note', thread: 'job:RQ-9', text: 'needle here' } }));
    bus.send(envelope({ id: 'miss-job', from: 'alice', priority: 'P0', body: { text: 'needle here' } }));
    bus.send(envelope({ id: 'miss-sender', from: 'bob', priority: 'P0', body: { kind: 'note', thread: 'job:RQ-9', text: 'needle here' } }));
    const result = await json(['inbox', '--to', 'fleet', '--from', 'alice', '--priority', 'P0',
      '--job', 'RQ-9', '--contains', 'needle']);
    expect(ids(result.value)).toEqual(['hit']);
    expect(result.value.hasMore).toBe(false);
  });

  it('rejects malformed filter values before loading the store', async () => {
    const load = vi.fn(() => bus);
    for (const args of [
      ['inbox', '--to', 'fleet', '--priority', 'urgent'],
      ['inbox', '--to', 'fleet', '--since', 'not-a-time'],
      ['inbox', '--to', 'fleet', '--before', 'not-a-time'],
      ['inbox', '--to', 'fleet', '--contains', '   '],
      ['inbox', '--to', 'fleet', '--channel', 'Bad Channel'],
      ['inbox', '--to', 'fleet', '--job', 'two words'],
      ['inbox', '--to', 'fleet', '--from', ''],
      ['inbox', '--to', 'fleet', '--in-reply-to', 'has space'],
      ['inbox', '--to', 'fleet', '--id', 'has space'],
      ['inbox', '--to', 'fleet', '--id='],
      ['inbox', '--to', 'fleet', '--body-kind', 'two words'],
      ['inbox', '--to', 'fleet', '--result', 'done'],
      ['inbox', '--to', 'fleet', '--result', 'Complete'],
      ['inbox', '--to', 'fleet', '--result', 'released'],
      ['inbox', '--to', 'fleet', '--result', ''],
      ['send', '--from', 'a', '--to', 'b', '--body', '{}', '--priority', 'P0', '--contains', 'x'],
      ['send', '--from', 'a', '--to', 'b', '--body', '{}', '--body-kind', 'note'],
      ['send', '--from', 'a', '--to', 'b', '--body', '{}', '--result', 'complete'],
      ['ack', 'a', '--to', 'fleet', '--since', '1h'],
      ['ack', 'a', '--to', 'fleet', '--id', 'x'],
    ]) {
      const result = await json(args, load);
      expect(result.code, JSON.stringify(args)).toBe(2);
      expect(result.value.error.code).toBe('usage');
    }
    expect(load).not.toHaveBeenCalled();
    expect(readdirSync(home)).toEqual([]);
  });
});

describe('local durable bus core', () => {
  it('persists across instances; expiration and replay do not renew TTL', () => {
    bus.send(envelope());
    time += 999;
    expect(createBusMailbox(home, () => time).inbox('fleet').messages[0].ttl).toBe(1);
    time++;
    expect(bus.send(envelope()).replayed).toBe(true);
    expect(bus.inbox('fleet').messages).toEqual([]);
    expect(bus.ack('message-1', 'fleet').acknowledged).toBe(true);
  });

  it('orders by priority then acceptance and reports truncation', async () => {
    bus.send(envelope({ id: 'low', priority: 'P3' }));
    bus.send(envelope({ id: 'first', priority: 'P0' }));
    time++;
    bus.send(envelope({ id: 'second', priority: 'P0' }));
    bus.send(envelope({ id: 'middle', priority: 'P1' }));
    const result = await json(['inbox', '--to', 'fleet', '--limit', '2']);
    expect(result.value.hasMore).toBe(true);
    expect(result.value.messages.map((m: BusEnvelope) => m.id)).toEqual(['first', 'second']);
    expect(bus.inbox('fleet').messages.map(m => m.id)).toEqual(['first', 'second', 'middle', 'low']);
    const human = await invoke(['inbox', '--to', 'fleet', '--limit', '1']);
    expect(human.lines[0]).toContain('More pending messages');
  });

  it('pendingAll lists every recipient\'s pending mail in drain order with the true total', () => {
    bus.send(envelope({ id: 'low', to: 'other', priority: 'P3' }));
    bus.send(envelope({ id: 'first', priority: 'P0' }));
    time++;
    bus.send(envelope({ id: 'second', to: 'other', priority: 'P0' }));
    bus.send(envelope({ id: 'middle', priority: 'P1' }));
    const all = bus.pendingAll();
    expect(all.source).toBe('available');
    expect(all.matched).toBe(4);
    expect(all.messages.map(m => m.envelope.id)).toEqual(['first', 'second', 'middle', 'low']);
    // Each row keeps its own `to` — the --to inbox/ack take for that message.
    expect(all.messages.map(m => m.envelope.to)).toEqual(['fleet', 'other', 'fleet', 'other']);
    const limited = bus.pendingAll(2);
    expect(limited.source).toBe('available');
    expect(limited.messages.map(m => m.envelope.id)).toEqual(['first', 'second']);
    expect(limited.matched).toBe(4);
  });

  it('pendingAll omits acknowledged and expired mail and reports a missing store honestly', () => {
    expect(bus.pendingAll()).toEqual({ source: 'missing', messages: [], matched: 0 });
    bus.send(envelope({ id: 'expired' }));
    time += 500;
    bus.send(envelope({ id: 'acked' }));
    time += 100;
    bus.ack('acked', 'fleet');
    time += 100;
    bus.send(envelope({ id: 'live' }));
    time += 600; // 'expired' (acceptedAt 1000, ttl 1000) is past its window; 'live' still has 400ms left.
    const all = bus.pendingAll();
    expect(all.source).toBe('available');
    expect(all.matched).toBe(1);
    expect(all.messages.map(m => m.envelope.id)).toEqual(['live']);
    expect(all.messages[0]!.acceptedAt).toBe(1700);
  });

  it('pendingAll reports an unreadable store as unavailable with unknown counts, never zero', () => {
    bus.send(envelope());
    const record = join(home, 'bus-mailbox', 'records', readdirSync(join(home, 'bus-mailbox', 'records'))[0]!);
    writeFileSync(record, '{malformed');
    expect(bus.pendingAll()).toEqual({ source: 'unavailable', messages: [], matched: null });
    expect(() => bus.pendingAll(0)).toThrow('Invalid bus envelope');
    expect(() => bus.pendingAll(5001)).toThrow('Invalid bus envelope');
  });

  it('rejects same-ID content or recipient conflicts and preserves the original', async () => {
    bus.send(envelope());
    expect(() => bus.send(envelope({ body: 'changed' }))).toThrow('different contents');
    expect(() => bus.send(envelope({ to: 'other' }))).toThrow('different contents');
    expect(bus.inbox('fleet').messages).toEqual([envelope()]);
    const missing = await json(['ack', 'unknown', '--to', 'fleet']);
    expect(missing.code).toBe(1);
    expect(missing.value.error.code).toBe('not-found');
    expect(readdirSync(join(home, 'bus-mailbox', 'records'))).toHaveLength(1);
  });

  it('refuses channel-aware envelopes reserved for the task board', () => {
    const channel = envelope({
      channel: 'bus', channel_ref: 'thread-1',
      sender: { agent_id: 'codex-cmp', vendor: 'openai', human: false, team: true },
      external: false,
    });
    expect(() => bus.send(channel)).toThrow('Invalid bus envelope');
    expect(readdirSync(home)).toEqual([]);
  });

  it('hashes path-shaped labels and message IDs instead of using them as paths', () => {
    const input = envelope({ id: '../outside/message', to: '../../recipient' });
    bus.send(input);
    expect(bus.inbox(input.to).messages).toEqual([input]);
    bus.ack(input.id, input.to);
    expect(bus.inbox(input.to).messages).toEqual([]);
    expect(readdirSync(home)).toEqual(['bus-mailbox']);
    expect(readdirSync(join(home, 'bus-mailbox', 'records')).every(name => /^[ma]-[a-f0-9]{64}\.json$/.test(name))).toBe(true);
  });

  it('missing inbox and failed ack create no store', () => {
    expect(bus.inbox('fleet')).toEqual({ messages: [], hasMore: false });
    expect(() => bus.ack('missing', 'fleet')).toThrow('not found');
    expect(readdirSync(home)).toEqual([]);
  });

  it('reserves count capacity for acknowledgments, preserving read and replay at capacity', () => {
    const limited = createBusMailbox(home, () => time, { maxMessages: 2 });
    limited.send(envelope({ id: 'one' }));
    limited.send(envelope({ id: 'two' }));
    expect(() => limited.send(envelope({ id: 'three' }))).toThrow('capacity');
    expect(limited.send(envelope({ id: 'one' })).replayed).toBe(true);
    expect(limited.inbox('fleet').messages).toHaveLength(2);
    limited.ack('one', 'fleet'); limited.ack('two', 'fleet');
    expect(limited.inbox('fleet').messages).toEqual([]);
    expect(readdirSync(join(home, 'bus-mailbox', 'records'))).toHaveLength(4);
  });

  it('reserves byte capacity for acknowledgments and rejects oversized new traffic safely', () => {
    const limited = createBusMailbox(home, () => time, { maxBytes: 2048 });
    limited.send(envelope());
    expect(() => limited.send(envelope({ id: 'large', body: 'x'.repeat(1200) }))).toThrow('capacity');
    expect(limited.inbox('fleet').messages).toEqual([envelope()]);
    expect(limited.ack('message-1', 'fleet').acknowledged).toBe(true);
    expect(limited.inbox('fleet').messages).toEqual([]);
  });

  it('recovers a linked publication at capacity before refusing new traffic', () => {
    const limited = createBusMailbox(home, () => time, { maxMessages: 1 });
    limited.send(envelope());
    const name = readdirSync(join(home, 'bus-mailbox', 'records'))[0]!;
    const record = join(home, 'bus-mailbox', 'records', name);
    const body = JSON.stringify(JSON.parse(readFileSync(record, 'utf8')));
    const stage = `.${name.slice(0, -5)}.${createHash('sha256').update(body).digest('hex')}.stage`;
    linkSync(record, join(home, 'bus-mailbox', 'staging', stage));
    expect(() => limited.inbox('fleet')).toThrow('storage');
    expect(() => limited.send(envelope({ id: 'new' }))).toThrow('capacity');
    expect(readdirSync(join(home, 'bus-mailbox', 'staging'))).toEqual([]);
    expect(limited.inbox('fleet').messages).toEqual([envelope()]);
    expect(limited.ack('message-1', 'fleet').acknowledged).toBe(true);
  });

  it('writes private directories and files', () => {
    bus.send(envelope()); bus.ack('message-1', 'fleet');
    if (process.platform !== 'win32') {
      for (const dir of ['bus-mailbox', 'bus-mailbox/records', 'bus-mailbox/staging']) expect(lstatSync(join(home, dir)).mode & 0o777).toBe(0o700);
      for (const name of readdirSync(join(home, 'bus-mailbox', 'records'))) expect(lstatSync(join(home, 'bus-mailbox', 'records', name)).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses corruption rather than returning a partial empty inbox or acknowledging', async () => {
    bus.send(envelope());
    const record = join(home, 'bus-mailbox', 'records', readdirSync(join(home, 'bus-mailbox', 'records'))[0]!);
    writeFileSync(record, '{malformed');
    const result = await json(['inbox', '--to', 'fleet']);
    expect(result.code).toBe(1);
    expect(result.value.error.code).toBe('storage');
    expect(() => bus.ack('message-1', 'fleet')).toThrow('storage');
    expect(readFileSync(record, 'utf8')).toBe('{malformed');
  });

  it('refuses symlinked store roots and preserves their target', () => {
    const target = join(home, 'target');
    // Directory symlinks require extra privilege on Windows; a file-shaped
    // store is still an unsafe path there and must fail the same way.
    if (process.platform === 'win32') writeFileSync(join(home, 'bus-mailbox'), 'FAKE sentinel');
    else { writeFileSync(target, 'FAKE sentinel'); symlinkSync(target, join(home, 'bus-mailbox')); }
    expect(() => bus.send(envelope())).toThrow('storage');
    expect(() => bus.inbox('fleet')).toThrow('storage');
    expect(readFileSync(process.platform === 'win32' ? join(home, 'bus-mailbox') : target, 'utf8')).toBe('FAKE sentinel');
  });

  it('refuses unsafe record permissions or symlinks', () => {
    bus.send(envelope());
    const record = join(home, 'bus-mailbox', 'records', readdirSync(join(home, 'bus-mailbox', 'records'))[0]!);
    if (process.platform === 'win32') writeFileSync(record, 'FAKE invalid');
    else chmodSync(record, 0o644);
    expect(() => bus.inbox('fleet')).toThrow('storage');
  });

  it('refuses dangling storage symlinks rather than reporting an empty inbox', () => {
    if (process.platform === 'win32') writeFileSync(join(home, 'bus-mailbox'), 'FAKE unsafe path');
    else symlinkSync(join(home, 'missing'), join(home, 'bus-mailbox'));
    expect(() => bus.inbox('fleet')).toThrow('storage');
  });

  it('rejects non-JSON objects without invoking their hooks or writing', () => {
    const hook = vi.fn(() => 'FAKE');
    const checked = validateBusEnvelope(envelope({ body: { toJSON: hook } as never }));
    expect(checked.ok).toBe(false);
    expect(() => bus.send(envelope({ body: { toJSON: hook } as never }))).toThrow('envelope');
    expect(hook).not.toHaveBeenCalled();
    expect(readdirSync(home)).toEqual([]);
  });
});

describe('real phm bus dispatch', () => {
  it('completes send -> inbox -> ack across fresh CLI processes with JSON-only output', () => {
    const run = (args: string[]) => {
      const result = child([...args, '--json']);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      return JSON.parse(result.stdout);
    };
    expect(run([...sendArgs, '--id', 'process-message']).ok).toBe(true);
    expect(run(['inbox', '--to', 'fleet']).messages[0].id).toBe('process-message');
    expect(run(['ack', 'process-message', '--to', 'fleet']).acknowledged).toBe(true);
    expect(run(['inbox', '--to', 'fleet']).messages).toEqual([]);
    const invalid = child(['send', '--typo', '--json']);
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toBe('');
    expect(JSON.parse(invalid.stdout).error.code).toBe('usage');
  });

  it('help and empty inbox leave a fresh HOME unchanged', () => {
    const help = child(['send', '--help', '--json']);
    expect(help.status).toBe(0);
    expect(JSON.parse(help.stdout).usage).toContain('send');
    const inbox = child(['inbox', '--to', 'fleet', '--json']);
    expect(inbox.status).toBe(0);
    expect(JSON.parse(inbox.stdout).messages).toEqual([]);
    expect(existsSync(join(home, '.ashlr', 'bus-mailbox'))).toBe(false);
  });

  it('deduplicates simultaneous same-ID sends without lost writes', async () => {
    // Race first-use initialization too; children share only this fake home.
    const results = await Promise.all(Array.from({ length: 3 }, () => new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      const processChild = spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'bus', ...sendArgs, '--id', 'concurrent', '--json'], {
        cwd: repo, timeout: 20_000,
        env: { ...process.env, HOME: home, USERPROFILE: home, ASHLR_HOME: join(home, '.ashlr'), NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = ''; let err = '';
      processChild.stdout.on('data', data => { out += String(data); });
      processChild.stderr.on('data', data => { err += String(data); });
      processChild.on('error', reject);
      processChild.on('close', code => resolve({ code, out, err }));
    })));
    expect(results.map(r => r.code)).toEqual([0, 0, 0]);
    expect(results.every(r => !r.err)).toBe(true);
    expect(results.map(r => JSON.parse(r.out).replayed).filter(r => !r)).toHaveLength(1);
    const inbox = JSON.parse(child(['inbox', '--to', 'fleet', '--json']).stdout);
    expect(inbox.messages.filter((m: BusEnvelope) => m.id === 'concurrent')).toHaveLength(1);
  });
});
