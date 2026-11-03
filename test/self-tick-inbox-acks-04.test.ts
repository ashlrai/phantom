import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import { SELF_TICK_STEP_ORDER, type SelfTickStep, type SelfTickSteps } from '../src/core/fleet/self-tick.js';
import { readSelfTickLast } from '../src/core/fleet/self-tick-last.js';

let home: string;
let runsDir: string;
const now = () => Date.parse('2026-11-02T06:00:00Z');
const ok: SelfTickStep = async () => ({ exitCode: 0, output: '{}' });
const otherSteps: Partial<SelfTickSteps> = {
  'reset-release': ok, 'lane-autohold': ok, 'planner-tick': ok, 'landed-sweep': ok,
};
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'inbox-acks-04-'));
  runsDir = join(home, 'runs');
  mkdirSync(join(runsDir, 'leader'), { recursive: true });
  writeFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'),
    '2026-11-02T00:27:30-0500 [src:page id:fake-entry-04] Fake status request\n');
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

it('orders inbox-acks after planner-tick and before the final landed-sweep', () => {
  expect(SELF_TICK_STEP_ORDER).toEqual([
    'reset-release', 'lane-autohold', 'planner-tick', 'inbox-acks', 'landed-sweep',
  ]);
});

it.each([true, false])('translates only apply ticks to --flush (apply=%s)', async apply => {
  const ack = vi.fn(ok);
  expect(await cmdFleetSelfTick(['--json', '--runs-dir', runsDir, ...(apply ? ['--apply'] : [])], {
    home, now, steps: { ...otherSteps, 'inbox-acks': ack }, output: () => {},
  })).toBe(0);
  expect(ack).toHaveBeenCalledOnce();
  expect(ack.mock.calls[0]![0]).toEqual([
    '--json', ...(apply ? ['--flush'] : []), '--runs-dir', runsDir,
  ]);
});

it('dry-run sends nothing, apply sends once, and the ledger dedupes the next pass', async () => {
  const send = vi.fn(async () => {});
  const output: string[] = [];
  const run = (apply: boolean) => cmdFleetSelfTick(['--runs-dir', runsDir, ...(apply ? ['--apply'] : [])], {
    home, now, steps: otherSteps, senders: { page: send }, output: text => output.push(text),
  });
  expect(await run(false)).toBe(0);
  expect(send).not.toHaveBeenCalled();
  expect(output.at(-1)).toContain('acked=0 pending=1');
  expect(await run(true)).toBe(0);
  expect(send).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith({
    entryId: 'fake-entry-04', channel: 'page',
    text: 'Got it: Fake status request. In the planner brief at 2026-11-02T06:00:00.000Z.',
  });
  expect(output.at(-1)).toContain('acked=1 pending=0');
  expect(await run(true)).toBe(0);
  expect(send).toHaveBeenCalledOnce();
  expect(readFileSync(join(runsDir, 'queue', 'inbox-acks.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  expect(readSelfTickLast(runsDir, now())).toMatchObject({ state: 'ok', failedSteps: [] });
});

it('records a throwing ack step as failed and still runs landed-sweep', async () => {
  const sweep = vi.fn(ok);
  expect(await cmdFleetSelfTick(['--apply', '--json', '--runs-dir', runsDir], {
    home, now, output: () => {}, steps: {
      ...otherSteps, 'inbox-acks': async () => { throw new Error('fake failure'); }, 'landed-sweep': sweep,
    },
  })).toBe(1);
  expect(sweep).toHaveBeenCalledOnce();
  expect(readSelfTickLast(runsDir, now())).toMatchObject({ state: 'ok', failedSteps: ['inbox-acks'] });
});
