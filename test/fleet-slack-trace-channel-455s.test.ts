import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetSlackTrace } from '../src/cli/fleet-slack-trace.js';
import { recordSlackObservation, slackJournalPath } from '../src/core/agents/slack-journal.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';

// Plainly synthetic channels, identities and persisted receipts; no Slack access.
const ANSWERED = 'C0FAKE0001';
const UNANSWERED = 'G0FAKE0002';
const ABSENT = 'C0FAKE0003';
const THREAD = '1731000000.000100';
const OTHER_THREAD = '1731000001.000100';
const MESSAGE = '1731000010.000100';
const REPLY = '1731000050.000100';
const AT = new Date(1731000010000).toISOString();
const NOW = new Date(1731000100000);
const AUTHOR = 'U0FAKE0001';
const TEXT = 'synthetic-private-message-455s';
const DIGEST = 'a'.repeat(64);
const CLIENT = '11111111-1111-1111-1111-111111111111';
/** Each request has its own Leader request id even when channels share thread and message timestamps. */
const rid = (channelId: string, threadTs: string) => fakeRequestId(`${channelId}:${threadTs}:${MESSAGE}`);
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'slack-channel-455s-'));
  roots.push(root);
  const deps = { runsDir: join(root, 'runs'), stateRoot: join(root, 'state'), now: () => NOW };
  for (const channelId of [ANSWERED, UNANSWERED]) {
    expect(recordSlackObservation({
      at: AT, decision: 'ingested', channelId, threadTs: THREAD, messageTs: MESSAGE,
      authorId: AUTHOR, bus: 'posted', requestId: rid(channelId, THREAD),
    }, deps)).toBe('recorded');
  }
  mkdirSync(deps.stateRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(deps.stateRoot, 'messages.json'), JSON.stringify({
    version: 1, messages: { [replyKey(rid(ANSWERED, THREAD))]: {
      digest: DIGEST, clientId: CLIENT, expiresAt: 9e12,
      channel: ANSWERED, thread: THREAD, state: 'sent', ts: REPLY, text: TEXT,
    } },
  }), { mode: 0o600 });
  return deps;
}

async function run(args: string[], deps: ReturnType<typeof fixture>) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  log.mockClear();
  const code = await cmdFleetSlackTrace(args, deps);
  const lines = log.mock.calls.map((call) => String(call[0]));
  for (const privateValue of [AUTHOR, TEXT, DIGEST, CLIENT, deps.runsDir, deps.stateRoot]) {
    expect(lines.join('\n')).not.toContain(privateValue);
  }
  return { code, lines };
}

