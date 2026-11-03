import { describe, expect, it, vi } from 'vitest';
import { FLEET_APPS } from '../src/core/verse/fleet-apps-api.js';
import { cmdFleetAppsChanges, type FleetAppsChangesDeps } from '../src/cli/fleet-apps-changes.js';

const stamp = '2026-11-01T00:00:00.000Z';
const row = (app: string, running: boolean | null, checkedAt: unknown = stamp) => ({ app, running, checkedAt });
const snapshot = (apps: unknown[]) => JSON.stringify({ v: 1, generatedAt: stamp, available: true, apps });
const args = ['--duration-ms', '300', '--interval-ms', '100', '--jsonl'];
function sequence(snapshots: string[]) {
  let time = 0, index = 0;
  return {
    runChild: vi.fn(async () => ({ code: 0, stdout: snapshots[Math.min(index++, snapshots.length - 1)]! })),
    now: () => time,
    sleep: async (ms: number) => { time += ms; },
  };
}
async function capture(options: string[], deps: FleetAppsChangesDeps) {
  let output = '';
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const code = await cmdFleetAppsChanges(options, deps);
    return { code, events: output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) };
  } finally { write.mockRestore(); error.mockRestore(); }
}

describe('fleet apps-changes selection', () => {
  const [a, b] = FLEET_APPS as readonly [string, string, ...string[]];
  it('emits only the selected app and counts its transitions', async () => {
    const deps = sequence([snapshot([row(a, false), row(b, false)]), snapshot([row(a, false), row(b, true)]), snapshot([row(a, true), row(b, false)])]);
    const result = await capture([...args, '--app', a, '--app', a], deps);
    expect(result.code).toBe(0);
    expect(result.events.map(e => [e.type, e.app, e.state])).toEqual([
      ['baseline', a, 'stopped'], ['transition', a, 'running'], ['summary', undefined, undefined],
    ]);
    expect(result.events.at(-1)).toMatchObject({ outcome: 'complete', transitions: 1 });
    expect(deps.runChild).toHaveBeenCalledWith(['fleet', 'apps-status', '--json', '--app', a], expect.anything());
  });
  it('orders two selected apps canonically regardless of flag order', async () => {
    const deps = sequence([snapshot([row(a, true), row(b, false)])]);
    const result = await capture([...args, '--app', b, '--app', a], deps);
    expect(result.events.filter(e => e.type === 'baseline').map(e => e.app)).toEqual([a, b]);
    expect(deps.runChild).toHaveBeenCalledWith(['fleet', 'apps-status', '--json', '--app', a, '--app', b], expect.anything());
  });
  it('keeps all-app behavior without selection', async () => {
    const deps = sequence([snapshot([row(a, true)])]);
    const result = await capture(args, deps);
    expect(result.events.filter(e => e.type === 'baseline').map(e => e.app)).toEqual([...FLEET_APPS]);
    expect(result.events.at(-1)).toMatchObject({ outcome: 'complete' });
    expect(deps.runChild).toHaveBeenCalledWith(['fleet', 'apps-status', '--json'], expect.anything());
  });
  it('does not accept unrelated valid rows for missing, malformed or duplicate selected rows', async () => {
    for (const selectedRows of [[], [row(a, true, null)], [row(a, true), row(a, false)]]) {
      const result = await capture([...args, '--app', a], sequence([snapshot([...selectedRows, row(b, true)])]));
      expect(result.code).toBe(1);
      expect(result.events[0]).toMatchObject({ app: a, state: 'unknown' });
      expect(result.events.at(-1)).toMatchObject({ outcome: 'unavailable' });
    }
  });
  it('treats an explicit null with a valid timestamp as observed', async () => {
    const result = await capture([...args, '--app', a], sequence([snapshot([row(a, null)])]));
    expect(result.code).toBe(0);
    expect(result.events[0]).toMatchObject({ app: a, state: 'unknown' });
    expect(result.events.at(-1)).toMatchObject({ outcome: 'complete' });
  });
  it('rejects invalid or missing app values before spawning', async () => {
    const runChild = vi.fn();
    for (const selection of [['--app'], ['--app', '--jsonl'], ['--app', 'not-an-app']]) {
      expect((await capture([...args, ...selection], { runChild })).code).toBe(2);
    }
    expect(runChild).not.toHaveBeenCalled();
  });
  it('cancels a selected stream during a child', async () => {
    const controller = new AbortController();
    const result = await capture([...args, '--app', a], { signal: controller.signal, runChild: async (_argv, options) => {
      controller.abort();
      expect(options.signal.aborted).toBe(true);
      return new Promise(() => {});
    } });
    expect(result.code).toBe(1);
    expect(result.events).toEqual([expect.objectContaining({ type: 'summary', outcome: 'cancelled', transitions: 0 })]);
  });
});
