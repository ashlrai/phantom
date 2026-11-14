// Recut coverage for PR #4857 (RQ-PHX-RECUTN2R4600S102): the fleet verb
// catalog recovered as the read-only native MCP tool phantom_fleet_verbs.
import { describe, expect, it, vi } from 'vitest';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { FLEET_VERBS_MAX_GREP_CHARS, fleetVerbsCatalog } from '../src/core/fleet/fleet-verbs-tool.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));

const name = 'phantom_fleet_verbs';

describe('recut #4857: phantom_fleet_verbs catalog on fresh master', () => {
  it('advertises a read-only tool with a bounded grep schema', () => {
    expect(nativeToolSafety(name)).toBe('read');
    const tool = listNativeTools().find(t => t.name === name);
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: { grep: { type: 'string', maxLength: FLEET_VERBS_MAX_GREP_CHARS } },
      additionalProperties: false,
    });
  });

  it('returns every registered fleet subcommand as fleet.verbs.v1', () => {
    const result = fleetVerbsCatalog();
    if (!('verbs' in result)) throw new Error(`expected catalog, got ${result.error}`);
    expect(result.schema).toBe('fleet.verbs.v1');
    expect(result.count).toBe(Object.keys(FLEET_SUBCOMMAND_LOADERS).length);
    expect(result.count).toBeGreaterThan(0);
    expect(result.verbs).toHaveLength(result.count);
    for (const entry of result.verbs) {
      expect(entry.verb).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
    }
  });

  it('round-trips through callNativeTool and refuses invalid arguments', async () => {
    const ok = await callNativeTool(name, { grep: 'needs' });
    expect(ok.isError).toBeUndefined();
    const body = JSON.parse(ok.content[0].text) as { schema: string; count: number };
    expect(body.schema).toBe('fleet.verbs.v1');
    expect(body.count).toBeGreaterThan(0);
    for (const args of [{ grep: 'x'.repeat(65) }, { grep: 7 }, { extra: true }, null, []]) {
      expect((await callNativeTool(name, args)).isError).toBe(true);
    }
  });
});