describe('fleet slack-trace channel scope (455s)', () => {
  it.each([
    [ANSWERED, 0, 'answered', 1, 0],
    [UNANSWERED, 1, 'unanswered', 0, 1],
    [ABSENT, 1, undefined, 0, 0],
  ] as const)('scopes identical thread and message timestamps to %s', async (channel, status, outcome, answered, unanswered) => {
    const deps = fixture();
    const { code, lines } = await run(['--thread', THREAD, '--channel', channel, '--json'], deps);
    const trace = JSON.parse(lines[0]!);
    expect(code).toBe(status);
    expect(trace.collectionScope).toEqual({ thread: THREAD, channelId: channel });
    expect(trace.scope).toContain('Bounded local persisted journal and send evidence only');
    expect(trace.scope).toContain('does not prove current runtime reachability');
    expect(trace.sources).toEqual({ journal: 'ok', sends: 'ok' });
    expect(trace.counts).toEqual({ total: answered + unanswered, answered, unanswered, uncertain: 0, busFailed: 0 });
    expect(trace.rows).toHaveLength(answered + unanswered);
    if (outcome !== undefined) {
      expect(trace.rows[0]).toMatchObject({ channelId: channel, threadTs: THREAD, messageTs: MESSAGE, outcome });
    }
  });

  it('allows channel-only selection across threads and intersects both selectors', async () => {
    const deps = fixture();
    expect(recordSlackObservation({
      at: AT, decision: 'ingested', channelId: ANSWERED, threadTs: OTHER_THREAD, messageTs: MESSAGE,
      requestId: rid(ANSWERED, OTHER_THREAD),
    }, deps)).toBe('recorded');
    const channelOnly = await run(['--json', '--channel', ANSWERED], deps);
    const trace = JSON.parse(channelOnly.lines[0]!);
    expect(channelOnly.code).toBe(1);
    expect(trace.collectionScope).toEqual({ channelId: ANSWERED });
    expect(trace.rows.map((row: { threadTs: string }) => row.threadTs).sort()).toEqual([THREAD, OTHER_THREAD]);
    expect(trace.counts).toMatchObject({ total: 2, answered: 1, unanswered: 1 });
    expect((await run(['--channel', ANSWERED, '--thread', THREAD], deps)).code).toBe(0);
  });

  it('preserves thread-only and unfiltered rows, with explicit local collection scope', async () => {
    const deps = fixture();
    for (const args of [[], ['--thread', THREAD]]) {
      const { code, lines } = await run([...args, '--json'], deps);
      const trace = JSON.parse(lines[0]!);
      expect(code).toBe(1);
      expect(trace.rows.map((row: { channelId: string }) => row.channelId).sort()).toEqual([ANSWERED, UNANSWERED]);
      expect(trace.counts).toMatchObject({ total: 2, answered: 1, unanswered: 1 });
      expect(trace.collectionScope).toEqual(args.length ? { thread: THREAD } : {});
    }
    const { lines } = await run(['--channel', ANSWERED, '--thread', THREAD], deps);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`scope: channel=${ANSWERED} thread=${THREAD}`);
    expect(lines[0]).toContain('does not prove current runtime reachability');
    expect(lines[1]).toContain(`${ANSWERED} thread=${THREAD}`);
    expect(lines[1]).toContain('ANSWERED');
    expect(lines.join('\n')).not.toContain(UNANSWERED);
    const absent = await run(['--channel', ABSENT], deps);
    expect(absent.code).toBe(1);
    expect(absent.lines[1]).toBe('No matching request evidence; verification unsuccessful.');
  });

  it.each(['journal', 'sends'] as const)('preserves degraded %s evidence even for answered scoped rows', async (source) => {
    const deps = fixture();
    if (source === 'journal') appendFileSync(slackJournalPath(deps.runsDir), 'synthetic-corrupt-row\n');
    else {
      // A valid receipt plus an invalid row keeps the source degraded.
      const path = join(deps.stateRoot, 'messages.json');
      writeFileSync(path, JSON.stringify({ version: 1, messages: {
        [replyKey(rid(ANSWERED, THREAD))]: { channel: ANSWERED, thread: THREAD, state: 'sent', ts: REPLY }, bad: {},
      } }), { mode: 0o600 });
    }
    const { code, lines } = await run(['--channel', ANSWERED, '--json'], deps);
    const trace = JSON.parse(lines[0]!);
    expect(code).toBe(1);
    expect(trace.sources[source]).toBe('degraded');
    expect(trace.rows[0].outcome).toBe('answered');
    expect(lines[0]).not.toContain('synthetic-corrupt-row');
  });

  it('keeps missing evidence unsuccessful and reports both source states', async () => {
    const deps = fixture();
    rmSync(deps.runsDir, { recursive: true });
    rmSync(deps.stateRoot, { recursive: true });
    const { code, lines } = await run(['--channel', ANSWERED, '--json'], deps);
    expect(code).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ sources: { journal: 'missing', sends: 'missing' }, rows: [], counts: { total: 0 } });
  });

  it.each([
    ['--channel'], ['--channel', 'not-a-channel'], ['--channel', '../synthetic-path'],
    ['--channel', ANSWERED, '--channel', ANSWERED], ['--channel', ANSWERED, '--channel', UNANSWERED],
    ['--thread', THREAD, '--thread', THREAD], ['--thread', THREAD, '--thread', OTHER_THREAD],
    ['--thread', 'invalid', '--channel', ANSWERED], ['--channel', ANSWERED, '--runs-dir', '/synthetic'],
  ])('rejects invalid or duplicate selectors before collecting: %j', async (...args) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const now = vi.fn(() => { throw new Error('collector must not run'); });
    // Accessing either dependency is itself a collector access, including disk reads.
    const deps = {
      get runsDir(): string { throw new Error('journal must not be accessed'); },
      get stateRoot(): string { throw new Error('send store must not be accessed'); },
      now,
    };
    expect(await cmdFleetSlackTrace(args, deps)).toBe(2);
    expect(now).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--channel <Slack channel id>'));
  });
});
