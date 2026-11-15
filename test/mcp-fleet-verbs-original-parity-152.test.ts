// Preserves the unique assertions of #5058's recut-range-3300-3599 (#3306 recut)
// not already in mcp-fleet-verbs-tool.test.ts: real CLI <-> native MCP parity,
// injected-source lookup without verb execution, and callNativeTool grep parity.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callNativeTool } from '../src/core/mcp-native.js';
import { fleetVerbsCatalog } from '../src/core/fleet/fleet-verbs-tool.js';
import { cmdFleetVerbs } from '../src/cli/fleet-verbs.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));

const name = 'phantom_fleet_verbs';

async function cli(args: string[], deps?: Parameters<typeof cmdFleetVerbs>[1]) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((l: unknown) => { out.push(String(l)); });
  vi.spyOn(console, 'error').mockImplementation((l: unknown) => { err.push(String(l)); });
  const code = await cmdFleetVerbs(args, deps);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function mcp(args: unknown) {
  const res = await callNativeTool(name, args);
  return { isError: res.isError, text: res.content[0].text };
}

/** Parsed MCP body; only valid for results under the native output cap (filtered calls). */
const mcpBody = async (args: unknown) => JSON.parse((await mcp(args)).text);

function catalog(grep?: string) {
  const result = fleetVerbsCatalog(grep);
  if (!('verbs' in result)) throw new Error(`expected catalog, got ${result.error}`);
  return result;
}

afterEach(() => vi.restoreAllMocks());

describe('fleet verbs: CLI/MCP parity (preserved from #5058)', () => {
  it('CLI --json equals the native tool catalog, unfiltered and with grep', async () => {
    // The unfiltered MCP text exceeds the native output cap, so the unfiltered
    // comparison uses the catalog function that backs the tool (as the source did)
    // and the MCP call is only checked to succeed and to carry the same schema.
    const unfiltered = await cli(['--json']);
    expect(unfiltered.code).toBe(0);
    expect(JSON.parse(unfiltered.out)).toEqual(catalog());
    const full = await mcp({});
    expect(full.isError).toBeUndefined();
    expect(full.text).toContain('fleet.verbs.v1');

    const filtered = await cli(['--grep', 'needs', '--json']);
    expect(filtered.code).toBe(0);
    expect(JSON.parse(filtered.out)).toEqual(await mcpBody({ grep: 'needs' }));
    expect(catalog('needs').count).toBeGreaterThan(0);
    expect(catalog('needs').count).toBeLessThan(catalog().count);
  });

  it('empty grep equals the unfiltered catalog; padded/uppercase grep matches the CLI', async () => {
    expect(catalog('')).toEqual(catalog());
    const padded = await mcpBody({ grep: ' NEEDS ' });
    expect(padded).toEqual(await mcpBody({ grep: 'needs' }));
    expect(JSON.parse((await cli(['--grep', 'NEEDS', '--json'])).out)).toEqual(padded);
  });

  it('rejects malformed input on both surfaces without producing a catalog', async () => {
    const bad = await cli(['--bogus', '--json']);
    expect(bad.code).toBe(2);
    expect(bad.out).toBe('');
    expect(bad.err).toContain('Usage: ashlr fleet verbs');
    for (const args of [{ grep: 'x'.repeat(65) }, { grep: 3 }, { root: '/fake' }, null, []]) {
      const m = await mcp(args);
      expect(m.isError).toBe(true);
    }
  });

  it('observation only: injected sources are read, nothing else is invoked, on both surfaces', async () => {
    const source = (verb: string) => verb === 'alpha' ? "const USAGE = 'Usage: ashlr fleet alpha [--json]';\n" : null;
    const readSource = vi.fn(source);
    const result = fleetVerbsCatalog('alpha', { verbs: ['alpha', 'beta'], readSource });
    expect(result).toMatchObject({ schema: 'fleet.verbs.v1', count: 1, verbs: [{ verb: 'alpha' }] });
    expect(readSource).toHaveBeenCalledWith('alpha');
    expect(readSource).toHaveBeenCalledWith('beta');
    const c = await cli(['--grep', 'alpha', '--json'], { verbs: ['alpha', 'beta'], readSource: vi.fn(source) });
    expect(JSON.parse(c.out)).toEqual(result);
  });
});
