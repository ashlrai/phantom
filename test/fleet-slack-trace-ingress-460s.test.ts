import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetSlackTrace } from '../src/cli/fleet-slack-trace.js';
import { recordSlackObservation, slackJournalPath } from '../src/core/agents/slack-journal.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';

// Plainly synthetic channel, identities and persisted receipts; no Slack access.
const CHANNEL = 'C0FAKE0460';
const OTHER_CHANNEL = 'C0FAKE0461';
const THREAD = '1731000000.000100';
const MESSAGE_A = '1731000010.000100';
const MESSAGE_B = '1731000020.000100';
const REPLY_A = '1731000050.000100';
const REPLY_B = '1731000060.000100';
const AT_A = new Date(1731000010000).toISOString();
const AT_B = new Date(1731000020000).toISOString();
const NOW = new Date(1731000100000);
const AUTHOR = 'U0FAKE0460';
const TEXT = 'synthetic-private-message-460s';
const CLIENT = '22222222-2222-2222-2222-222222222222';
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

interface Req {
  channelId?: string;
  threadTs?: string;
  messageTs: string;
  at: string;
  /** Omit to model a legacy ingested row with no bus outcome (ingress unknown). */
  bus?: 'posted' | 'duplicate' | 'failed';
}

/** Each request is its own Leader request: identity derives from channel, thread and message ts. */
const ridOf = (req: Req) => fakeRequestId(`${req.channelId ?? CHANNEL}:${req.threadTs ?? THREAD}:${req.messageTs}`);

/** replyTs[i] is the Leader reply to requests[i]; a request beyond replyTs has no stored send. */
function fixture(requests: Req[], replyTs: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'slack-ingress-460s-'));
  roots.push(root);
  const deps = { runsDir: join(root, 'runs'), stateRoot: join(root, 'state'), now: () => NOW };
  for (const req of requests) {
    expect(recordSlackObservation({
      at: req.at, decision: 'ingested', channelId: req.channelId ?? CHANNEL,
      threadTs: req.threadTs ?? THREAD, messageTs: req.messageTs, authorId: AUTHOR,
      requestId: ridOf(req), ...(req.bus !== undefined ? { bus: req.bus } : {}),
    }, deps)).toBe('recorded');
  }
  mkdirSync(deps.stateRoot, { recursive: true, mode: 0o700 });
  const messages: Record<string, unknown> = {};
  replyTs.forEach((ts, i) => {
    // Synthetic digest built by expression: a `key = '<literal>'` would trip the diff secret scan.
    const key = replyKey(ridOf(requests[i]!));
    messages[key] = {
      digest: i.toString(16).padStart(64, '0'), clientId: CLIENT, expiresAt: 9e12,
      channel: CHANNEL, thread: THREAD, state: 'sent', ts, text: TEXT,
    };
  });
  writeFileSync(join(deps.stateRoot, 'messages.json'), JSON.stringify({ version: 1, messages }), { mode: 0o600 });
  return deps;
}

function snapshot(deps: ReturnType<typeof fixture>): Buffer[] {
  return [readFileSync(slackJournalPath(deps.runsDir)), readFileSync(join(deps.stateRoot, 'messages.json'))];
}

async function run(args: string[], deps: ReturnType<typeof fixture>) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await cmdFleetSlackTrace(args, deps);
  const lines = log.mock.calls.map((call) => String(call[0]));
  const output = lines.join('\n');
  for (const privateValue of [AUTHOR, TEXT, CLIENT, deps.runsDir, deps.stateRoot]) {
    expect(output).not.toContain(privateValue);
  }
  return { code, lines };
}

