// Recut of #3306 (RQ-PHX-MCPFLEETVERBS04): the `ashlr fleet verbs` catalog
// exposed as the read-only native MCP tool phantom_fleet_verbs. The cases from
// the PR's own test/mcp-fleet-verbs-tool.test.ts are kept here verbatim in
// spirit, plus a parity check against the real CLI verb handler.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { FLEET_VERBS_MAX_GREP_CHARS, fleetVerbsCatalog } from '../src/core/fleet/fleet-verbs-tool.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { cmdFleetVerbs } from '../src/cli/fleet-verbs.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));

const name = 'phantom_fleet_verbs';
type Entry = { verb: string; usage: string | null; summary: string | null };
const matches = (word: string) => (entry: Entry) =>
  [entry.verb, entry.usage, entry.summary].some(value => value?.toLowerCase().includes(word));

function catalog(grep?: string) {
  const result = fleetVerbsCatalog(grep);
  if (!('verbs' in result)) throw new Error(`expected catalog, got ${result.error}`);
  return result;
}

async function cliJson(args: string[]): Promise<unknown> {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
  try {
    expect(await cmdFleetVerbs([...args, '--json'])).toBe(0);
  } finally {
    log.mockRestore();
  }
  return JSON.parse(lines.join('\n'));
}

afterEach(() => vi.restoreAllMocks());

describe('recut #3306: phantom_fleet_verbs native MCP tool', () => {
  it('is advertised as read-only with a closed, bounded schema', () => {
    expect(nativeToolSafety(name)).toBe('read');
    expect(listNativeTools().find(tool => tool.name === name)).toMatchObject({
      inputSchema: { type: 'object', additionalProperties: false,
        properties: { grep: { type: 'string', maxLength: FLEET_VERBS_MAX_GREP_CHARS } } },
    });
  });

  it('returns the full registered catalog with no grep', () => {
    const result = catalog();
    expect(result.schema).toBe('fleet.verbs.v1');
    expect(result.count).toBe(Object.keys(FLEET_SUBCOMMAND_LOADERS).length);
    expect(result.verbs).toHaveLength(result.count);
    expect(result.verbs.find(entry => entry.verb === 'needs')).toMatchObject({ usage: expect.anything() });
  });

  it('matches the `ashlr fleet verbs --json` CLI output exactly', async () => {
    expect(await cliJson([])).toEqual(catalog());
    expect(await cliJson(['--grep', 'needs'])).toEqual(catalog('needs'));
  });

  it('grep is trimmed, case-insensitive and only returns matching verbs', () => {
    const result = catalog('needs');
    expect(result.count).toBeGreaterThan(0);
    expect(result.count).toBe(result.verbs.length);
    expect(result.verbs.every(matches('needs'))).toBe(true);
    expect(catalog(' NEEDS ').verbs.map(entry => entry.verb)).toEqual(result.verbs.map(entry => entry.verb));
    expect(catalog('').count).toBe(catalog().count);
  });

  it('rejects a grep word longer than 64 characters and accepts exactly 64', () => {
    expect(fleetVerbsCatalog('x'.repeat(65))).toEqual({ error: `grep exceeds ${FLEET_VERBS_MAX_GREP_CHARS} characters` });
    expect(fleetVerbsCatalog('x'.repeat(64))).toMatchObject({ schema: 'fleet.verbs.v1', count: 0 });
  });

  it('never executes a verb: injected sources are read, loaders are not called', () => {
    const readSource = vi.fn((verb: string) => verb === 'alpha'
      ? "const USAGE = 'Usage: ashlr fleet alpha [--json]';\n"
      : null);
    const result = fleetVerbsCatalog('alpha', { verbs: ['alpha', 'beta'], readSource });
    expect(result).toMatchObject({ schema: 'fleet.verbs.v1', count: 1, verbs: [{ verb: 'alpha' }] });
    expect(readSource).toHaveBeenCalledWith('alpha');
  });

  it('round-trips through callNativeTool and refuses bad arguments', async () => {
    const ok = await callNativeTool(name, { grep: 'needs' });
    expect(ok.isError).toBeUndefined();
    const body = JSON.parse(ok.content[0].text) as { schema: string; verbs: Entry[] };
    expect(body.schema).toBe('fleet.verbs.v1');
    expect(body.verbs.map(entry => entry.verb)).toEqual(catalog('needs').verbs.map(entry => entry.verb));
    expect((await callNativeTool(name, {})).isError).toBeUndefined();
    for (const args of [{ grep: 'x'.repeat(65) }, { grep: 3 }, { root: '/fake' }, null, []]) {
      expect((await callNativeTool(name, args)).isError).toBe(true);
    }
  });
});
