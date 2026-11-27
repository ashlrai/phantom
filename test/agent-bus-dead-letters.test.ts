import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { registerAgentIdentity } from '../src/core/agents/bus-identity.js';
import { readBusDeadLetters } from '../src/core/agents/bus-dead-letters.js';
import { runAgentsBusUnified } from '../src/cli/agents-bus-unified.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(at = 1_000) {
  const base = mkdtempSync(join(tmpdir(), 'bus-dead-letters-'));
  dirs.push(base);
  const clock = { now: at };
  return { root: join(base, 'fleet'), now: () => clock.now, clock };
}

function register(root: string, ...handles: string[]): void {
  for (const handle of handles) {
    expect(registerAgentIdentity({ handle }, { root }).status).toBe('created');
  }
}

/** The sink's wire body (bus-transport-file `createFileDeadLetterSink`): a
 * protocol status whose payload carries the deadLetter summary, the
 * payloadDropped flag and the kept original transport envelope or null. */
const deadLetterBody = (over: { id?: string; from?: string; to?: string; kind?: string;
    reason?: string; priority?: string; attempts?: number; payloadDropped?: boolean;
    withPayload?: boolean; bare?: boolean; bogusReason?: boolean } = {}) => ({
  protocol: { version: 1, kind: 'status' },
  correlation_id: 'corr-dead-1',
  payload: {
    ...(over.bare === true ? {} : {
      deadLetter: {
        id: over.id ?? 'orig-env-1', from: over.from ?? 'agent:nova', to: over.to ?? 'agent:atlas',
        kind: over.kind ?? 'task', priority: over.priority ?? 'P1', correlationId: 'corr-dead-1',
        reason: over.bogusReason === true ? 'mystery' : over.reason ?? 'exhausted', deadLetteredAt: 1_000,
        attempts: Array.from({ length: over.attempts ?? 2 }, (_, i) => ({
          attempt: i + 1, transport: 'fake-transport', outcome: 'retryable', at: 900 - i,
        })),
      },
    }),
    payloadDropped: over.payloadDropped ?? false,
    envelope: over.withPayload === false || over.bare === true ? null : {
      id: over.id ?? 'orig-env-1', from: over.from ?? 'agent:nova', to: over.to ?? 'agent:atlas',
      kind: over.kind ?? 'task', priority: over.priority ?? 'P1',
      body: { kind: 'work', text: 'fake lost work' },
      correlationId: 'corr-dead-1', ttlMs: 3_600_000,
    },
  },
});

const postLetter = (options: ReturnType<typeof setup>, id: string, body: unknown,
  extra: Partial<BusEnvelope> = {}) => {
  const posted = appendBusInbox({ id, from: 'bus-router', to: 'bus.dead-letter',
    priority: 'P1', ttl: 120_000, body: body as BusEnvelope['body'], ...extra },
    { root: options.root, now: options.now });
  expect(posted.status).toBe('posted');
};

const ok = (result: ReturnType<typeof readBusDeadLetters>) => {
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error('unreachable');
  return result;
};

