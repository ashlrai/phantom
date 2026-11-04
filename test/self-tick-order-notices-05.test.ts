import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  'reset-release': ok, 'lane-autohold': ok, 'planner-tick': ok, 'inbox-acks': ok,
  'meter-incident': ok, 'waste-incident': ok, 'landed-sweep': ok,
};
const ledger = () => join(runsDir, 'queue', 'order-notices.jsonl');
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'order-notices-05-'));
  runsDir = join(home, 'runs');
  for (const path of ['leader', 'queue/prompts', 'metrics']) mkdirSync(join(runsDir, path), { recursive: true });
  writeFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'),
    '2026-11-01T04:08:00.000Z [src:telegram id:t123] Ship the plainly fake fix\n');
  writeFileSync(join(runsDir, 'queue/prompts/RQ-PHX-FAKE5.md'), "Serve Mason's Nov 1 00:08 order");
  writeFileSync(join(runsDir, 'metrics/jobs.jsonl'),
    JSON.stringify({ job: 'RQ-PHX-FAKE5', state: 'merged', url: 'https://github.com/example/fake/pull/5' }));
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

it('orders order-notices after inbox-acks and before the incident steps and landed-sweep', () => {
  expect(SELF_TICK_STEP_ORDER).toEqual([
    'reset-release', 'lane-autohold', 'planner-tick', 'inbox-acks', 'order-notices',
    'meter-incident', 'waste-incident', 'landed-sweep',
  ]);
});

it('passes --apply through only on apply ticks', async () => {
  for (const apply of [true, false]) {
    const notices = vi.fn(ok);
    expect(await cmdFleetSelfTick(['--json', '--runs-dir', runsDir, ...(apply ? ['--apply'] : [])], {
      home, now, steps: { ...otherSteps, 'order-notices': notices }, output: () => {},
    })).toBe(0);
    expect(notices.mock.calls[0]![0]).toEqual(['--json', ...(apply ? ['--apply'] : []), '--runs-dir', runsDir]);
  }
});

it('dry-run reports planned notices and writes no ledger; apply sends once and dedupes', async () => {
  const send = vi.fn(async () => {});
  const output: string[] = [];
  const run = (apply: boolean) => cmdFleetSelfTick(['--runs-dir', runsDir, ...(apply ? ['--apply'] : [])], {
    home, now, steps: otherSteps, noticeSenders: { telegram: send }, output: text => output.push(text),
  });
  expect(await run(false)).toBe(0);
  expect(send).not.toHaveBeenCalled();
  expect(existsSync(ledger())).toBe(false);
  expect(output.at(-1)).toContain('sent=0 planned=1');
  expect(await run(true)).toBe(0);
  expect(send).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    entryId: 't123', jobId: 'RQ-PHX-FAKE5', channel: 'telegram',
    text: expect.stringContaining('Merged: RQ-PHX-FAKE5'),
  }));
  expect(readFileSync(ledger(), 'utf8')).toContain('"status":"sent"');
  expect(await run(true)).toBe(0);
  expect(send).toHaveBeenCalledOnce();
  expect(output.at(-1)).toContain('sent=0 planned=0');
});

it('records a throwing order-notices step as failed and still runs landed-sweep', async () => {
  const sweep = vi.fn(ok);
  expect(await cmdFleetSelfTick(['--apply', '--json', '--runs-dir', runsDir], {
    home, now, output: () => {}, steps: {
      ...otherSteps, 'order-notices': async () => { throw new Error('fake failure'); }, 'landed-sweep': sweep,
    },
  })).toBe(1);
  expect(sweep).toHaveBeenCalledOnce();
  expect(readSelfTickLast(runsDir, now())).toMatchObject({ state: 'ok', failedSteps: ['order-notices'] });
});
