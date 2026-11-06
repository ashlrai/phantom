import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));

const name = 'phantom_fleet_orders';
const citedText = 'ZZ-cited-order-body-text';
const uncitedText = 'ZZ-uncited-order-body-text';
const prUrl = 'https://github.com/example-org/example-repo/pull/1';
let home: string;
let runs: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orders-mcp-'));
  vi.stubEnv('HOME', home);
  runs = join(home, '.ashlr-runs');
  mkdirSync(join(runs, 'leader'), { recursive: true });
  mkdirSync(join(runs, 'metrics'), { recursive: true });
  writeFileSync(join(runs, 'leader', 'MASON-INBOX.md'),
    `## 2026-11-01 23:31 ET (Mason, Test) PRIORITY P0\n${citedText}\n\n## 2026-11-01 23:45 ET (Mason, Test) PRIORITY P0\n${uncitedText}\n`);
  writeFileSync(join(runs, 'RQ-PHX-FAKEJOB.prompt'), "Goal: Serve Mason's Nov 1 23:31 order\n");
  writeFileSync(join(runs, 'metrics', 'jobs.jsonl'),
    `${JSON.stringify({ event: 'publish', job: 'RQ-PHX-FAKEJOB', url: prUrl, ts: '2026-11-02T00:00:00.000Z' })}\n`);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const call = async (args: unknown) => {
  const result = await callNativeTool(name, args);
  return { result, text: result.content[0].text };
};

describe('native MCP fleet orders', () => {
  it('is advertised as read-only with a closed schema', () => {
    expect(nativeToolSafety(name)).toBe('read');
    expect(listNativeTools().find(tool => tool.name === name)).toMatchObject({
      inputSchema: { type: 'object', additionalProperties: false,
        properties: { unservedOnly: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 100 } } },
    });
  });

  it('lists both orders newest first with the citing job and the unserved count', async () => {
    const { result, text } = await call({});
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(text);
    expect(body).toMatchObject({ v: 1, unserved: 1, sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' } });
    expect(body.orders.map((o: { key: string }) => o.key)).toEqual(['11-01 23:45', '11-01 23:31']);
    expect(body.orders[0].jobs).toEqual([]);
    expect(body.orders[1].jobs).toEqual([{ id: 'RQ-PHX-FAKEJOB', lane: null, state: 'published', url: prUrl }]);
  });

  it('unservedOnly returns only the uncited order, still counting all unserved', async () => {
    const body = JSON.parse((await call({ unservedOnly: true })).text);
    expect(body.orders.map((o: { key: string }) => o.key)).toEqual(['11-01 23:45']);
    expect(body.unserved).toBe(1);
  });

  it('limit keeps the newest orders', async () => {
    const body = JSON.parse((await call({ limit: 1 })).text);
    expect(body.orders.map((o: { key: string }) => o.key)).toEqual(['11-01 23:45']);
    expect(body.unserved).toBe(1);
  });

  it.each([{ extra: 1 }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '5' }, { unservedOnly: 'yes' }, [], null])(
    'rejects invalid arguments %j through the call path', async args => {
      const { result, text } = await call(args === null ? 'bad' : args);
      expect(result.isError).toBe(true);
      expect(text).toContain('invalid orders arguments');
    });

  it('flags missing sources without throwing when the runs dir is absent', async () => {
    rmSync(runs, { recursive: true, force: true });
    const { result, text } = await call({});
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text)).toMatchObject({ orders: [], unserved: 0, sources: { inbox: 'missing', prompts: 'missing', publishes: 'missing' } });
  });

  it('never returns inbox order text or prompt text', async () => {
    const { text } = await call({});
    for (const secret of [citedText, uncitedText, "Goal: Serve Mason's"]) expect(text).not.toContain(secret);
  });
});
