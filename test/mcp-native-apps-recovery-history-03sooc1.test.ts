import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as history from '../src/core/fleet/apps-recovery-history.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';

const name = 'phantom_fleet_apps_history';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const originalRoot = process.env.ASHLR_RUNS_DIR;
const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'apps-history-'));
  roots.push(dir);
  process.env.ASHLR_RUNS_DIR = dir;
  return dir;
}
async function call(args: unknown) {
  const result = await callNativeTool(name, args);
  return { result, data: JSON.parse(result.content[0]!.text) };
}
afterEach(() => {
  vi.restoreAllMocks();
  if (originalRoot === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = originalRoot;
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('native app recovery history', () => {
  it('advertises a closed read-only schema and rejects invalid input before reading', async () => {
    const schema = listNativeTools().find(tool => tool.name === name)?.inputSchema;
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false, properties: {
      after: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 }, invocationId: { type: 'string' },
    } });
    expect(nativeToolSafety(name)).toBe('read');
    const reader = vi.spyOn(history, 'readAppsRecoveryHistory');
    for (const args of [null, [], 'x', { root: '/fake' }, { after: null }, { after: -1 },
      { after: 1.5 }, { after: Number.MAX_SAFE_INTEGER + 1 }, { after: NaN }, { after: '1' },
      { limit: null }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: Infinity },
      { invocationId: null }, { invocationId: 1 }, { invocationId: 'aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa' },
      { invocationId: 'aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa' }, { invocationId: id + 'x' }]) {
      expect((await callNativeTool(name, args)).isError).toBe(true);
    }
    expect(reader).not.toHaveBeenCalled();
  });

  it('maps defaults and explicit arguments to the reader', async () => {
    const dir = root();
    const reader = vi.spyOn(history, 'readAppsRecoveryHistory');
    await call({});
    expect(reader).toHaveBeenLastCalledWith(dir, 0, 25, undefined);
    await call({ after: 7, limit: 100, invocationId: id });
    expect(reader).toHaveBeenLastCalledWith(dir, 7, 100, id);
  });

  it('reads retained observations and summaries, filtering and paginating without writes', async () => {
    const dir = root();
    const common = { recoveries: 1, consecutiveFailures: 0, totalFailedCycles: 1 };
    const observation = { kind: 'apps-watch.observation.v1', invocationId: id, ...common,
      cycle: 1, healthy: false, observedState: [{ app: 'Phantom', observedRunning: false }] };
    const summary = { kind: 'apps-watch.summary.v1', invocationId: id, ...common,
      apps: ['Phantom'], outcome: 'completed', cycles: 1, lastObservedState: null };
    for (const [index, body] of [observation, { ...observation, invocationId: other }, summary].entries()) {
      expect(appendBusInbox({ id: `fake-${index}`, from: 'apps-watch', to: 'leaders', priority: 'P1', ttl: 120000, body }, { root: dir }).status).toBe('posted');
    }
    const stdout = vi.spyOn(process.stdout, 'write');
    const first = await call({ limit: 1, invocationId: id });
    expect(first.data).toMatchObject({ v: 1, availability: 'available', nextCursor: 1, hasMore: true,
      events: [{ cursor: 1, invocationId: id, kind: 'apps-watch.observation.v1', healthy: false }] });
    const second = await call({ after: first.data.nextCursor, limit: 2, invocationId: id });
    expect(second.data).toMatchObject({ v: 1, availability: 'available', nextCursor: 3, hasMore: false,
      events: [{ cursor: 3, invocationId: id, kind: 'apps-watch.summary.v1', outcome: 'completed' }] });
    expect(stdout).not.toHaveBeenCalled();
    expect((await call({ after: 4 })).data).toEqual({ v: 1, availability: 'invalid-cursor', events: [], nextCursor: 4, hasMore: false });
    chmodSync(dir, 0o755);
    expect((await call({})).data).toEqual({ v: 1, availability: 'unavailable', events: [], nextCursor: 0, hasMore: false });
  });

  it('sanitizes unexpected reader failures', async () => {
    vi.spyOn(history, 'readAppsRecoveryHistory').mockImplementation(() => { throw new Error('/private/path raw stderr'); });
    const { result, data } = await call({});
    expect(result.isError).toBe(true);
    expect(data).toEqual({ error: 'Fleet observation unavailable' });
  });
});
