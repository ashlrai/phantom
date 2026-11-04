import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetResetWatch } from '../src/cli/fleet-reset-watch.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import type { ResetReleaseResult } from '../src/core/fleet/usage-reset-release.js';

const pass = (errors: ResetReleaseResult['errors'] = [], released: ResetReleaseResult['released'] = []): ResetReleaseResult =>
  ({ at: '2026-11-03T00:00:00Z', checked: 2, released, errors, bus: [] });
const row: ResetReleaseResult['released'][number] = { lane: 'lane-a', state: 'reset-detected', usedPct: 3,
  readingAsOf: '2026-11-03T00:00:00Z', heldUntil: '2026-11-04T00:00:00Z' };

it('publishes CLI observations, retries failed state and preserves JSONL and cancellation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reset-bus-'));
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const controller = new AbortController();
    const outputs: string[] = [];
    const samples = [pass(), pass(), pass(), pass([{ lane: '/private/lane', message: 'secret evidence' }]),
      pass([{ lane: '/private/lane', message: 'changed evidence' }]), pass(), pass([], [row]), pass([], [row])];
    let time = 0, attempts = 0;
    const run = vi.fn(async () => samples.shift()!);
    const code = await cmdFleetResetWatch(['--timeout-ms', '20', '--poll-ms', '1', '--bus-root', root, '--json'], {
      run, signal: controller.signal, now: () => time,
      sleep: async ms => { time += ms; if (time === 8) controller.abort(); },
      emit: line => { outputs.push(line); },
      append: (envelope, options) => {
        attempts++;
        if (attempts === 2) return { status: 'unavailable' };
        return appendBusInbox(envelope, options);
      },
    });
    expect(code).toBe(130);
    expect(run).toHaveBeenCalledTimes(8);
    expect(outputs.map(line => JSON.parse(line).type)).toEqual([...Array(8).fill('pass'), 'end']);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]![0])).not.toContain(root);
    const page = listBusInboxAfter(0, 50, { root });
    expect(page.status).toBe('ok');
    if (page.status !== 'ok') throw new Error('bus unavailable');
    const bodies = page.messages.map(message => message.envelope.body as Record<string, unknown>);
    expect(bodies.map(body => body.kind)).toEqual(['reset-watch.start.v1', 'reset-watch.pass.v1',
      'reset-watch.pass.v1', 'reset-watch.pass.v1', 'reset-watch.pass.v1', 'reset-watch.pass.v1',
      'reset-watch.pass.v1', 'reset-watch.end.v1']);
    expect(bodies.slice(1, -1).map(body => [body.healthy, body.released])).toEqual([
      [true, 0], [false, 0], [false, 0], [true, 0], [true, 1], [true, 1],
    ]);
    expect(bodies.at(-1)).toMatchObject({ outcome: 'cancelled', passes: 8, released: 2, errors: 2 });
    expect(new Set(bodies.map(body => body.invocationId)).size).toBe(1);
    expect(JSON.stringify(bodies)).not.toMatch(/private|secret|evidence|lane-a/);
  } finally { stderr.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

it('reports unavailable bus without changing a successful result and gives each invocation a fresh identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reset-bus-'));
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    let time = 0;
    const args = ['--timeout-ms', '1', '--bus-root', root];
    const deps = { run: async () => pass(), now: () => time, sleep: async (ms: number) => { time += ms; }, emit: () => {} };
    expect(await cmdFleetResetWatch(args, { ...deps, append: () => ({ status: 'unavailable' }) })).toBe(0);
    expect(stderr).toHaveBeenCalledTimes(3);
    time = 0;
    expect(await cmdFleetResetWatch(args, deps)).toBe(0);
    time = 0;
    expect(await cmdFleetResetWatch(args, deps)).toBe(0);
    const page = listBusInboxAfter(0, 50, { root });
    if (page.status !== 'ok') throw new Error('bus unavailable');
    const ids = page.messages.filter(row => (row.envelope.body as Record<string, unknown>).kind === 'reset-watch.start.v1')
      .map(row => (row.envelope.body as Record<string, unknown>).invocationId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  } finally { stderr.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
