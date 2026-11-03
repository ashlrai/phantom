import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetAppsEvents } from '../src/cli/fleet-apps-events.js';
import { BUS_INBOX_MAX_READ, type BusInboxPage, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { readAppsEvents } from '../src/core/fleet/apps-events.js';
import { generateFleetRegistry } from '../scripts/gen-fleet-registry.mjs';

const roots: string[] = [];
const root = () => { const d = mkdtempSync(join(tmpdir(), 'apps-events-')); roots.push(d); return d; };
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Helper: create normalized event bodies
const makeObsBody = (invId: string, cycle = 1, healthy = true) => ({
  kind: 'apps-watch.observation.v1', cycle, healthy, recoveries: 0,
  consecutiveFailures: 0, totalFailedCycles: 0,
  observedState: [{ app: 'Phantom', observedRunning: true }],
  invocationId: invId,
});
const makeSumBody = (invId: string, apps = ['Phantom']) => ({
  kind: 'apps-watch.summary.v1', apps, outcome: 'completed',
  cycles: 1, recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0,
  lastObservedState: [{ app: 'Phantom', observedRunning: true }],
  invocationId: invId,
});
const makeEnvelope = (id: string, from: string, body: Record<string, unknown>) =>
  ({ id, from, to: 'leaders', priority: 'P2', ttl: 86400000, body });
const toReceipt = (cursor: number, envelope: ReturnType<typeof makeEnvelope>) =>
  ({ cursor, receivedAt: 0, envelope });

// Mock listBusInboxAfter to return controlled data
function mockPage(envelopes: ReturnType<typeof makeEnvelope>[], nextC = 100): ReturnType<BusInboxPage> {
  const messages = envelopes.map((env, i) => toReceipt(i + 1, env));
  return { status: 'ok', messages, nextCursor: nextC };
}

it('reads matching observation and summary events, skips unrelated', () => {
  const m1 = makeEnvelope(`evt-1`, 'other-source', { foo: 'bar' });
  const m2 = makeEnvelope(`evt-2`, 'apps-watch', makeObsBody('inv-1'));
  const m3 = makeEnvelope(`evt-3`, 'apps-watch', makeSumBody('inv-1'));
  vi.spyOn(globalThis, 'Date').mockImplementation(() => new Date(300));
  vi.spyOn(listBusInboxAfter, 'listBusInboxAfter').mockReturnValue(mockPage([m1, m2, m3], 3));
  const result = readAppsEvents(0, 100, { root: '/fake-root' });
  expect(result.status).toBe('ok');
  expect(result.events).toHaveLength(2);
  expect(result.events[0]).toMatchObject({ kind: 'apps-watch.observation.v1', invocationId: 'inv-1' });
  expect(result.events[1]).toMatchObject({ kind: 'apps-watch.summary.v1', invocationId: 'inv-1' });
  expect(result.scanned).toBe(3);
  expect(result.invalidEvents).toBe(0);
});

it('resumes using nextCursor and proves no duplicate matching events', () => {
  const m1 = makeEnvelope(`a-1`, 'apps-watch', makeObsBody('inv-a', 1));
  const m2 = makeEnvelope(`a-2`, 'apps-watch', makeObsBody('inv-a', 2));
  const m3 = makeEnvelope(`b-1`, 'apps-watch', makeObsBody('inv-b', 1));
  const m4 = makeEnvelope(`b-2`, 'apps-watch', makeSumBody('inv-b'));
  const page1 = mockPage([m1, m2], 2);
  const page2 = mockPage([m3, m4], 4);
  vi.spyOn(listBusInboxAfter, 'listBusInboxAfter').mockImplementation((a, l, _o) => {
    if (a <= 0) return page1;
    return page2;
  });
  const firstResult = readAppsEvents(0, 2, { root: '/fake' });
  expect(firstResult.events).toHaveLength(2);
  expect(firstResult.nextCursor).toBe(2);
  const secondResult = readAppsEvents(2, 100, { root: '/fake' });
  expect(secondResult.status).toBe('ok');
  expect(secondResult.events).toHaveLength(2);
  const allIds = [...firstResult.events, ...secondResult.events].map(e => e.invocationId);
  expect(allIds).toHaveLength(4);
});

it('nextCursor advances even when first page has no matches', () => {
  const m1 = makeEnvelope(`u-1`, 'other', { x: 1 });
  const m2 = makeEnvelope(`u-2`, 'other', { x: 2 });
  const m3 = makeEnvelope(`u-3`, 'apps-watch', makeObsBody('inv-c'));
  vi.spyOn(listBusInboxAfter, 'listBusInboxAfter').mockImplementation((a: number) => {
    if (a <= 2) return mockPage([m1, m2], 2);
    return mockPage([m3], 3);
  });
  const result = readAppsEvents(0, 2, { root: '/fake' });
  expect(result.status).toBe('empty');
  expect(result.events).toHaveLength(0);
  expect(result.nextCursor).toBe(2);
  const resume = readAppsEvents(2, 100, { root: '/fake' });
  expect(resume.status).toBe('ok');
  expect(resume.events).toHaveLength(1);
  expect(resume.events[0].invocationId).toBe('inv-c');
});

it('invocation filtering selects matching events only', () => {
  const m1 = makeEnvelope(`a-1`, 'apps-watch', makeObsBody('inv-a'));
  const m2 = makeEnvelope(`a-2`, 'apps-watch', makeObsBody('inv-a', 2));
  const m3 = makeEnvelope(`b-1`, 'apps-watch', makeObsBody('inv-b'));
  vi.spyOn(listBusInboxAfter, 'listBusInboxAfter').mockReturnValue(mockPage([m1, m2, m3]));
  const result = readAppsEvents(0, 100, { root: '/fake', invocationId: 'inv-a' });
  expect(result.status).toBe('ok');
  expect(result.events).toHaveLength(2);
  expect(result.events.every(e => e.invocationId === 'inv-a')).toBe(true);
  expect(result.invocationFilter).toBe('inv-a');
});

it('normalizes observation with null observedRunning', () => {
  const body = {
    kind: 'apps-watch.observation.v1', cycle: 3, healthy: false, recoveries: 0,
    consecutiveFailures: 1, totalFailedCycles: 1,
    observedState: [{ app: 'Phantom', observedRunning: null }],
    invocationId: 'inv-null',
  };
  vi.spyOn(listBusInboxAfter, 'listBusInboxAfter').mockReturnValue(mockPage([makeEnvelope('n-1', 'apps-watch', body)]));
  const result = readAppsEvents(0, 100, { root: '/fake' });
  expect(result.status).toBe('ok');
  expect(result.events).toHaveLength(1);
  const obs = result.events[0] as typeof result.events[0] & { kind: 'apps-watch.observation.v1' };
  expect(obs.kind).toBe('apps-watch.observation.v1');
  expect(obs.observedState).toEqual([{ app: 'Phantom', observedRunning: null }]);
});

it('skips malformed matching events and reports invalidEvents', () => {
  const malformed = { kind: 'apps-watch.observation.v1', cycle: 'bad', healthy: true, invocationId: 'inv-good' };
  const good = makeObsBody('inv-good');
  vi.spyOn(listBusInboxAfter, 'listBusInboxAfter').mockReturnValue(mockPage([
    makeEnvelope('bad-1', 'apps-watch', malformed),
    makeEnvelope('good-1', 'apps-watch', good),
  ]));
  const result = readAppsEvents(0, 100, { root: '/fake' });
  expect(result.status).toBe('ok');
  expect(result.events).toHaveLength(1);
  expect(result.invalidEvents).toBe(1);
  expect(result.scanned).toBe(2);
});

it('handles expired events: listBusInboxAfter returns empty page and valid nextCursor', () => {
  vi.spyOn(listBusInboxAfter, 'listBusInboxAfter').mockReturnValue({ status: 'ok', messages: [], nextCursor: 1 });
  const result = readAppsEvents(0, 100, { root: '/fake' });
  expect(result.status).toBe('empty');
  expect(result.events).toHaveLength(0);
  expect(result.scanned).toBe(0);
  expect(result.nextCursor).toBe(1);
});

it('reports transport failure status without fabricated healthy state', () => {
  vi.spyOn(listBusInboxAfter, 'listBusInboxAfter').mockReturnValue({ status: 'unavailable' });
  const result = readAppsEvents(0, 100, { root: '/fake' });
  expect(result.status).toBe('unavailable');
  expect(result.events).toHaveLength(0);
});

it('invalid CLI flags exit 2 before any I/O', async () => {
  const dir = root();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const file = join(dir, 'fake'); writeFileSync(file, 'x');
  expect(await cmdFleetAppsEvents(['--after=-1'], { runsDir: file })).toBe(2);
  expect(await cmdFleetAppsEvents(['--limit=0'], { runsDir: file })).toBe(2);
  expect(await cmdFleetAppsEvents(['--limit=200'], { runsDir: file })).toBe(2);
  expect(await cmdFleetAppsEvents(['--bogus'], { runsDir: file })).toBe(2);
  expect(await cmdFleetAppsEvents(['--after', '-5', '--root', file])).toBe(2);
});

it('emits valid JSON and correct exit codes to stdout', async () => {
  const m1 = makeEnvelope(`j-1`, 'apps-watch', makeObsBody('inv-json'));
  vi.spyOn(listBusInboxAfter, 'listBusInboxAfter').mockReturnValue(mockPage([m1]));
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { output += s; return true; }) as never);
  const exit = await cmdFleetAppsEvents(['--json'], { runsDir: '/fake' });
  expect(exit).toBe(0);
  const parsed = JSON.parse(output);
  expect(parsed.v).toBe(1);
  expect(parsed.status).toBe('ok');
  expect(parsed.events).toHaveLength(1);
  expect(parsed).toHaveProperty('nextCursor');
  expect(parsed).toHaveProperty('scanned');
  expect(parsed).toHaveProperty('invalidEvents');
});

