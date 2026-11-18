import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cmdFleetSlackTrace } from '../src/cli/fleet-slack-trace.js';
import { readSlackRequestTrace } from '../src/core/agents/slack-request-trace.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';
import { recordSlackObservation, slackJournalPath } from '../src/core/agents/slack-journal.js';

const CHANNEL = 'C0FAKE4691';
const OTHER = 'G0FAKE4692';
const THREAD = '1731000000.000469';
const FIRST = '1731000010.000469';
const SECOND = '1731000020.000469';
const ABSENT = '1731000030.000469';
const REPLY = '1731000050.000469';
const OTHER_REPLY = '1731000060.000469';
const AUTHOR = 'U0FAKE0469';
const BODY = 'synthetic-private-body-469s';
const DIGEST = 'b'.repeat(64);
const CLIENT = '44444444-4444-4444-4444-444444444444';
const NOW_MS = 1731000100000;
const ROW_KEYS = ['at', 'channelId', 'threadTs', 'messageTs', 'ingress', 'outcome', 'replyTs'];

interface Fixture {
  root: string;
  deps: { runsDir: string; stateRoot: string; now: () => Date };
  journalPath: string;
  storePath: string;
  journalBytes: Buffer;
  storeBytes: Buffer;
}

/** One Leader request id per (channel, message): the same ts in another channel is another request. */
const rid = (channelId: string, messageTs: string) => fakeRequestId(`${channelId}:${THREAD}:${messageTs}`);
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'slack-disk-469s-'));
  roots.push(root);
  const deps = { runsDir: join(root, 'runs'), stateRoot: join(root, 'state'), now: () => new Date(NOW_MS) };
  for (const [channelId, messageTs, at] of [
    [CHANNEL, FIRST, 1731000010000],
    [CHANNEL, SECOND, 1731000020000],
    [OTHER, FIRST, 1731000015000],
  ] as const) {
    expect(recordSlackObservation({
      at: new Date(at).toISOString(), decision: 'ingested', channelId,
      threadTs: THREAD, messageTs, authorId: AUTHOR, bus: 'posted', requestId: rid(channelId, messageTs),
    }, { runsDir: deps.runsDir })).toBe('recorded');
  }
  mkdirSync(deps.stateRoot, { recursive: true, mode: 0o700 });
  const storePath = join(deps.stateRoot, 'messages.json');
  const receipt = (channel: string, ts: string) => ({
    digest: DIGEST, clientId: CLIENT, expiresAt: 9e12, channel, thread: THREAD,
    state: 'sent', ts, text: BODY,
  });
  writeFileSync(storePath, JSON.stringify({ version: 1, messages: {
    [replyKey(rid(CHANNEL, FIRST))]: receipt(CHANNEL, REPLY),
    [replyKey(rid(OTHER, FIRST))]: receipt(OTHER, OTHER_REPLY),
  } }), { mode: 0o600 });
  const journalPath = slackJournalPath(deps.runsDir);
  return { root, deps, journalPath, storePath,
    journalBytes: readFileSync(journalPath), storeBytes: readFileSync(storePath) };
}

function snapshot(fx: Fixture) {
  const bytes = (path: string) => (existsSync(path) ? readFileSync(path) : null);
  const names = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : null);
  return {
    journal: bytes(fx.journalPath),
    store: bytes(fx.storePath),
    journalDir: names(dirname(fx.journalPath)),
    storeDir: names(dirname(fx.storePath)),
  };
}

const select = (channel: string, message: string, json = true) =>
  ['--thread', THREAD, '--channel', channel, '--message', message, ...(json ? ['--json'] : [])];

async function run(args: string[], fx: Fixture) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  log.mockClear();
  err.mockClear();
  const before = snapshot(fx);
  const code = await cmdFleetSlackTrace(args, fx.deps);
  const lines = log.mock.calls.map((call) => String(call[0]));
  const emitted = [...log.mock.calls, ...err.mock.calls].map((call) => String(call[0])).join('\n');
  expect(err).not.toHaveBeenCalled();
  for (const secret of [AUTHOR, BODY, DIGEST, CLIENT, fx.root]) expect(emitted).not.toContain(secret);
  expect(snapshot(fx)).toEqual(before);
  return { code, lines };
}

function readerSources(fx: Fixture) {
  const before = snapshot(fx);
  const sources = readSlackRequestTrace(fx.deps).sources;
  expect(snapshot(fx)).toEqual(before);
  return sources;
}

function parsed(lines: string[]) {
  expect(lines).toHaveLength(1);
  expect(lines[0]!.length).toBeLessThan(4096);
  return JSON.parse(lines[0]!);
}

