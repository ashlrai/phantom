import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetNeedsWaitGroup } from '../src/cli/fleet-needs-wait-group.js';

const texts = ['Fake resolved item', 'Fake pending item'];
const ids = texts.map(text => `nm-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`);
const dirs: string[] = [];
const counts = (): number[] => [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
function setup(resolved = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'group-signals-')); dirs.push(dir);
  writeFileSync(join(dir, 'NEEDS-MASON.md'), `${texts.map(text => `- [ ] ${text}`).join('\n')}\n${resolved ? `- [x] resolved ${ids[0]}\n` : ''}`);
  return dir;
}
function args(dir: string): string[] { return [...ids, '--timeout-ms', '60000', '--runs-dir', dir, '--json']; }
const pending = (_ms: number, signal: AbortSignal): Promise<void> => new Promise((_, reject) => {
  if (signal.aborted) reject(new Error('aborted'));
  else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
});
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

for (const name of ['SIGINT', 'SIGTERM'] as const) {
  it(`reports ${name} cancellation and retains resolved items`, async () => {
    const dir = setup(true), before = counts(), output: string[] = [];
    let ready!: () => void;
    const waiting = new Promise<void>(resolve => { ready = resolve; });
    const sleep = (ms: number, signal: AbortSignal): Promise<void> => { ready(); return pending(ms, signal); };
    const result = cmdFleetNeedsWaitGroup(args(dir), { emit: line => output.push(line), sleep, budgetSleep: pending });
    await waiting;
    expect(process.listenerCount(name)).toBeGreaterThan(before[name === 'SIGINT' ? 0 : 1]!);
    process.emit(name);
    expect(await result).toBe(130);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toEqual({ outcome: 'cancelled', items: [{ id: ids[0], status: 'resolved' }, { id: ids[1], status: 'cancelled' }] });
    expect(counts()).toEqual(before);
  });
}

it('handles a pre-aborted injected signal and cleans up its listener', async () => {
  const dir = setup(), before = counts(), controller = new AbortController(), output: string[] = [];
  const remove = vi.spyOn(controller.signal, 'removeEventListener'); controller.abort();
  expect(await cmdFleetNeedsWaitGroup(args(dir), { signal: controller.signal, emit: line => output.push(line), budgetSleep: pending })).toBe(130);
  expect(output).toHaveLength(1);
  expect(JSON.parse(output[0]!)).toEqual({ outcome: 'cancelled', items: ids.map(id => ({ id, status: 'cancelled' })) });
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  expect(counts()).toEqual(before);
});

it('cleans up across successful and repeated invocations and preserves other exits', async () => {
  const dir = setup(), before = counts(), output: string[] = [];
  writeFileSync(join(dir, 'NEEDS-MASON.md'), ids.map(id => `- [x] resolved ${id}`).join('\n'));
  for (let i = 0; i < 2; i++) {
    expect(await cmdFleetNeedsWaitGroup(args(dir), { emit: line => output.push(line), budgetSleep: pending })).toBe(0);
    expect(counts()).toEqual(before);
  }
  expect(output).toHaveLength(2);
  expect(output.map(line => JSON.parse(line).outcome)).toEqual(['resolved', 'resolved']);
  output.length = 0;
  expect(await cmdFleetNeedsWaitGroup(['nm-000000000000', '--timeout-ms', '1', '--runs-dir', dir, '--json'], { emit: line => output.push(line), budgetSleep: pending })).toBe(1);
  expect(JSON.parse(output[0]!).outcome).toBe('unknown');
  expect(counts()).toEqual(before);
});

it('installs no handlers for invalid arguments and cleans up on rejection', async () => {
  const before = counts(), on = vi.spyOn(process, 'on');
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  expect(await cmdFleetNeedsWaitGroup(['bad', '--timeout-ms', '1'])).toBe(2);
  expect(on).not.toHaveBeenCalled();
  const dir = setup();
  await expect(cmdFleetNeedsWaitGroup([...args(dir), '--stop-file', 'bad\0path'])).rejects.toThrow(RangeError);
  expect(counts()).toEqual(before);
});