describe('readBusDeadLetters', () => {
  it('lists every live dead letter fleet-wide with its parsed report', () => {
    const options = setup();
    register(options.root, 'atlas', 'nova', 'ghost');
    postLetter(options, 'dl-p0', deadLetterBody({ to: 'agent:atlas', reason: 'no-route', attempts: 0 }), { priority: 'P0' });
    postLetter(options, 'dl-alias', deadLetterBody({ id: 'orig-2', to: 'agent:ghost', kind: 'review' }));
    postLetter(options, 'dl-bare', deadLetterBody({ bare: true }));
    postLetter(options, 'dl-bogus', deadLetterBody({ id: 'orig-4', reason: undefined, bogusReason: true }));
    // Ordinary mail is never a dead letter.
    appendBusInbox({ id: 'plain', from: 'agent:nova', to: 'agent:atlas', priority: 'P1', ttl: 60_000,
      body: { kind: 'note', text: 'hi' } }, { root: options.root, now: options.now });

    const result = ok(readBusDeadLetters({ root: options.root, now: options.now }));
    expect(result.source).toBe('available');
    expect(result.matched).toBe(4);
    expect(result.truncated).toBe(false);
    // Claim order: the P0 letter first, then cursor order.
    expect(result.letters.map(item => item.id)).toEqual(['dl-p0', 'dl-alias', 'dl-bare', 'dl-bogus']);
    expect(result.letters[0]).toMatchObject({
      originalId: 'orig-env-1', to: 'agent:atlas', from: 'agent:nova', fromAgent: 'nova',
      kind: 'task', reason: 'no-route', reasonKind: 'no-route', attempts: 0,
      payloadDropped: false, priority: 'P0' });
    expect(result.letters[0]!.summary).toContain('dead letter no-route');
    expect(result.letters[0]!.summary).toContain('agent:nova → agent:atlas');
    expect(result.letters[1]).toMatchObject({ id: 'dl-alias', originalId: 'orig-2',
      to: 'agent:ghost', kind: 'review', attempts: 2, reasonKind: 'exhausted' });
    // A body the defensive read cannot parse still lists — facts stay null,
    // the classified reason is 'other', never a guessed value.
    expect(result.letters[2]).toMatchObject({ id: 'dl-bare', originalId: null, to: null, from: null,
      fromAgent: null, kind: null, reason: null, reasonKind: 'other', attempts: null,
      payloadDropped: false });
    expect(result.letters[2]!.summary).toBe('dead letter');
    // A recorded reason outside the closed set classifies as 'other' but
    // keeps its verbatim string.
    expect(result.letters[3]).toMatchObject({ id: 'dl-bogus', reason: 'mystery', reasonKind: 'other' });
    for (const item of result.letters) {
      expect(Date.parse(item.expiresAt)).toBeGreaterThan(Date.parse(item.ts));
    }
  });

  it('filters by reason, sender, recipient, channel, kind, id, contains and time', () => {
    const options = setup();
    register(options.root, 'atlas', 'nova', 'ghost');
    postLetter(options, 'dl-a', deadLetterBody({ id: 'orig-a', from: 'agent:nova', to: 'agent:atlas', reason: 'exhausted' }));
    postLetter(options, 'dl-b', deadLetterBody({ id: 'orig-b', from: 'agent:ghost', to: 'group:eng:alerts', reason: 'expired', kind: 'note' }));
    postLetter(options, 'dl-c', deadLetterBody({ id: 'orig-c', from: 'agent:nova', to: 'agent:ghost', reason: 'no-route', payloadDropped: true, withPayload: false }));

    const base = { root: options.root, now: options.now };
    expect(ok(readBusDeadLetters({ ...base, reason: 'expired' })).letters.map(i => i.id)).toEqual(['dl-b']);
    expect(ok(readBusDeadLetters({ ...base, reason: 'other' })).matched).toBe(0);
    // --from resolves the original sender through the registry: agent:nova's
    // letters are dl-a and dl-c; ghost's is dl-b.
    expect(ok(readBusDeadLetters({ ...base, from: 'nova' })).letters.map(i => i.id)).toEqual(['dl-a', 'dl-c']);
    expect(ok(readBusDeadLetters({ ...base, from: 'agent:ghost' })).letters.map(i => i.id)).toEqual(['dl-b']);
    expect(ok(readBusDeadLetters({ ...base, excludeFrom: 'nova' })).letters.map(i => i.id)).toEqual(['dl-b']);
    // --to resolves the original recipient the same way.
    expect(ok(readBusDeadLetters({ ...base, to: 'atlas' })).letters.map(i => i.id)).toEqual(['dl-a']);
    // --channel keeps reports whose original recipient is a room address.
    expect(ok(readBusDeadLetters({ ...base, channel: 'eng' })).letters.map(i => i.id)).toEqual(['dl-b']);
    // --body-kind keeps the original envelope kind.
    expect(ok(readBusDeadLetters({ ...base, bodyKind: 'note' })).letters.map(i => i.id)).toEqual(['dl-b']);
    // --id matches the letter's own wire id or the original's.
    expect(ok(readBusDeadLetters({ ...base, id: 'dl-c' })).letters.map(i => i.id)).toEqual(['dl-c']);
    expect(ok(readBusDeadLetters({ ...base, id: 'orig-b' })).letters.map(i => i.id)).toEqual(['dl-b']);
    // --contains matches the report facts, never the routing labels or ids.
    expect(ok(readBusDeadLetters({ ...base, contains: 'payload dropped' })).letters.map(i => i.id)).toEqual(['dl-c']);
    expect(ok(readBusDeadLetters({ ...base, contains: 'orig-a' })).matched).toBe(0);
    expect(ok(readBusDeadLetters({ ...base, contains: 'no-route' })).letters.map(i => i.id)).toEqual(['dl-c']);
    // --since/--before bound the letter's receipt time.
    options.clock.now += 60_000;
    postLetter(options, 'dl-d', deadLetterBody({ id: 'orig-d' }));
    const cutoff = options.clock.now;
    expect(ok(readBusDeadLetters({ ...base, since: cutoff })).letters.map(i => i.id)).toEqual(['dl-d']);
    expect(ok(readBusDeadLetters({ ...base, before: cutoff })).letters.map(i => i.id)).toEqual(['dl-a', 'dl-b', 'dl-c']);
    // --priority keeps the letter's own band.
    expect(ok(readBusDeadLetters({ ...base, priority: 'P0' })).matched).toBe(0);
  });

  it('caps the page at --limit while matched reports the filtered total', () => {
    const options = setup();
    register(options.root, 'atlas');
    for (let i = 0; i < 5; i += 1) {
      postLetter(options, `dl-${i}`, deadLetterBody({ id: `orig-${i}` }));
    }
    const result = ok(readBusDeadLetters({ root: options.root, now: options.now, limit: 2 }));
    expect(result.matched).toBe(5);
    expect(result.letters).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(ok(readBusDeadLetters({ root: options.root, now: options.now })).truncated).toBe(false);
  });

  it('skips expired letters and reports a verified-missing store honestly', () => {
    const options = setup();
    postLetter(options, 'dl-live', deadLetterBody({}), { ttl: 1_000 });
    options.clock.now += 2_000;
    const result = ok(readBusDeadLetters({ root: options.root, now: options.now }));
    expect(result.source).toBe('available');
    expect(result.matched).toBe(0);
    expect(result.letters).toEqual([]);

    const empty = setup();
    const missing = ok(readBusDeadLetters({ root: empty.root, now: empty.now }));
    expect(missing).toMatchObject({ source: 'missing', matched: 0, truncated: false, letters: [] });
  });

  it('reports unavailable on an unreadable store and invalid on bad filters', () => {
    const options = setup();
    postLetter(options, 'dl-1', deadLetterBody({}));
    writeFileSync(join(options.root, 'bus-inbox', 'messages.json'), '{invalid', { mode: 0o600 });
    expect(readBusDeadLetters({ root: options.root, now: options.now }))
      .toMatchObject({ status: 'unavailable' });

    const fresh = setup();
    expect(readBusDeadLetters({ root: fresh.root, now: fresh.now, contains: '   ' }))
      .toMatchObject({ status: 'invalid' });
    expect(readBusDeadLetters({ root: fresh.root, now: fresh.now, limit: 0 }))
      .toMatchObject({ status: 'invalid' });
    expect(readBusDeadLetters({ root: fresh.root, now: fresh.now, reason: 'bogus' as never }))
      .toMatchObject({ status: 'invalid' });
    expect(readBusDeadLetters({ root: fresh.root, now: fresh.now, since: -1 }))
      .toMatchObject({ status: 'invalid' });
  });
});

