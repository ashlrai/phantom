import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWaitCapacity } from '../examples/agents/wait-capacity.js';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';

const roots: string[] = [];
const at = '2026-10-31T12:00:00Z';
const args = ['--lane', 'claude', '--timeout-ms', '2000'];
async function fixture(status?: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'wait-capacity-'));
  roots.push(root);
  await mkdir(join(root, 'queue'));
  if (status !== undefined) await writeFile(join(root, 'queue/status.json'), JSON.stringify(status));
  return root;
}
function status(held = false, paused = false, running = 1, target = 3) {
  return { last_tick: at, paused, mem_free_pct: 50,
    lanes: { claude: { running, target, held, queued: 100 } } };
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function invoke(root: string, options: Parameters<typeof runWaitCapacity>[1] = {}) {
  let stdout = '', stderr = '', clock = Date.parse(at);
  const code = await runWaitCapacity([...args, '--runs-dir', root], {
    now: () => clock, wait: async ms => { clock += ms; }, ...options,
    stdout: text => { stdout += text; }, stderr: text => { stderr += text; },
  });
  return { code, stdout, stderr };
}

describe('wait for capacity', () => {
  it('reports observed slots and times using running, independent of queued work and unrelated source health', async () => {
    const result = await invoke(await fixture(status()));
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ v: 1, result: 'available', lane: 'claude', observation: {
      state: 'available', observedAt: '2026-10-31T12:00:00.000Z', lastTick: at, running: 1, target: 3, slots: 2,
    } });
  });

  it.each([[true, false, 1, 3], [false, true, 1, 3], [false, false, 3, 3]])(
    'times out while held=%s paused=%s running=%i target=%i', async (held, paused, running, target) => {
      const result = await invoke(await fixture(status(held, paused, running, target)));
      expect(result.code).toBe(3);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({ error: 'timeout', observation: { state: 'blocked' } });
    });

  it.each([
    ['missing status', undefined],
    ['missing lane', { ...status(), lanes: {} }],
    ['degraded status', { ...status(), lanes: { ...status().lanes, 'invalid-lane': { running: 0, target: 4, queued: 0, held: false } } }],
    ['malformed status', { ...status(), paused: 'no' }],
  ])('never invents capacity for %s', async (_name, value) => {
    const result = await invoke(await fixture(value));
    expect(result.code).toBe(3);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({ error: 'timeout', observation: { state: 'unknown', running: null, target: null, slots: null } });
  });

  it('retries unknown and blocked observations before success', async () => {
    const missing = await readFleetRunsDirState({ runsDir: await fixture() });
    const blocked = await readFleetRunsDirState({ runsDir: await fixture(status(true)) });
    const available = await readFleetRunsDirState({ runsDir: await fixture(status()) });
    const read = vi.fn().mockResolvedValueOnce(missing).mockResolvedValueOnce(blocked).mockResolvedValue(available);
    const result = await invoke('/fake/runs', { read, wait: async () => {} });
    expect(result.code).toBe(0);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('cleans up waiting and deadline timers on cancellation', async () => {
    const blocked = await readFleetRunsDirState({ runsDir: await fixture(status(true)) });
    vi.useFakeTimers();
    const controller = new AbortController();
    const result = runWaitCapacity(args, { read: async () => blocked, signal: controller.signal,
      stdout: () => {}, stderr: () => {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(2);
    controller.abort();
    expect(await result).toBe(130);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enforces the deadline even when a reader never settles', async () => {
    vi.useFakeTimers();
    let error = '';
    const result = runWaitCapacity(args, { read: () => new Promise(() => {}),
      stderr: text => { error += text; }, stdout: () => {} });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toBe(3);
    expect(JSON.parse(error)).toMatchObject({ error: 'timeout', observation: { state: 'unknown', slots: null } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries reader failures without exposing their contents', async () => {
    const result = await invoke('/fake/runs', { read: async () => { throw new Error('fake private content'); } });
    expect(result.code).toBe(3);
    expect(result.stderr).not.toContain('fake private content');
    expect(JSON.parse(result.stderr).observation).toMatchObject({ state: 'unknown', slots: null });
  });

  it('bounds and validates arguments without reading, and emits JSON errors', async () => {
    const read = vi.fn();
    for (const input of [[], ['--lane', 'claude'], ['--lane', 'claude', '--timeout-ms', '0'],
      ['--lane', 'claude', '--timeout-ms', '3600001'], ['--lane', 'claude', '--timeout-ms', '1', '--lane', 'claude']]) {
      let error = '';
      expect(await runWaitCapacity(input, { read, stderr: text => { error += text; } })).toBe(2);
      expect(JSON.parse(error).error).toBe('invalid_arguments');
    }
    expect(read).not.toHaveBeenCalled();
  });
});