describe('fleet slack-trace disk-degraded sources (469s)', () => {
  it('answers the exact selection repeatably and reports no-match separately from damage', async () => {
    const fx = fixture();
    const first = await run(select(CHANNEL, FIRST), fx);
    expect(first.code).toBe(0);
    const trace = parsed(first.lines);
    expect(trace.sources).toEqual({ journal: 'ok', sends: 'ok' });
    expect(trace.collectionScope).toEqual({ thread: THREAD, channelId: CHANNEL, messageTs: FIRST });
    expect(trace.scope).toContain('does not prove current runtime reachability');
    expect(trace.counts).toEqual({ total: 1, answered: 1, uncertain: 0, busFailed: 0, unanswered: 0 });
    expect(trace.rows).toHaveLength(1);
    expect(trace.rows[0]).toMatchObject({ channelId: CHANNEL, threadTs: THREAD, messageTs: FIRST,
      ingress: 'posted', outcome: 'answered', replyTs: REPLY });
    for (const key of Object.keys(trace.rows[0])) expect(ROW_KEYS).toContain(key);

    const second = await run(select(CHANNEL, FIRST), fx);
    expect(second.code).toBe(0);
    expect(second.lines[0]).toBe(first.lines[0]);

    const absentRun = await run(select(CHANNEL, ABSENT), fx);
    expect(absentRun.code).toBe(1);
    const absent = parsed(absentRun.lines);
    expect(absent.sources).toEqual({ journal: 'ok', sends: 'ok' });
    expect(absent.rows).toEqual([]);
    expect(absent.counts.total).toBe(0);

    const unansweredRun = await run(select(CHANNEL, SECOND), fx);
    expect(unansweredRun.code).toBe(1);
    const unanswered = parsed(unansweredRun.lines);
    expect(unanswered.rows[0]).toMatchObject({ outcome: 'unanswered' });
    expect(unanswered.rows[0].replyTs).toBeUndefined();

    const otherRun = await run(select(OTHER, FIRST), fx);
    expect(otherRun.code).toBe(0);
    const other = parsed(otherRun.lines);
    expect(other.rows[0]).toMatchObject({ outcome: 'answered', replyTs: OTHER_REPLY });
  });

  it('surfaces journal damage as degraded or missing and never verifies a reply', async () => {
    const fx = fixture();
    writeFileSync(fx.journalPath, Buffer.concat([fx.journalBytes, Buffer.from('{"at":"')]));
    expect(readerSources(fx)).toEqual({ journal: 'degraded', sends: 'ok' });
    const tornRun = await run(select(CHANNEL, FIRST), fx);
    expect(tornRun.code).toBe(1);
    const torn = parsed(tornRun.lines);
    expect(torn.sources).toEqual({ journal: 'degraded', sends: 'ok' });
    expect(torn.rows[0]).toMatchObject({ outcome: 'answered', replyTs: REPLY });
    expect(torn.counts.answered).toBe(1);

    writeFileSync(fx.journalPath, fx.journalBytes);
    const healed = await run(select(CHANNEL, FIRST), fx);
    expect(healed.code).toBe(0);
    expect(parsed(healed.lines).sources).toEqual({ journal: 'ok', sends: 'ok' });

    writeFileSync(fx.journalPath, 'not-jsonl\n');
    expect(readerSources(fx).journal).toBe('degraded');
    const emptyRun = await run(select(CHANNEL, FIRST), fx);
    expect(emptyRun.code).toBe(1);
    const empty = parsed(emptyRun.lines);
    expect(empty.sources.journal).toBe('degraded');
    expect(empty.rows).toEqual([]);
    expect(empty.counts.total).toBe(0);

    writeFileSync(fx.journalPath, fx.journalBytes);
    expect((await run(select(CHANNEL, FIRST), fx)).code).toBe(0);

    rmSync(fx.journalPath);
    expect(readerSources(fx)).toEqual({ journal: 'missing', sends: 'ok' });
    const missingRun = await run(select(CHANNEL, FIRST), fx);
    expect(missingRun.code).toBe(1);
    const missing = parsed(missingRun.lines);
    expect(missing.sources).toEqual({ journal: 'missing', sends: 'ok' });
    expect(missing.rows).toEqual([]);

    writeFileSync(fx.journalPath, fx.journalBytes);
    const recovered = await run(select(CHANNEL, FIRST), fx);
    expect(recovered.code).toBe(0);
    expect(parsed(recovered.lines).rows[0]).toMatchObject({ outcome: 'answered', replyTs: REPLY });
  });

  it('surfaces send-store damage and a foreign-channel reply cannot rescue the request', async () => {
    const fx = fixture();
    writeFileSync(fx.storePath, '{corrupt-json');
    expect(readerSources(fx)).toEqual({ journal: 'ok', sends: 'degraded' });
    const degradedRun = await run(select(CHANNEL, FIRST), fx);
    expect(degradedRun.code).toBe(1);
    const degraded = parsed(degradedRun.lines);
    expect(degraded.sources).toEqual({ journal: 'ok', sends: 'degraded' });
    expect(degraded.rows[0]).toMatchObject({ outcome: 'unanswered' });
    expect(degraded.rows[0].replyTs).toBeUndefined();
    expect(degraded.counts).toMatchObject({ answered: 0, unanswered: 1 });

    writeFileSync(fx.storePath, JSON.stringify({ version: 1, messages: {
      [replyKey(rid(CHANNEL, FIRST))]: { digest: DIGEST, clientId: CLIENT, expiresAt: 9e12,
        channel: 'X-not-a-channel', thread: THREAD, state: 'sent', ts: REPLY, text: BODY },
      [replyKey(rid(OTHER, FIRST))]: { digest: DIGEST, clientId: CLIENT, expiresAt: 9e12,
        channel: OTHER, thread: THREAD, state: 'sent', ts: OTHER_REPLY, text: BODY },
    } }), { mode: 0o600 });
    expect(readerSources(fx)).toEqual({ journal: 'ok', sends: 'degraded' });
    const foreignRun = await run(select(CHANNEL, FIRST), fx);
    expect(foreignRun.code).toBe(1);
    const foreign = parsed(foreignRun.lines);
    expect(foreign.sources.sends).toBe('degraded');
    expect(foreign.rows[0]).toMatchObject({ channelId: CHANNEL, messageTs: FIRST, outcome: 'unanswered' });
    expect(foreign.rows[0].replyTs).toBeUndefined();

    const ownRun = await run(select(OTHER, FIRST), fx);
    expect(ownRun.code).toBe(1);
    expect(parsed(ownRun.lines).rows[0]).toMatchObject({ outcome: 'answered', replyTs: OTHER_REPLY });

    writeFileSync(fx.storePath, fx.storeBytes);
    expect((await run(select(CHANNEL, FIRST), fx)).code).toBe(0);

    rmSync(fx.storePath);
    expect(readerSources(fx)).toEqual({ journal: 'ok', sends: 'missing' });
    const missingRun = await run(select(CHANNEL, FIRST), fx);
    expect(missingRun.code).toBe(1);
    const missing = parsed(missingRun.lines);
    expect(missing.sources).toEqual({ journal: 'ok', sends: 'missing' });
    expect(missing.rows[0].outcome).toBe('unanswered');

    writeFileSync(fx.storePath, fx.storeBytes);
    const recovered = await run(select(CHANNEL, FIRST), fx);
    expect(recovered.code).toBe(0);
    expect(parsed(recovered.lines).rows[0]).toMatchObject({ outcome: 'answered', replyTs: REPLY });
  });

  it('refuses verification when both sources are damaged and recovers after repair', async () => {
    const fx = fixture();
    writeFileSync(fx.journalPath, Buffer.concat([fx.journalBytes, Buffer.from('{"at":"')]));
    writeFileSync(fx.storePath, '{corrupt');
    expect(readerSources(fx)).toEqual({ journal: 'degraded', sends: 'degraded' });
    const bothRun = await run(select(CHANNEL, FIRST), fx);
    expect(bothRun.code).toBe(1);
    const both = parsed(bothRun.lines);
    expect(both.sources).toEqual({ journal: 'degraded', sends: 'degraded' });
    expect(both.rows[0].outcome).toBe('unanswered');

    writeFileSync(fx.journalPath, fx.journalBytes);
    writeFileSync(fx.storePath, fx.storeBytes);
    const recovered = await run(select(CHANNEL, FIRST), fx);
    expect(recovered.code).toBe(0);
    expect(parsed(recovered.lines).rows[0]).toMatchObject({ outcome: 'answered', replyTs: REPLY });
  });

  it('prints degraded source states in human output while the row still shows its evidence', async () => {
    const fx = fixture();
    writeFileSync(fx.journalPath, Buffer.concat([fx.journalBytes, Buffer.from('{"at":"')]));
    const degraded = await run(select(CHANNEL, FIRST, false), fx);
    expect(degraded.code).toBe(1);
    expect(degraded.lines[0]).toContain('journal=degraded');
    expect(degraded.lines[0]).toContain('sends=ok');
    expect(degraded.lines[0]).toContain(`channel=${CHANNEL}`);
    expect(degraded.lines[0]).toContain(`message=${FIRST}`);
    expect(degraded.lines.some((line) => line.includes('ANSWERED') && line.includes(`reply=${REPLY}`))).toBe(true);
  });
});
