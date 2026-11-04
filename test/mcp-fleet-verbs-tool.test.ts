import { describe, expect, it, vi } from 'vitest';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { FLEET_VERBS_MAX_GREP_CHARS, fleetVerbsCatalog } from '../src/core/fleet/fleet-verbs-tool.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));

const name = 'phantom_fleet_verbs';
const matches = (word: string) => (entry: { verb: string; usage: string | null; summary: string | null }) =>
  [entry.verb, entry.usage, entry.summary].some(value => value?.toLowerCase().includes(word));

describe('native MCP fleet verbs', () => {
  it('is advertised as read-only with a closed schema', () => {
    expect(nativeToolSafety(name)).toBe('read');
    expect(listNativeTools().find(tool => tool.name === name)).toMatchObject({
      inputSchema: { type: 'object', additionalProperties: false,
        properties: { grep: { type: 'string', maxLength: FLEET_VERBS_MAX_GREP_CHARS } } },
    });
  });

  it('returns the full registered catalog with no grep', () => {
    const result = fleetVerbsCatalog();
    expect(result).not.toHaveProperty('error');
    if (!('verbs' in result)) throw new Error('expected catalog');
    expect(result.schema).toBe('fleet.verbs.v1');
    expect(result.count).toBe(Object.keys(FLEET_SUBCOMMAND_LOADERS).length);
    expect(result.verbs).toHaveLength(result.count);
    expect(result.verbs.map(entry => entry.verb)).toContain('needs');
    expect(result.verbs.find(entry => entry.verb === 'needs')).toMatchObject({ usage: expect.anything() });
  });

  it('grep returns only matching verbs, same as the CLI filter', () => {
    const result = fleetVerbsCatalog('needs');
    if (!('verbs' in result)) throw new Error('expected catalog');
    expect(result.count).toBeGreaterThan(0);
    expect(result.count).toBe(result.verbs.length);
    expect(result.verbs.every(matches('needs'))).toBe(true);
    expect(result.verbs.map(entry => entry.verb)).toContain('needs');
    // Trimming + case: ' NEEDS ' selects the same set.
    const padded = fleetVerbsCatalog(' NEEDS ');
    if (!('verbs' in padded)) throw new Error('expected catalog');
    expect(padded.verbs.map(entry => entry.verb)).toEqual(result.verbs.map(entry => entry.verb));
  });

  it('rejects a grep word longer than 64 chars, accepts exactly 64', () => {
    expect(fleetVerbsCatalog('x'.repeat(65))).toEqual({ error: `grep exceeds ${FLEET_VERBS_MAX_GREP_CHARS} characters` });
    expect(fleetVerbsCatalog('x'.repeat(64))).toMatchObject({ schema: 'fleet.verbs.v1', count: 0 });
  });

  it('round-trips through callNativeTool and refuses bad arguments', async () => {
    const ok = await callNativeTool(name, { grep: 'verbs' });
    expect(ok.isError).toBeUndefined();
    const body = JSON.parse(ok.content[0].text);
    expect(body.verbs.map((entry: { verb: string }) => entry.verb)).toEqual(['verbs']);
    for (const args of [{ grep: 'x'.repeat(65) }, { grep: 3 }, { root: '/fake' }, null, []]) {
      expect((await callNativeTool(name, args)).isError).toBe(true);
    }
  });
});
