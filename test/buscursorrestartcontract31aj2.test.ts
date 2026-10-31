import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi, type Mock } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const POSTED_AT = 1_000;
// The frozen clock jumps past the middle record's 50 ms TTL while the agent is away.
const RESUMED_AT = 1_100;

interface Envelope { id: string; from: string; to: string; priority: string; ttl: number; body: { text: string } }

const envelopes: Envelope[] = [
  { id: 'fake-page-a', from: 'fake-agent-alpha', to: 'fake-agent-beta', priority: 'P1', ttl: 10_000, body: { text: 'fake one' } },
  { id: 'fake-page-b', from: 'fake-agent-alpha', to: 'fake-agent-beta', priority: 'P2', ttl: 10_000, body: { text: 'fake two' } },
  { id: 'fake-ephemeral', from: 'fake-agent-alpha', to: 'fake-agent-beta', priority: 'P0', ttl: 50, body: { text: 'fake expiring' } },
  { id: 'fake-remainder-a', from: 'fake-agent-alpha', to: 'fake-agent-beta', priority: 'P1', ttl: 10_000, body: { text: 'fake three' } },
  { id: 'fake-remainder-b', from: 'fake-agent-alpha', to: 'fake-agent-beta', priority: 'P3', ttl: 10_000, body: { text: 'fake four' } },
];

type Cli = typeof import('../src/cli/comms-bus.js');
type Run = (args: string[], now: number, exit?: number) => Promise<any>;

const receipt = (cursor: number, envelope: Envelope, ttl: number = envelope.ttl, receivedAt = POSTED_AT) =>
  ({ cursor, receivedAt, envelope: { ...envelope, ttl } });

function makeRun(cli: Cli, store: string, log: Mock): Run {
  return async (args, now, exit = 0) => {
    log.mockClear();
    expect(await cli.cmdCommsBus(args, { root: store, now: () => now })).toBe(exit);
    expect(log).toHaveBeenCalledTimes(1);
    return JSON.parse(String(log.mock.calls[0]?.[0]));
  };
}

async function seed(run: Run, dir: string): Promise<void> {
  for (const [index, envelope] of envelopes.entries()) {
    const file = join(dir, `envelope-${index}.json`);
    writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 });
    expect(await run(['post', '--file', file], POSTED_AT))
      .toEqual({ status: 'posted', id: envelope.id, cursor: index + 1 });
  }
}

/** Drop the loaded module graph as a process restart would; retain only the disk. */
async function restart(previous: Cli): Promise<Cli> {
  vi.resetModules();
  const fresh = await import('../src/cli/comms-bus.js');
  expect(fresh.cmdCommsBus).not.toBe(previous.cmdCommsBus);
  return fresh;
}

it('resumes a saved cursor in a fresh invocation and reads only the live remainder past an expired record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bus-cursor-restart-'));
  roots.push(dir);
  const store = join(dir, 'store');
  const checkpoint = join(dir, 'saved-cursor.json');
  const file = join(store, 'bus-inbox', 'messages.json');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});

  const first = await import('../src/cli/comms-bus.js');
  const before = makeRun(first, store, log);
  await seed(before, dir);

  const page = await before(['read', '--limit', '2'], POSTED_AT);
  expect(page).toEqual({
    status: 'ok',
    messages: [receipt(1, envelopes[0]), receipt(2, envelopes[1])],
    nextCursor: 2,
  });
  writeFileSync(checkpoint, JSON.stringify({ nextCursor: page.nextCursor }), { mode: 0o600 });
  const persisted = readFileSync(file, 'utf8');

  const resumedCli = await restart(first);
  const after = makeRun(resumedCli, store, log);
  const saved: number = JSON.parse(readFileSync(checkpoint, 'utf8')).nextCursor;
  expect(saved).toBe(2);

  // One read returns only the remainder: the gap at cursor 3 is the expired record.
  const remainder = await after(['read', '--after', String(saved)], RESUMED_AT);
  expect(remainder).toEqual({
    status: 'ok',
    messages: [receipt(4, envelopes[3], 9_900), receipt(5, envelopes[4], 9_900)],
    nextCursor: 5,
  });
  expect(await after(['read', '--after', String(remainder.nextCursor)], RESUMED_AT))
    .toEqual({ status: 'ok', messages: [], nextCursor: 5 });

  // Reads are pure: the durable store keeps every retained row, expired included.
  expect(readFileSync(file, 'utf8')).toBe(persisted);
  expect(JSON.parse(persisted)).toEqual(envelopes.map((envelope, index) => receipt(index + 1, envelope)));
  expect(await after(['status'], RESUMED_AT)).toEqual({
    source: 'available', retainedCount: 5, retainedBytes: statSync(file).size,
    maxMessages: 1024, maxBytes: 1024 * 1024, liveCount: 4, expiredCount: 1,
  });
}, 60_000);

it('advances the saved cursor through limited remainder pages that skip the expired record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bus-cursor-pages-'));
  roots.push(dir);
  const store = join(dir, 'store');
  const checkpoint = join(dir, 'saved-cursor.txt');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});

  const first = await import('../src/cli/comms-bus.js');
  const before = makeRun(first, store, log);
  await seed(before, dir);

  const page = await before(['read', '--limit', '1'], POSTED_AT);
  expect(page).toEqual({ status: 'ok', messages: [receipt(1, envelopes[0])], nextCursor: 1 });
  writeFileSync(checkpoint, String(page.nextCursor), { mode: 0o600 });

  const resumedCli = await restart(first);
  const after = makeRun(resumedCli, store, log);
  const saved = Number(readFileSync(checkpoint, 'utf8'));
  expect(saved).toBe(1);

  // Limit counts scanned live records: expired cursor 3 is skipped inside this page.
  const middle = await after(['read', '--after', String(saved), '--limit', '2'], RESUMED_AT);
  expect(middle).toEqual({
    status: 'ok',
    messages: [receipt(2, envelopes[1], 9_900), receipt(4, envelopes[3], 9_900)],
    nextCursor: 4,
  });
  const last = await after(['read', '--after', String(middle.nextCursor), '--limit', '2'], RESUMED_AT);
  expect(last).toEqual({ status: 'ok', messages: [receipt(5, envelopes[4], 9_900)], nextCursor: 5 });
  expect(await after(['read', '--after', String(last.nextCursor), '--limit', '2'], RESUMED_AT))
    .toEqual({ status: 'ok', messages: [], nextCursor: 5 });

  // The restarted invocation can still append: the ordinal cursor never resets.
  const extra = join(dir, 'envelope-extra.json');
  writeFileSync(extra, JSON.stringify({ ...envelopes[0], id: 'fake-after-restart' }), { mode: 0o600 });
  expect(await after(['post', '--file', extra], RESUMED_AT))
    .toEqual({ status: 'posted', id: 'fake-after-restart', cursor: 6 });
  expect(await after(['read', '--after', '5'], RESUMED_AT)).toEqual({
    status: 'ok', messages: [receipt(6, { ...envelopes[0], id: 'fake-after-restart' }, 10_000, RESUMED_AT)], nextCursor: 6,
  });
}, 60_000);
