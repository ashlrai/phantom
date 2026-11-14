import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSlackObservation, type SlackObservation } from '../src/core/agents/slack-journal.js';
import { cmdFleetSlackTrace } from '../src/cli/fleet-slack-trace.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const CH = 'C0FAKE0001';
const T1 = '1731000000.000100';
const T2 = '1731002000.000100';
const MSG1 = '1731000010.000100';
const MSG2 = '1731000020.000100';
const REPLY = '1731000050.000100';
const NOW = new Date('2025-11-07T18:00:00.000Z');
const AT1 = '2025-11-07T17:00:00.000Z';
const AT2 = '2025-11-07T17:01:00.000Z';
const AT3 = '2025-11-07T17:02:00.000Z';
const DIGEST = 'a'.repeat(64);
const CLIENT = '11111111-1111-1111-1111-111111111111';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'slack-trace-339-'));
  roots.push(dir);
  return { runsDir: join(dir, 'runs'), stateRoot: join(dir, 'state') };
}

const ingest = (runsDir: string, at: string, messageTs: string, threadTs: string = T1,
  extra: Partial<SlackObservation> = {}): void => {
  recordSlackObservation({ at, decision: 'ingested', channelId: CH, messageTs, threadTs, ...extra }, { runsDir });
};

type Row = { channel: string; thread?: string; state: 'attempted' | 'sent'; ts?: string };
function writeStore(stateRoot: string, rows: Row[]): void {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const messages: Record<string, unknown> = {};
  rows.forEach((row, i) => {
    messages[String(i).padStart(64, '0')] = { digest: DIGEST, clientId: CLIENT, expiresAt: 9e12, ...row };
  });
  writeFileSync(join(stateRoot, 'messages.json'), JSON.stringify({ version: 1, messages }), { mode: 0o600 });
}

async function run(args: string[], deps: { runsDir: string; stateRoot: string }) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await cmdFleetSlackTrace(args, { ...deps, now: () => NOW });
  return { code, lines: log.mock.calls.map((c) => String(c[0])) };
}