describe('agents bus dead-letters (cli)', () => {
  async function run(args: string[], root: string, env: NodeJS.ProcessEnv = {}) {
    const out: string[] = [], err: string[] = [];
    const code = await runAgentsBusUnified([...args, '--root', root, '--json'], t => out.push(t), t => err.push(t), env);
    return { code, out: out.join('\n'), err: err.join('\n'),
      json: out.length ? JSON.parse(out) : err.length ? JSON.parse(err) : null };
  }

  it('lists dead letters as JSON and as human lines', async () => {
    const options = setup(Date.now());
    register(options.root, 'atlas', 'nova');
    postLetter(options, 'dl-1', deadLetterBody({ to: 'agent:atlas', reason: 'no-route' }));

    const json = await run(['dead-letters'], options.root);
    expect(json.code).toBe(0);
    expect(json.json).toMatchObject({ status: 'ok', source: 'available', matched: 1, truncated: false });
    expect(json.json.letters[0]).toMatchObject({ id: 'dl-1', reasonKind: 'no-route', to: 'agent:atlas' });

    const filtered = await run(['dead-letters', '--reason', 'expired'], options.root);
    expect(filtered.json).toMatchObject({ matched: 0, letters: [] });
  });

  it('prints human lines, a missing-store note and usage errors', async () => {
    const options = setup(Date.now());
    register(options.root, 'atlas');
    postLetter(options, 'dl-1', deadLetterBody({ to: 'agent:atlas', reason: 'no-route' }));
    const out: string[] = [];
    const code = await runAgentsBusUnified(['dead-letters', '--root', options.root], t => out.push(t), () => {});
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('dl-1');
    expect(text).toContain('dead letter no-route');
    expect(text).toContain('matched=1 shown=1');

    const empty = setup();
    const emptyOut: string[] = [];
    const emptyCode = await runAgentsBusUnified(['dead-letters', '--root', empty.root],
      t => emptyOut.push(t), () => {});
    expect(emptyCode).toBe(0);
    expect(emptyOut.join('\n')).toContain('dead-letter store missing');
    expect(emptyOut.join('\n')).toContain('matched=0 shown=0');

    const bad = await run(['dead-letters', '--reason', 'bogus'], options.root);
    expect(bad.code).toBe(2);

    const extra = await run(['dead-letters', 'surplus'], options.root);
    expect(extra.code).toBe(2);
  });
});
