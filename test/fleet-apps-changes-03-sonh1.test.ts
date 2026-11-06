import { describe, expect, it, vi } from 'vitest';
import { FLEET_APPS } from '../src/core/verse/fleet-apps-api.js';
import { cmdFleetAppsChanges, type FleetAppsChangesDeps } from '../src/cli/fleet-apps-changes.js';

const stamp = '2026-11-01T00:00:00.000Z';
function snapshot(running: boolean | null, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ v: 1, generatedAt: stamp, available: true, apps: FLEET_APPS.map(app => ({ app, running, checkedAt: stamp })), ...extra });
}
async function capture(args: string[], deps: FleetAppsChangesDeps): Promise<{ code: number; events: Record<string, unknown>[] }> {
  let output = '';
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output += String(chunk); return true; });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const code = await cmdFleetAppsChanges(args, deps);
    return { code, events: output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) };
  } finally { write.mockRestore(); error.mockRestore(); }
}
function sequence(values: Array<{ code: number | null; stdout: string }>) {
  let time = 0, index = 0;
  const runChild = vi.fn(async () => values[Math.min(index++, values.length - 1)]!);
  return { runChild, now: () => time, sleep: async (ms: number) => { time += ms; } };
}
const args = ['--duration-ms', '400', '--interval-ms', '100', '--jsonl'];

describe('fleet apps-changes', () => {
  it('emits baseline and only transitions, forwarding root', async () => {
    const deps = sequence([true, false, false, true].map(v => ({ code: 0, stdout: snapshot(v) })));
    const result = await capture([...args, '--root', '/tmp/fleet root'], deps);
    expect(result.code).toBe(0);
    expect(deps.runChild).toHaveBeenCalledWith(['fleet', 'apps-status', '--root', '/tmp/fleet root', '--json'], expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const app = result.events.filter(e => e.app === FLEET_APPS[0]);
    expect(app.map(e => [e.type, e.state])).toEqual([['baseline', 'running'], ['transition', 'stopped'], ['transition', 'running']]);
    expect(result.events.at(-1)).toMatchObject({ outcome: 'complete', samples: 4, transitions: 16 });
  });
  it('reports malformed snapshots as unknown and observes recovery', async () => {
    const deps = sequence([{ code: 0, stdout: snapshot(true) }, { code: 0, stdout: '{' }, { code: 0, stdout: '{' }, { code: 0, stdout: snapshot(true) }]);
    const result = await capture(args, deps);
    expect(result.events.filter(e => e.app === FLEET_APPS[0]).map(e => e.state)).toEqual(['running', 'unknown', 'running']);
  });
  it('retains valid degraded rows and marks duplicate and missing rows unknown', async () => {
    const rows = FLEET_APPS.slice(0, 2).map(app => ({ app, running: false, checkedAt: stamp }));
    rows.push({ ...rows[1]! });
    const result = await capture(['--duration-ms', '100', '--jsonl'], sequence([{ code: 1, stdout: snapshot(true, { degraded: true, apps: rows }) }]));
    expect(result.code).toBe(0);
    expect(result.events.slice(0, 3).map(e => e.state)).toEqual(['stopped', 'unknown', 'unknown']);
  });
  it('rejects invalid arguments before spawning', async () => {
    const runChild = vi.fn();
    for (const bad of [[], ['--duration-ms', '0'], ['--duration-ms', '300001'], ['--duration-ms', '1', '--interval-ms', '99'], ['--duration-ms', '1', '--root'], ['--duration-ms', '1', '--jsonl', '--jsonl'], ['--duration-ms', '1', 'Safari']]) {
      expect((await capture(bad, { runChild })).code).toBe(2);
    }
    expect(runChild).not.toHaveBeenCalled();
  });
  it('handles cancellation before and during a child', async () => {
    const controller = new AbortController();
    controller.abort();
    const runChild = vi.fn();
    expect((await capture(args, { runChild, signal: controller.signal })).code).toBe(1);
    expect(runChild).not.toHaveBeenCalled();
    const active = new AbortController();
    const result = await capture(args, { signal: active.signal, runChild: async (_args, options) => {
      active.abort();
      expect(options.signal.aborted).toBe(true);
      return new Promise(() => {});
    } });
    expect(result.events.at(-1)).toMatchObject({ outcome: 'cancelled' });
  });
  it('bounds a hung child and reports unavailable', async () => {
    let signal: AbortSignal | undefined;
    const start = performance.now();
    const result = await capture(['--duration-ms', '30', '--jsonl'], { runChild: async (_args, options) => { signal = options.signal; return new Promise(() => {}); } });
    expect(performance.now() - start).toBeLessThan(1000);
    expect(signal?.aborted).toBe(true);
    expect(result.code).toBe(1);
    expect(result.events.at(-1)).toMatchObject({ outcome: 'unavailable', samples: 1 });
  });
});