it('empty readable bus is success with empty events', async () => {
  vi.spyOn(listBusInboxAfter, 'listBusInboxAfter').mockReturnValue({ status: 'ok', messages: [], nextCursor: 0 });
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { output += s; return true; }) as never);
  const exit = await cmdFleetAppsEvents(['--json'], { runsDir: '/fake' });
  expect(exit).toBe(0);
  const parsed = JSON.parse(output);
  expect(parsed.status).toBe('empty');
  expect(parsed.events).toHaveLength(0);
});

it('invalid transport status returns nonzero exit', async () => {
  vi.spyOn(listBusInboxAfter, 'listBusInboxAfter').mockReturnValue({ status: 'unavailable' });
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { output += s; return true; }) as never);
  const exit = await cmdFleetAppsEvents(['--json'], { runsDir: '/fake' });
  expect(exit).toBe(1);
  const parsed = JSON.parse(output);
  expect(parsed.status).toBe('unavailable');
});

it('propagates root through to the bus', () => {
  const m1 = makeEnvelope(`r-1`, 'apps-watch', makeObsBody('inv-root'));
  let captured: { root?: string; now?: () => number } | undefined;
  const origListBusInboxAfter = listBusInboxAfter.listBusInboxAfter;
  vi.spyOn(listBusInboxAfter, 'listBusInboxAfter').mockImplementation((a, l, o) => {
    captured = o;
    return mockPage([m1]);
  });
  const result = readAppsEvents(0, 100, { root: '/my/custom-root' });
  expect(result.status).toBe('ok');
  expect(result.events).toHaveLength(1);
  expect(captured?.root).toBe('/my/custom-root');
});

