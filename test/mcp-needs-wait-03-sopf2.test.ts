import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as waitModule from '../src/core/fleet/needs-mason-wait.js';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';

const name = 'phantom_fleet_needs_wait';
const item = 'Approve the fake deploy';
const itemId = `nm-${createHash('sha256').update(item).digest('hex').slice(0, 12)}`;
let root: string;
let previousRoot: string | undefined;
let listeners: [number, number];
const result = async (args: unknown) => {
  const response = await callNativeTool(name, args);
  expect(response.isError).toBeUndefined();
  return JSON.parse(response.content[0]!.text);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcp-needs-wait-'));
  previousRoot = process.env.ASHLR_RUNS_DIR;
  process.env.ASHLR_RUNS_DIR = root;
  listeners = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
});
afterEach(() => {
  expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(listeners);
  if (previousRoot === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = previousRoot;
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('native needs wait', () => {
  it('advertises the closed schema and read safety', () => {
    expect(listNativeTools().find(tool => tool.name === name)?.inputSchema).toEqual({
      type: 'object', properties: {
        itemId: { type: 'string', pattern: '^nm-[0-9a-f]{12}$' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 30000 },
        pollMs: { type: 'integer', minimum: 100, maximum: 30000, default: 1000 },
      }, required: ['itemId', 'timeoutMs'], additionalProperties: false,
    });
    expect(nativeToolSafety(name)).toBe('read');
  });

  it('rejects invalid arguments before reaching the helper', async () => {
    const spy = vi.spyOn(waitModule, 'waitNeedsMason');
    for (const args of [null, [], {}, { itemId }, { itemId, timeoutMs: 0 },
      { itemId, timeoutMs: 30001 }, { itemId, timeoutMs: 1.5 }, { itemId, timeoutMs: null },
      { itemId: 'nm-ABCDEF123456', timeoutMs: 1 }, { itemId: `${itemId}x`, timeoutMs: 1 },
      { itemId, timeoutMs: 1, pollMs: 99 }, { itemId, timeoutMs: 1, pollMs: 30001 },
      { itemId, timeoutMs: 1, pollMs: null }, { itemId, timeoutMs: 1, pollMs: 100.5 },
      { itemId, timeoutMs: 1, runsDir: root }]) {
      expect((await callNativeTool(name, args)).isError).toBe(true);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports resolved and unknown from the configured temporary ledger', async () => {
    writeFileSync(join(root, 'NEEDS-MASON.md'), `- [x] resolved ${itemId} timestamp\n`);
    expect(await result({ itemId, timeoutMs: 100 })).toEqual({ itemId, status: 'resolved' });
    expect(await result({ itemId: 'nm-000000000000', timeoutMs: 100, pollMs: 100 }))
      .toEqual({ itemId: 'nm-000000000000', status: 'unknown' });
  });

  it('reports timeout for an open item and unavailable for a missing ledger', async () => {
    const file = join(root, 'NEEDS-MASON.md');
    writeFileSync(file, `- [ ] ${item}\n`);
    expect(await result({ itemId, timeoutMs: 5, pollMs: 100 })).toEqual({ itemId, status: 'timeout' });
    rmSync(file);
    expect(await result({ itemId, timeoutMs: 5 })).toEqual({ itemId, status: 'unavailable' });
  });

  it('preserves helper cancellation and uses the default poll interval', async () => {
    const spy = vi.spyOn(waitModule, 'waitNeedsMason').mockResolvedValue('cancelled');
    expect(await result({ itemId, timeoutMs: 10 })).toEqual({ itemId, status: 'cancelled' });
    expect(spy).toHaveBeenCalledWith({ id: itemId, timeoutMs: 10, pollMs: 1000 });
    const controller = new AbortController();
    controller.abort();
    spy.mockRestore();
    expect(await waitModule.waitNeedsMason({ id: itemId, timeoutMs: 10, pollMs: 100,
      runsDir: root, signal: controller.signal })).toBe('cancelled');
  });
});