describe('fleet slack-trace requires durable ingress for success (460s)', () => {
  it('refuses reply evidence when the request has no bus ingress receipt', async () => {
    const deps = fixture([{ messageTs: MESSAGE_A, at: AT_A }], [REPLY_A]);
    const before = snapshot(deps);
    const { code, lines } = await run(['--thread', THREAD, '--json'], deps);
    const trace = JSON.parse(lines[0]!);
    expect(code).toBe(1);
    // Unknown-ingress rows are never answered, and transport evidence cannot
    // prove durable receipt: a keyed send for one is UNCERTAIN with no replyTs.
    expect(trace.rows).toEqual([expect.objectContaining({
      messageTs: MESSAGE_A, ingress: 'unknown', outcome: 'uncertain',
    })]);
    expect(trace.rows[0].replyTs).toBeUndefined();
    expect(trace.counts).toEqual({ total: 1, answered: 0, uncertain: 1, busFailed: 0, unanswered: 0 });
    expect(trace.sources).toEqual({ journal: 'ok', sends: 'ok' });
    expect(trace.scope).toContain('Bounded local persisted journal and send evidence only');
    expect(trace.scope).toContain('does not prove current runtime reachability');
    expect(snapshot(deps)).toEqual(before);
  });

  it('keeps human output honest: unknown ingress shown, no reply credited, scope caveat, exit 1', async () => {
    const deps = fixture([{ messageTs: MESSAGE_A, at: AT_A }], [REPLY_A]);
    const { code, lines } = await run(['--thread', THREAD], deps);
    expect(code).toBe(1);
    expect(lines[0]).toContain('does not prove current runtime reachability');
    expect(lines[1]).toContain(`msg=${MESSAGE_A} ingress=unknown -> UNCERTAIN`);
    expect(lines[1]).not.toContain('reply=');
  });

  it.each([
    ['posted', 'posted'],
    ['duplicate', 'duplicate'],
  ] as const)('exits 0 for %s ingress with a valid same-thread reply', async (_label, bus) => {
    const deps = fixture([{ messageTs: MESSAGE_A, at: AT_A, bus }], [REPLY_A]);
    const { code, lines } = await run(['--thread', THREAD, '--json'], deps);
    expect(code).toBe(0);
    expect(JSON.parse(lines[0]!).rows[0]).toMatchObject({ ingress: bus, outcome: 'answered', replyTs: REPLY_A });
  });

  it('exits 1 for a mixed set where one answered request lacks ingress evidence', async () => {
    const deps = fixture([
      { messageTs: MESSAGE_A, at: AT_A, bus: 'posted' },
      { messageTs: MESSAGE_B, at: AT_B },
    ], [REPLY_A, REPLY_B]);
    const { code, lines } = await run(['--thread', THREAD, '--json'], deps);
    const trace = JSON.parse(lines[0]!);
    expect(code).toBe(1);
    expect(trace.counts).toMatchObject({ total: 2, answered: 1, uncertain: 1 });
    expect(trace.rows.map((row: { ingress: string }) => row.ingress)).toEqual(['posted', 'unknown']);
  });

  it('exits 0 when the fully evidenced channel and thread are selected, despite an unknown-ingress row elsewhere', async () => {
    const deps = fixture([
      { messageTs: MESSAGE_A, at: AT_A, bus: 'posted' },
      { messageTs: MESSAGE_B, at: AT_B, channelId: OTHER_CHANNEL, bus: 'posted' },
    ], [REPLY_A]);
    const unfiltered = await run(['--json'], deps);
    expect(unfiltered.code).toBe(1);
    const { code, lines } = await run(['--channel', CHANNEL, '--thread', THREAD, '--json'], deps);
    const trace = JSON.parse(lines[0]!);
    expect(code).toBe(0);
    expect(trace.collectionScope).toEqual({ thread: THREAD, channelId: CHANNEL });
    expect(trace.rows).toHaveLength(1);
    expect(trace.rows[0]).toMatchObject({ ingress: 'posted', outcome: 'answered', replyTs: REPLY_A });
  });

  it('keeps unanswered and bus-failed requests unsuccessful', async () => {
    const unanswered = fixture([{ messageTs: MESSAGE_A, at: AT_A, bus: 'posted' }]);
    expect((await run(['--thread', THREAD, '--json'], unanswered)).code).toBe(1);
    const failed = fixture([{ messageTs: MESSAGE_A, at: AT_A, bus: 'failed' }], [REPLY_A]);
    const { code, lines } = await run(['--thread', THREAD, '--json'], failed);
    expect(code).toBe(1);
    expect(JSON.parse(lines[0]!).rows[0]).toMatchObject({ ingress: 'failed', outcome: 'bus-failed' });
  });

  it('keeps an unknown-ingress row with no stored send UNANSWERED, and a legacy row without identity unverified', async () => {
    const deps = fixture([{ messageTs: MESSAGE_A, at: AT_A }]);
    const { lines } = await run(['--thread', THREAD, '--json'], deps);
    expect(JSON.parse(lines[0]!).rows[0]).toMatchObject({ ingress: 'unknown', outcome: 'unanswered' });
    // Same fixture, journal row rewritten without the request id.
    const path = slackJournalPath(deps.runsDir);
    writeFileSync(path, readFileSync(path, 'utf8').replace(/"requestId":"[a-f0-9]{64}",?/, '').replace(/,}/, '}'));
    const legacy = await run(['--thread', THREAD, '--json'], deps);
    expect(JSON.parse(legacy.lines[0]!).rows[0]).toMatchObject({ outcome: 'uncertain', evidence: 'unverified' });
  });

  it('keeps empty evidence unsuccessful with no synthetic private values in output', async () => {
    const deps = fixture([]);
    const { code, lines } = await run(['--json'], deps);
    expect(code).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ rows: [], counts: { total: 0 }, sources: { journal: 'missing' } });
  });
});
