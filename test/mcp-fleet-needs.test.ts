import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));

const name = 'phantom_fleet_needs';
const id = (text: string) => `nm-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
const texts = ['Approve fake device sign-in', 'Choose example project name'];
const items = texts.map(text => ({ id: id(text), text }));
let runs: string;

beforeEach(() => {
  runs = mkdtempSync(join(tmpdir(), 'needs-mcp-'));
  vi.stubEnv('ASHLR_RUNS_DIR', runs);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(runs, { recursive: true, force: true });
});

function fixture() {
  const done = 'Completed fake request';
  writeFileSync(join(runs, 'NEEDS-MASON.md'),
    `# Needs Mason\n${texts.map(text => `- [ ] ${text}`).join('\n')}\n- ${done}\n- [x] resolved ${id(done)}\n`);
}

async function read(args: unknown = {}) {
  const result = await callNativeTool(name, args);
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]!.text);
}

describe('native MCP fleet needs', () => {
  it('lists open ids and texts, excluding resolved items', async () => {
    fixture();
    expect(await read()).toEqual({ v: 1, count: 2, items });
  });

  it('limits items while counting all open items', async () => {
    fixture();
    expect(await read({ limit: 1 })).toEqual({ v: 1, count: 2, items: items.slice(0, 1) });
  });

  it('defaults to 20 items and accepts the maximum limit', async () => {
    const many = Array.from({ length: 51 }, (_, i) => `Example request ${i}`);
    writeFileSync(join(runs, 'NEEDS-MASON.md'), many.map(text => `- ${text}`).join('\n'));
    const expected = many.map(text => ({ id: id(text), text }));
    expect(await read()).toEqual({ v: 1, count: 51, items: expected.slice(0, 20) });
    expect(await read({ limit: 50 })).toEqual({ v: 1, count: 51, items: expected.slice(0, 50) });
  });

  it('returns an empty observation for a missing file', async () => {
    expect(await read()).toEqual({ v: 1, count: 0, items: [] });
  });

  it('returns an empty observation for an unreadable source', async () => {
    mkdirSync(join(runs, 'NEEDS-MASON.md'));
    expect(await read()).toEqual({ v: 1, count: 0, items: [] });
  });

  it.each([{ limit: 0 }, { limit: 51 }, { extra: true }, 'bad', null, [], { limit: 1.5 }, { limit: '1' }])(
    'refuses invalid arguments %j', async args => {
      const result = await callNativeTool(name, args);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('Invalid arguments');
    });

  it('is listed with a read-only description and closed schema', () => {
    expect(nativeToolSafety(name)).toBe('read');
    expect(listNativeTools().find(tool => tool.name === name)).toMatchObject({
      description: expect.stringContaining('Read-only'),
      inputSchema: { type: 'object', additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } } },
    });
  });
});
