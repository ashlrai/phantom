// Evidence for the RQ-PHX-RECUTCOREOLDC161 bridge: #3231 (RQ-PHX-MCPFLEETNEEDS03)
// added the read-only `phantom_fleet_needs` native MCP tool. Master's evolved
// reader returns { v, status, count, items }; this test asserts the behavior the
// PR added — open Needs-you items listed by id/text, resolved items excluded,
// `limit` caps items while count covers every open item.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));

const name = 'phantom_fleet_needs';
const id = (text: string) => `nm-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
const texts = ['Approve fake device sign-in', 'Choose example project name'];
let runs: string;

beforeEach(() => {
  runs = mkdtempSync(join(tmpdir(), 'recut-coreold-c161-'));
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
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe('phantom_fleet_needs on master (recut evidence for #3231)', () => {
  it('lists open item ids and texts, excluding resolved items', async () => {
    fixture();
    expect(await read()).toMatchObject({
      v: 1,
      count: 2,
      items: texts.map(text => ({ id: id(text), text })),
    });
  });

  it('caps items at limit while count covers every open item', async () => {
    fixture();
    expect(await read({ limit: 1 })).toMatchObject({
      v: 1,
      count: 2,
      items: [{ id: id(texts[0]!), text: texts[0] }],
    });
  });

  it('stays read-only with the closed limit schema the PR specified', () => {
    expect(nativeToolSafety(name)).toBe('read');
    expect(listNativeTools().find(tool => tool.name === name)).toMatchObject({
      inputSchema: { type: 'object', additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } } },
    });
  });
});
