import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetBusNext } from '../src/cli/fleet-bus-next.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

let root: string, output: ReturnType<typeof vi.spyOn>;
const args = () => ['--to', 'worker-a', '--owner', 'worker-a', '--lease-ms', '60000', '--root', root, '--json'];
async function run(extra = args()) {
  const index = output.mock.calls.length;
  const code = await cmdFleetBusNext(extra);
  return { code, ...JSON.parse(String(output.mock.calls[index]![0])) };
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bus-next-cli-')); output = vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('returns priority-ordered real receipts and leases through JSON', async () => {
  for (const [id, to, priority, body] of [
    ['low', 'worker-a', 'P2', { kind: 'work', text: 'fake low' }],
    ['chat', 'worker-a', 'P0', { kind: 'chat' }],
    ['other', 'worker-b', 'P0', { kind: 'work' }],
    ['high', 'worker-a', 'P1', { kind: 'work', text: 'fake high' }],
  ] as const) {
    expect(appendBusInbox({ id, from: 'fake', to, priority, ttl: 120_000, body }, { root }).status).toBe('posted');
  }
  const first = await run(), second = await run();
  expect(first).toMatchObject({ code: 0, status: 'acquired', receipt: { envelope: { id: 'high', body: { text: 'fake high' } } } });
  expect(first.token).toMatch(/^[a-f0-9]{64}$/);
  expect(first.leaseUntil).toBeGreaterThan(Date.now());
  expect(second).toMatchObject({ code: 0, status: 'acquired', receipt: { envelope: { id: 'low' } } });
  // high and low are both still live claimable receipts on worker-a, each held
  // by worker-a's own unreleased lease — held work, not a dry well.
  expect(await run()).toEqual({ code: 0, status: 'empty', candidates: 2, held: 2 });
}, 120_000);

it('applies contains, since and priority filters to the claimable scan', async () => {
  for (const [id, priority, body] of [
    ['flt-old', 'P0', { kind: 'work', text: 'deploy alpha' }],
    ['flt-chore', 'P3', { kind: 'work', text: 'unrelated chore' }],
    ['flt-alpha', 'P1', { kind: 'work', text: 'ship ALPHA build' }],
  ] as const) {
    expect(appendBusInbox({ id, from: 'fake', to: 'worker-a', priority, ttl: 120_000, body }, { root }).status).toBe('posted');
  }
  // --priority keeps only the exact band.
  const byPriority = await run([...args(), '--priority', 'P1']);
  expect(byPriority).toMatchObject({ code: 0, status: 'acquired',
    receipt: { envelope: { id: 'flt-alpha' } } });
  // --contains matches the scrubbed one-line summary case-insensitively; with
  // --priority P0 only the older alpha receipt qualifies.
  const byContains = await run([...args(), '--contains', 'alpha', '--priority', 'P0']);
  expect(byContains).toMatchObject({ code: 0, status: 'acquired',
    receipt: { envelope: { id: 'flt-old' } } });
  // --since past every receipt's arrival empties the filtered scan honestly —
  // unfiltered, the two live leases would read as held candidates instead.
  const future = String(Date.now() + 3_600_000);
  expect(await run([...args(), '--since', future]))
    .toEqual({ code: 0, status: 'empty', candidates: 0, held: 0 });
  // --before is the exclusive receivedAt ceiling: a cutoff before every
  // receipt's arrival empties the same filtered scan.
  expect(await run([...args(), '--before', '1']))
    .toEqual({ code: 0, status: 'empty', candidates: 0, held: 0 });
});

it('applies the in-reply-to and body-kind filters to the claimable scan', async () => {
  for (const [id, priority, body] of [
    ['cit-plain', 'P0', { kind: 'work', text: 'fake plain' }],
    ['cit-reply', 'P1', { kind: 'work', text: 'fake reply', inReplyTo: 'req-1' }],
    ['cit-other', 'P2', { kind: 'work', text: 'fake other', inReplyTo: 'req-2' }],
  ] as const) {
    expect(appendBusInbox({ id, from: 'fake', to: 'worker-a', priority, ttl: 120_000, body }, { root }).status).toBe('posted');
  }
  // --in-reply-to keeps only the body citing that envelope id, ahead of the
  // higher-priority uncited work.
  const byReply = await run([...args(), '--in-reply-to', 'req-1']);
  expect(byReply).toMatchObject({ code: 0, status: 'acquired',
    receipt: { envelope: { id: 'cit-reply' } } });
  // --body-kind work still sees the legacy receipts; the completed reply
  // counts as a filtered candidate, so the P0 plain claims next.
  const byKind = await run([...args(), '--body-kind', 'work']);
  expect(byKind).toMatchObject({ code: 0, status: 'acquired',
    receipt: { envelope: { id: 'cit-plain' } } });
  // A kind no claimable body carries and a citation nobody wrote are honest
  // empty scans, not widened claims.
  expect(await run([...args(), '--body-kind', 'note']))
    .toEqual({ code: 0, status: 'empty', candidates: 0, held: 0 });
  expect(await run([...args(), '--in-reply-to', 'req-9']))
    .toEqual({ code: 0, status: 'empty', candidates: 0, held: 0 });
});

it('validates all flags without returning bodies or tokens', async () => {
  for (const bad of [[], ['--help', '--json'], args().slice(0, -1), [...args(), '--json'],
    [...args(), '--owner', 'duplicate'], args().map(x => x === '60000' ? '0' : x),
    args().map(x => x === '60000' ? '3e3' : x), args().map(x => x === root ? 'relative' : x),
    args().map(x => x === 'worker-a' ? 'bad label' : x), [...args(), '--unknown'],
    [...args(), '--priority', 'P9'], [...args(), '--since', 'bogus'], [...args(), '--before', 'bogus'],
    [...args(), '--contains', '   '], [...args(), '--in-reply-to', 'has space'],
    [...args(), '--body-kind', 'has space'], [...args(), '--body-kind', '']]) {
    expect(await run(bad)).toEqual({ code: 2, status: 'invalid' });
  }
});

it('documents the marker and follows the fleet convention export naming', async () => {
  expect(resolveFleetSubcommand('bus-next')).toEqual({ module: './fleet-bus-next.js', exportName: 'cmdFleetBusNext' });
  expect(typeof (await import('../src/cli/fleet-bus-next.js')).cmdFleetBusNext).toBe('function');
  expect(await cmdFleetBusNext(['--help'])).toBe(0);
  expect(output).toHaveBeenCalledWith(expect.stringContaining('{"kind":"work"}'));
});