describe('fleet slack-trace (339)', () => {
  it('a same-thread sent receipt answers the request and exits 0', async () => {
    const p = setup();
    ingest(p.runsDir, AT1, MSG1, T1, { bus: 'posted' });
    writeStore(p.stateRoot, [{ channel: CH, thread: T1, state: 'sent', ts: REPLY }]);
    const { code, lines } = await run([], p);
    expect(code).toBe(0);
    expect(lines[0]).toContain('journal=ok sends=ok');
    expect(lines[1]).toBe(`${AT1} ${CH} thread=${T1} msg=${MSG1} ingress=posted -> ANSWERED reply=${REPLY}`);
  });

  it('binds one reply one-to-one: a second request in the same thread is UNANSWERED', async () => {
    const p = setup();
    ingest(p.runsDir, AT1, MSG1, T1, { bus: 'posted' });
    ingest(p.runsDir, AT2, MSG2, T1, { bus: 'posted' });
    writeStore(p.stateRoot, [{ channel: CH, thread: T1, state: 'sent', ts: '1731000100.000100' }]);
    const { code, lines } = await run([], p);
    expect(code).toBe(1);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(`msg=${MSG1} ingress=posted -> ANSWERED reply=1731000100.000100`);
    expect(lines[2]).toContain(`msg=${MSG2} ingress=posted -> UNANSWERED`);
    expect(lines[2]).not.toContain('reply=');
  });

  it('a duplicate redelivery of the same message still answers only the first row', async () => {
    const p = setup();
    ingest(p.runsDir, AT1, MSG1, T1, { bus: 'posted' });
    ingest(p.runsDir, AT2, MSG1, T1, { bus: 'duplicate' });
    writeStore(p.stateRoot, [{ channel: CH, thread: T1, state: 'sent', ts: REPLY }]);
    const { code, lines } = await run([], p);
    expect(code).toBe(1);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(`msg=${MSG1} ingress=posted -> ANSWERED reply=${REPLY}`);
    expect(lines[2]).toContain(`msg=${MSG1} ingress=duplicate -> UNANSWERED`);
  });

  it('an attempted send in the thread leaves the request UNCERTAIN', async () => {
    const p = setup();
    ingest(p.runsDir, AT1, MSG1, T1, { bus: 'posted' });
    writeStore(p.stateRoot, [{ channel: CH, thread: T1, state: 'attempted' }]);
    const { code, lines } = await run([], p);
    expect(code).toBe(1);
    expect(lines[1]).toContain(`msg=${MSG1} ingress=posted -> UNCERTAIN`);
  });

  it('a failed bus append reports BUS-FAILED', async () => {
    const p = setup();
    ingest(p.runsDir, AT1, MSG1, T1, { bus: 'failed' });
    writeStore(p.stateRoot, []);
    const { code, lines } = await run([], p);
    expect(code).toBe(1);
    expect(lines[1]).toContain(`msg=${MSG1} ingress=failed -> BUS-FAILED`);
  });

  it('a top-level sent post never answers a threaded request', async () => {
    const p = setup();
    ingest(p.runsDir, AT1, MSG1, T1);
    writeStore(p.stateRoot, [{ channel: CH, state: 'sent', ts: REPLY }]);
    const { code, lines } = await run([], p);
    expect(code).toBe(1);
    expect(lines[1]).toContain(`msg=${MSG1} ingress=unknown -> UNANSWERED`);
  });

  it('--thread filters rows to one thread and a malformed ts exits 2', async () => {
    const p = setup();
    ingest(p.runsDir, AT1, MSG1, T1, { bus: 'posted' });
    ingest(p.runsDir, AT2, MSG2, T2, { bus: 'posted' });
    writeStore(p.stateRoot, [{ channel: CH, thread: T1, state: 'sent', ts: REPLY }]);
    const { code, lines } = await run(['--thread', T1], p);
    expect(code).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`thread=${T1} msg=${MSG1} ingress=posted -> ANSWERED reply=${REPLY}`);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetSlackTrace(['--thread', 'bogus'], p)).toBe(2);
    expect(await cmdFleetSlackTrace(['--thread'], p)).toBe(2);
    expect(await cmdFleetSlackTrace(['--bogus'], p)).toBe(2);
    expect(err).toHaveBeenCalled();
  });

  it('missing journal and store report missing sources, empty rows, exit 0', async () => {
    const p = setup();
    const { code, lines } = await run([], p);
    expect(code).toBe(0);
    expect(lines).toEqual([`slack trace as of ${NOW.toISOString()} (journal=missing sends=missing)`]);
  });

  it('--json prints the trace with sources and counts, ignoring non-ingested rows and digests', async () => {
    const p = setup();
    ingest(p.runsDir, AT1, MSG1, T1, { bus: 'posted' });
    ingest(p.runsDir, AT2, MSG2, T1, { bus: 'duplicate' });
    recordSlackObservation({ at: AT3, decision: 'ignored', channelId: CH, messageTs: '1731000030.000100', threadTs: T1, reason: 'untrusted-sender' }, { runsDir: p.runsDir });
    writeStore(p.stateRoot, [{ channel: CH, thread: T1, state: 'sent', ts: REPLY }]);
    const { code, lines } = await run(['--json'], p);
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    const trace = JSON.parse(lines[0]!);
    expect(trace.asOf).toBe(NOW.toISOString());
    expect(trace.sources).toEqual({ journal: 'ok', sends: 'ok' });
    expect(trace.counts).toEqual({ total: 2, answered: 1, uncertain: 0, busFailed: 0, unanswered: 1 });
    expect(trace.rows[0]).toMatchObject({ at: AT1, channelId: CH, threadTs: T1, messageTs: MSG1, ingress: 'posted', outcome: 'answered', replyTs: REPLY });
    expect(trace.rows[1]).toMatchObject({ at: AT2, messageTs: MSG2, ingress: 'duplicate', outcome: 'unanswered' });
    expect(lines[0]).not.toContain(DIGEST);
    expect(lines[0]).not.toContain(CLIENT);
    expect(lines[0]).not.toContain('untrusted-sender');
  });

  it('--help prints usage and exits 0; the verb is registered', async () => {
    const p = setup();
    const { code, lines } = await run(['--help'], p);
    expect(code).toBe(0);
    expect(lines[0]).toContain('Usage: ashlr fleet slack-trace');
    expect(FLEET_SUBCOMMAND_LOADERS['slack-trace']).toBeTypeOf('function');
  });
});
