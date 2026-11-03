import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { callNativeTool, nativeToolSafety, listNativeTools } from '../src/core/mcp-native.js';

const id = '12345678-1234-4123-8123-123456789abc';
const other = '12345678-1234-4123-8123-123456789abd';
const name = 'phantom_fleet_apps_recovery_wait';
const roots: string[] = [];
const oldRoot = process.env.ASHLR_RUNS_DIR;
afterEach(() => { vi.useRealTimers(); if (oldRoot === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = oldRoot; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'recovery-mcp-')); roots.push(root); process.env.ASHLR_RUNS_DIR = root;
  let seq = 0;
  return { root, append(invocationId: string, terminal = false) {
    const common = { invocationId, recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0 };
    const state = [{ app: 'Phantom', observedRunning: true }];
    const body = terminal ? { ...common, kind: 'apps-watch.summary.v1', apps: ['Phantom'], outcome: 'failed', cycles: 1, lastObservedState: state }
      : { ...common, kind: 'apps-watch.observation.v1', cycle: 1, healthy: true, observedState: state };
    expect(appendBusInbox({ id: `event-${++seq}`, from: 'apps-watch', to: 'leaders', priority: 'P2', ttl: 86400000, body }, { root }).status).toBe('posted');
  } };
}
const args = { invocationId: id, maxAgeMs: 1000, timeoutMs: 250, intervalMs: 100 };
async function call(input: unknown = args) { return callNativeTool(name, input); }
function payload(result: Awaited<ReturnType<typeof call>>) { return JSON.parse(result.content[0]!.text); }

it('is listed read-only and waits for fresh evidence for the requested invocation', async () => {
  vi.useFakeTimers(); const f = fixture(); f.append(id); vi.advanceTimersByTime(2000); f.append(other);
  const pending = call(); await vi.advanceTimersByTimeAsync(100); f.append(id); await vi.advanceTimersByTimeAsync(100);
  expect(payload(await pending)).toMatchObject({ invocationId: id, outcome: 'healthy', verdict: { verdict: 'healthy' } });
  expect(nativeToolSafety(name)).toBe('read'); expect(listNativeTools().some(tool => tool.name === name)).toBe(true);
});
it('returns terminal and timeout for unrelated evidence', async () => {
  vi.useFakeTimers(); const f = fixture(); f.append(other);
  const pending = call(); await vi.advanceTimersByTimeAsync(300);
  expect(payload(await pending)).toMatchObject({ outcome: 'timeout', verdict: { verdict: 'unknown' } });
  f.append(id, true); expect(payload(await call())).toMatchObject({ outcome: 'terminal', verdict: { verdict: 'terminal' } });
});
it('rejects invalid arguments before reading and hides unavailable paths', async () => {
  const f = fixture(); rmSync(f.root, { recursive: true }); writeFileSync(f.root, 'bad');
  for (const bad of [[], null, { ...args, extra: 1 }, { ...args, invocationId: other.slice(1) }, { ...args, maxAgeMs: Infinity }, { ...args, timeoutMs: 1.5 }, { ...args, intervalMs: 99 }]) {
    expect((await call(bad)).isError).toBe(true);
  }
  const result = await call(); expect(payload(result)).toMatchObject({ outcome: 'unavailable' });
  expect(JSON.stringify(result)).not.toContain(f.root);
});
