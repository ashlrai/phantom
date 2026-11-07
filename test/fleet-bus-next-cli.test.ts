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
  expect(await run()).toEqual({ code: 0, status: 'empty' });
}, 120_000);

it('validates all flags without returning bodies or tokens', async () => {
  for (const bad of [[], ['--help', '--json'], args().slice(0, -1), [...args(), '--json'],
    [...args(), '--owner', 'duplicate'], args().map(x => x === '60000' ? '0' : x),
    args().map(x => x === '60000' ? '3e3' : x), args().map(x => x === root ? 'relative' : x),
    args().map(x => x === 'worker-a' ? 'bad label' : x), [...args(), '--unknown']]) {
    expect(await run(bad)).toEqual({ code: 2, status: 'invalid' });
  }
});

it('documents the marker and follows the fleet convention export naming', async () => {
  expect(resolveFleetSubcommand('bus-next')).toEqual({ module: './fleet-bus-next.js', exportName: 'cmdFleetBusNext' });
  expect(typeof (await import('../src/cli/fleet-bus-next.js')).cmdFleetBusNext).toBe('function');
  expect(await cmdFleetBusNext(['--help'])).toBe(0);
  expect(output).toHaveBeenCalledWith(expect.stringContaining('{"kind":"work"}'));
});
