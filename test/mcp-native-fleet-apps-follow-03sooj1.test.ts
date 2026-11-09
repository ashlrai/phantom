import { mkdtempSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import * as follow from '../src/cli/fleet-apps-follow.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));
const name = 'phantom_fleet_apps_follow';
const id = '12345678-1234-4123-8123-123456789abc';
const other = '12345678-1234-4123-8123-123456789abd';
let home: string, root: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'mcp-follow-')); vi.stubEnv('HOME', home); root = join(home, '.ashlr-runs'); mkdirSync(root, { mode: 0o700 }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
const call = async (args: unknown) => { const result = await callNativeTool(name, args); return { result, body: JSON.parse(result.content[0]!.text) }; };
const post = (n: number, invocationId: string, kind: 'observation' | 'summary', outcome = 'completed') => {
  const common = { invocationId, recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0 };
  const body = kind === 'observation' ? { ...common, kind: 'apps-watch.observation.v1', cycle: 1, healthy: false, observedState: null } :
    { ...common, kind: 'apps-watch.summary.v1', apps: ['Phantom'], outcome, cycles: 1, lastObservedState: null };
  expect(appendBusInbox({ id: `event-${n}`, from: 'apps-watch', to: 'leaders', priority: 'P2', ttl: 60000, body }, { root }).status).toBe('posted');
};

it('advertises a closed read schema and rejects invalid input before reading', async () => {
  expect(nativeToolSafety(name)).toBe('read');
  expect(listNativeTools().find(t => t.name === name)?.inputSchema).toMatchObject({ additionalProperties: false, required: ['durationMs'], properties: { durationMs: { minimum: 1, maximum: 30000 }, maxEvents: { maximum: 100 } } });
  const spy = vi.spyOn(follow, 'cmdFleetAppsFollow');
  for (const args of [null, {}, { durationMs: 0 }, { durationMs: 30001 }, { durationMs: 1, root }, { durationMs: 1, after: -1 }, { durationMs: 1, after: Number.MAX_SAFE_INTEGER + 1 }, { durationMs: 1, invocationId: 'bad' }, { durationMs: 1, untilSummary: true }, { durationMs: 1, intervalMs: 99 }, { durationMs: 1, maxEvents: 101 }, { durationMs: 1, untilSummary: 1 }]) {
    expect((await callNativeTool(name, args)).isError).toBe(true);
  }
  expect(spy).not.toHaveBeenCalled();
});

it('filters retained events and resumes from the returned cursor through the matching summary', async () => {
  post(1, id, 'observation'); post(2, other, 'observation'); post(3, id, 'summary');
  const first = await call({ durationMs: 1000, invocationId: id, maxEvents: 1 });
  expect(first.result.isError).toBeFalsy(); expect(first.body.events).toHaveLength(1);
  expect(first.body.summary).toMatchObject({ reason: 'event_limit', nextCursor: 1 });
  const next = await call({ durationMs: 1000, invocationId: id, after: first.body.summary.nextCursor, untilSummary: true });
  expect(next.result.isError).toBeFalsy(); expect(next.body.events).toHaveLength(1);
  expect(next.body.summary).toMatchObject({ reason: 'invocation_finished', nextCursor: 3, outcome: 'completed' });
});

it('returns truthful deadlines and failed terminal outcomes', async () => {
  post(1, id, 'summary', 'failed');
  const failed = await call({ durationMs: 1000, invocationId: id, untilSummary: true });
  expect(failed.result.isError).toBe(true); expect(failed.body.summary).toMatchObject({ reason: 'invocation_finished', outcome: 'failed', nextCursor: 1 });
  const empty = await call({ durationMs: 10, after: 1 });
  expect(empty.result.isError).toBeFalsy(); expect(empty.body.summary).toMatchObject({ reason: 'deadline', delivered: 0, nextCursor: 1 });
});

it('returns an error with the unavailable summary', async () => {
  chmodSync(root, 0o755);
  const answer = await call({ durationMs: 100 });
  expect(answer.result.isError).toBe(true); expect(answer.body.summary.reason).toBe('unavailable');
});

it('isolates overlapping collectors', async () => {
  post(1, id, 'summary'); post(2, other, 'summary');
  const [a, b] = await Promise.all([call({ durationMs: 1000, invocationId: id, untilSummary: true }), call({ durationMs: 1000, invocationId: other, untilSummary: true })]);
  expect(a.body.events.map((e: { invocationId: string }) => e.invocationId)).toEqual([id]);
  expect(b.body.events.map((e: { invocationId: string }) => e.invocationId)).toEqual([other]);
});

it('does not report success when delivery or summary fails', async () => {
  vi.spyOn(follow, 'cmdFleetAppsFollow').mockResolvedValue(1);
  const answer = await call({ durationMs: 100 });
  expect(answer.result.isError).toBe(true); expect(answer.body).toMatchObject({ events: [], summary: null, exitCode: 1 });
});