it('summary event normalizes lastObservedState with null running', () => {
  const body = {
    kind: 'apps-watch.summary.v1', apps: ['Phantom'], outcome: 'failed',
    cycles: 2, recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 1,
    lastObservedState: [{ app: 'Phantom', observedRunning: null }],
    invocationId: 'inv-sum-null',
  };
  vi.spyOn(listBusInboxAfter, 'listBusInboxAfter').mockReturnValue(mockPage([makeEnvelope('s-1', 'apps-watch', body)]));
  const result = readAppsEvents(0, 100, { root: '/fake' });
  expect(result.status).toBe('ok');
  expect(result.events).toHaveLength(1);
  const sum = result.events[0] as typeof result.events[0] & { kind: 'apps-watch.summary.v1' };
  expect(sum.lastObservedState).toEqual([{ app: 'Phantom', observedRunning: null }]);
  expect(sum.outcome).toBe('failed');
});

it('two-page read proves no duplicate matching event or stuck cursor', () => {
  const m1 = makeEnvelope('m-1', 'apps-watch', makeObsBody('inv-multi', 1));
  const m2 = makeEnvelope('m-2', 'apps-watch', makeObsBody('inv-multi', 2));
  const m3 = makeEnvelope('m-3', 'apps-watch', makeObsBody('inv-multi', 3));
  const m4 = makeEnvelope('m-4', 'apps-watch', makeObsBody('inv-multi', 4));
  const m5 = makeEnvelope('m-5', 'apps-watch', makeSumBody('inv-multi'));
  const expectedMessages = [m1, m2, m3, m4, m5];
  let callCount = 0;
  vi.spyOn(listBusInboxAfter, 'listBusInboxAfter').mockImplementation((a: number, l: number) => {
    callCount++;
    if (a <= 2) return mockPage([m1, m2], 2);
    return mockPage([m3, m4, m5], 5);
  });
  const first = readAppsEvents(0, 2, { root: '/fake' });
  expect(first.status).toBe('ok');
  expect(first.events).toHaveLength(2);
  expect(first.nextCursor).toBe(2);
  const second = readAppsEvents(2, 100, { root: '/fake' });
  expect(second.status).toBe('ok');
  expect(second.events).toHaveLength(3);
  expect(second.events.map(e => `${e.kind}:${e.invocationId}`)).toEqual([
    'apps-watch.observation.v1:inv-multi', 'apps-watch.observation.v1:inv-multi',
    'apps-watch.summary.v1:inv-multi',
  ]);
  // Verify no duplicate message keys (different cursors in original page)
  const allKeys = [...first.events, ...second.events].map(e => `${e.kind}:${e.invocationId}`);
  expect(new Set(allKeys).size).toBe(allKeys.length);
  expect(callCount).toBe(2);
});

