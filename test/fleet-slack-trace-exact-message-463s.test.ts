import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetSlackTrace } from '../src/cli/fleet-slack-trace.js';
import { recordSlackObservation, slackJournalPath } from '../src/core/agents/slack-journal.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';

const CHANNEL = 'C0FAKE0001';
const OTHER = 'G0FAKE0002';
const THREAD = '1731000000.000100';
const FIRST = '1731000010.000100';
const SECOND = '1731000020.000100';
const ABSENT = '1731000030.000100';
const REPLY = '1731000050.000100';
const AUTHOR = 'U0FAKE0001';
const BODY = 'synthetic-private-body-463s';
const DIGEST = 'a'.repeat(64);
const CLIENT = '11111111-1111-1111-1111-111111111111';
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** One Leader request id per (channel, message): the same ts in another channel is another request. */
const rid = (channelId: string, messageTs: string) => fakeRequestId(`${channelId}:${THREAD}:${messageTs}`);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'slack-exact-463s-'));
  roots.push(root);
  const deps = { runsDir: join(root, 'runs'), stateRoot: join(root, 'state'), now: () => new Date(1731000100000) };
  for (const [channelId, messageTs, at] of [
    [CHANNEL, FIRST, new Date(1731000010000).toISOString()],
    [CHANNEL, SECOND, new Date(1731000020000).toISOString()],
    [OTHER, FIRST, new Date(1731000010000).toISOString()],
  ]) {
    expect(recordSlackObservation({ at, decision: 'ingested', channelId, threadTs: THREAD, messageTs, authorId: AUTHOR, bus: 'posted', requestId: rid(channelId, messageTs) }, deps)).toBe('recorded');
  }
  mkdirSync(deps.stateRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(deps.stateRoot, 'messages.json'), JSON.stringify({ version: 1, messages: {
    [replyKey(rid(CHANNEL, FIRST))]: { digest: DIGEST, clientId: CLIENT, expiresAt: 9e12, channel: CHANNEL, thread: THREAD, state: 'sent', ts: REPLY, text: BODY },
  } }), { mode: 0o600 });
  return deps;
}

async function run(args: string[], deps: ReturnType<typeof fixture>) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  log.mockClear();
  const journal = readFileSync(slackJournalPath(deps.runsDir));
  const store = readFileSync(join(deps.stateRoot, 'messages.json'));
  const code = await cmdFleetSlackTrace(args, deps);
  const lines = log.mock.calls.map((call) => String(call[0]));
  expect(readFileSync(slackJournalPath(deps.runsDir))).toEqual(journal);
  expect(readFileSync(join(deps.stateRoot, 'messages.json'))).toEqual(store);
  for (const secret of [AUTHOR, BODY, DIGEST, CLIENT, deps.runsDir, deps.stateRoot]) expect(lines.join('\n')).not.toContain(secret);
  return { code, lines };
}

const select = (channel: string, message: string) => ['--thread', THREAD, '--channel', channel, '--message', message];

describe('fleet slack-trace exact message (463s)', () => {
  it.each([
    [CHANNEL, FIRST, 0, 'answered'],
    [CHANNEL, SECOND, 1, 'unanswered'],
    [OTHER, FIRST, 1, 'unanswered'],
    [CHANNEL, ABSENT, 1, undefined],
  ] as const)('selects channel %s and message %s after allocation', async (channel, message, status, outcome) => {
    const deps = fixture();
    const { code, lines } = await run([...select(channel, message), '--json'], deps);
    const trace = JSON.parse(lines[0]!);
    expect(code).toBe(status);
    expect(trace.collectionScope).toEqual({ thread: THREAD, channelId: channel, messageTs: message });
    expect(trace.sources).toEqual({ journal: 'ok', sends: 'ok' });
    expect(trace.scope).toContain('Bounded local persisted journal and send evidence only');
    expect(trace.scope).toContain('does not prove current runtime reachability');
    expect(trace.counts).toEqual({ total: outcome ? 1 : 0, answered: outcome === 'answered' ? 1 : 0,
      uncertain: 0, busFailed: 0, unanswered: outcome === 'unanswered' ? 1 : 0 });
    expect(trace.rows).toHaveLength(outcome ? 1 : 0);
    if (outcome) expect(trace.rows[0]).toMatchObject({ channelId: channel, messageTs: message, outcome });
  });

  it('shows the exact selection in human scope and preserves unselected behavior', async () => {
    const deps = fixture();
    const selected = await run(select(CHANNEL, SECOND), deps);
    expect(selected.code).toBe(1);
    expect(selected.lines[0]).toContain(`channel=${CHANNEL} thread=${THREAD} message=${SECOND}`);
    expect(selected.lines[1]).toContain('UNANSWERED');
    const all = await run(['--thread', THREAD, '--channel', CHANNEL, '--json'], deps);
    expect(all.code).toBe(1);
    expect(JSON.parse(all.lines[0]!).counts).toMatchObject({ total: 2, answered: 1, unanswered: 1 });
  });

  it('retains source failure for an answered exact selection', async () => {
    const deps = fixture();
    writeFileSync(slackJournalPath(deps.runsDir), `${readFileSync(slackJournalPath(deps.runsDir), 'utf8')}invalid\n`);
    const result = await run([...select(CHANNEL, FIRST), '--json'], deps);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.lines[0]!).sources.journal).toBe('degraded');
  });

  it.each([
    ['--message'], ['--message', 'bad'], ['--message', FIRST],
    ['--thread', THREAD, '--message', FIRST], ['--channel', CHANNEL, '--message', FIRST],
    ['--thread', THREAD, '--channel', CHANNEL, '--message'],
    [...select(CHANNEL, FIRST), '--message', SECOND],
    [...select(CHANNEL, FIRST), '--thread', THREAD],
    [...select(CHANNEL, FIRST), '--channel', CHANNEL],
    ['--thread', 'bad', '--channel', CHANNEL, '--message', FIRST],
    ['--thread', THREAD, '--channel', 'bad', '--message', FIRST],
  ])('rejects malformed selectors before reading evidence: %j', async (...args) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = {
      get runsDir(): string { throw new Error('unexpected journal access'); },
      get stateRoot(): string { throw new Error('unexpected send access'); },
      now: () => { throw new Error('unexpected collection'); },
      thread: THREAD,
    };
    expect(await cmdFleetSlackTrace(args, deps)).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--message <ts>'));
  });
});
