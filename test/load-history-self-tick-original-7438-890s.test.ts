import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import { SELF_TICK_STEP_ORDER, type SelfTickSteps } from '../src/core/fleet/self-tick.js';

const NOW = Date.parse('2026-11-24T12:00:00Z');
let root: string;

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'load-tick-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const steps = (order: string[]): SelfTickSteps => Object.fromEntries(
  SELF_TICK_STEP_ORDER.map(name => [name, async () => {
    order.push(name);
    return { exitCode: 0, output: '{}' };
  }]),
) as SelfTickSteps;

async function run(apply: boolean, snapshot: (dir: string) => Promise<unknown>, busy = false, order: string[] = []) {
  const output: string[] = [];
  const errors: string[] = [];
  const code = await cmdFleetSelfTick(['--json', '--runs-dir', root, ...(apply ? ['--apply'] : [])], {
    home: root, env: {}, isTty: true, now: () => NOW,
    steps: steps(order), loadSnapshot: snapshot, diskSample: async () => null,
    ...(busy ? { acquireLock: () => ({ state: 'contended' as const }) } : {}),
    output: text => output.push(text), error: text => errors.push(text),
  });
  expect(output).toHaveLength(1);
  expect(errors).toEqual([]);
  return { code, report: JSON.parse(output[0]!) as { state: string; mode: string; steps: unknown[] }, order };
}

describe('original #7438 self-tick load snapshot caller', () => {
  it('calls once with the runs root after an applied pass completes', async () => {
    const order: string[] = [];
    const snapshot = vi.fn(async (dir: string) => { order.push(dir); });
    const result = await run(true, snapshot, false, order);
    expect(result.code).toBe(0);
    expect(result.report).toMatchObject({ state: 'ran', mode: 'apply' });
    expect(result.order).toEqual([...SELF_TICK_STEP_ORDER, root]);
    expect(snapshot).toHaveBeenCalledExactlyOnceWith(root);
  });

  it('does not call on dry-run or a busy applied pass', async () => {
    const snapshot = vi.fn(async () => {});
    const dry = await run(false, snapshot);
    expect(dry.code).toBe(0);
    expect(dry.report).toMatchObject({ state: 'ran', mode: 'dry-run' });
    const busy = await run(true, snapshot, true);
    expect(busy.code).toBe(0);
    expect(busy.report).toMatchObject({ state: 'busy', mode: 'apply', steps: [] });
    expect(busy.order).toEqual([]);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('keeps a successful JSON report when the snapshot throws', async () => {
    const snapshot = vi.fn(async () => { throw new Error('snapshot failed'); });
    const result = await run(true, snapshot);
    expect(snapshot).toHaveBeenCalledExactlyOnceWith(root);
    expect(result.code).toBe(0);
    expect(result.report).toMatchObject({ state: 'ran', mode: 'apply' });
    expect(result.report.steps).toHaveLength(SELF_TICK_STEP_ORDER.length);
  });
});