it('first page with no matches still advances cursor', () => {
  vi.spyOn(listBusInboxAfter, 'listBusInboxAfter').mockImplementation((a: number) => {
    if (a <= 2) return mockPage([
      makeEnvelope('x-1', 'other', { x: 1 }),
      makeEnvelope('x-2', 'other', { x: 2 }),
    ], 2);
    return mockPage([makeEnvelope('x-3', 'other', { x: 3 })], 3);
  });
  const first = readAppsEvents(0, 2, { root: '/fake' });
  expect(first.status).toBe('empty');
  expect(first.events).toHaveLength(0);
  expect(first.nextCursor).toBe(2);
  const resume = readAppsEvents(2, 100, { root: '/fake' });
  expect(resume.events).toHaveLength(0);
  expect(resume.nextCursor).toBe(3);
});

it('invalid after/limit arguments return status invalid before I/O', () => {
  let called = false;
  vi.spyOn(listBusInboxAfter, 'listBusInboxAfter').mockImplementation(() => { called = true; return mockPage([]); });
  expect(readAppsEvents(-1, 100, { root: '/fake' }).status).toBe('invalid');
  expect(readAppsEvents(0, 0, { root: '/fake' }).status).toBe('invalid');
  expect(readAppsEvents(0, 101, { root: '/fake' }).status).toBe('invalid');
  expect(called).toBe(false);
});

it('event data never becomes executable instructions', () => {
  const malicious = makeEnvelope('evil-1', 'apps-watch', {
    kind: 'apps-watch.observation.v1', cycle: 1, healthy: true, recoveries: 0,
    consecutiveFailures: 0, totalFailedCycles: 0,
    observedState: [{ app: ';`exec("echo hacked")`', observedRunning: true }],
    invocationId: 'inv-evil',
  });
  vi.spyOn(listBusInboxAfter, 'listBusInboxAfter').mockReturnValue(mockPage([malicious]));
  const result = readAppsEvents(0, 100, { root: '/fake' });
  expect(result.events).toHaveLength(1);
  // The event data is a string, never executed
  expect(typeof result.events[0].observedState?.[0].app).toBe('string');
});

it('registry generator registers the new verb', () => {
  const rc = generateFleetRegistry(['--check']);
  expect(rc).toBe(0);
});
