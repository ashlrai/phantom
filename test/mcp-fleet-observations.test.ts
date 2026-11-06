import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import * as graph from '../src/core/fleet/graph-seed.js';
import * as session from '../src/core/fleet/codex-session-usage.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('../src/core/sandbox/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../src/core/sandbox/policy.js', () => ({ killSwitchOn: () => true }));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'phantom-mcp-fleet-'));
  roots.push(root);
  return root;
}
async function json(name: string) {
  const result = await callNativeTool(name, {});
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

describe('native fleet observation MCP tools', () => {
  it.each(['phantom_fleet_graph', 'phantom_fleet_session'])('lists %s as read-only', name => {
    expect(listNativeTools().find(tool => tool.name === name)?.inputSchema).toEqual({
      type: 'object', properties: {}, additionalProperties: false,
    });
    expect(nativeToolSafety(name)).toBe('read');
  });

  it('returns graph fixture JSON while KILL is on, rejecting raw environment records', async () => {
    const path = join(fixture(), 'fleet.json');
    writeFileSync(path, JSON.stringify({ v: 1, repos: [{ repo: 'ashlrai/phantom' }],
      lanes: [{ lane: 'codex' }], seats: [{ seat: 'unsafe', env: { CUSTOM: 'fixture-private-value' } }] }));
    const seed = graph.seedFleetGraph;
    vi.spyOn(graph, 'seedFleetGraph').mockImplementation(() => seed({ fleetJsonPath: path, seats: [] }));
    const result = await json('phantom_fleet_graph');
    expect(result.kind).toBe('graph.v1');
    expect(result.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'repo:ashlrai/phantom' })]));
    expect(result.counts.rejected).toBe(1);
    expect(JSON.stringify(result)).not.toContain('fixture-private-value');
  });

  it('returns session fixture quota JSON without prompts, auth or environment values', async () => {
    const home = fixture();
    const dir = join(home, '.codex', 'sessions', '2026', '10', '29');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(home, '.codex', 'auth.json'), 'not-json-do-not-read');
    writeFileSync(join(dir, 'rollout-fixture.jsonl'), JSON.stringify({
      timestamp: new Date().toISOString(), type: 'event_msg', payload: {
        type: 'token_count', prompt: 'fixture-private-prompt', env: { CUSTOM: 'fixture-private-value' },
        rate_limits: { primary: { used_percent: 40, window_minutes: 300 }, plan_type: 'pro' },
      },
    }) + '\n');
    const collect = session.collectCodexSessionUsages;
    vi.spyOn(session, 'collectCodexSessionUsages').mockImplementation(() => collect({ env: {}, homeDir: home }));
    const result = await json('phantom_fleet_session');
    expect(result.v).toBe('resource.v1');
    expect(result.resources[0]).toMatchObject({ id: 'codex-cmp', state: 'current', session: { usedPct: 40 } });
    expect(JSON.stringify(result)).not.toMatch(/fixture-private|auth.json|CUSTOM/);
  });

  it('keeps oversized graph replies valid JSON', async () => {
    vi.spyOn(graph, 'seedFleetGraph').mockResolvedValue({ nodes: Array.from({ length: 4_000 }, () => 'fleet observation') } as never);
    const result = await callNativeTool('phantom_fleet_graph', {});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toHaveProperty('error');
  });

  it('scrubs secret-shaped strings before encoding JSON and drops environment objects', async () => {
    const fake = 'ghp_' + 'A1b2C3d4'.repeat(5);
    vi.spyOn(graph, 'seedFleetGraph').mockResolvedValue({ label: `token=${fake}`, env: { CUSTOM: 'private' } } as never);
    const result = await json('phantom_fleet_graph');
    expect(result.label).not.toContain(fake);
    expect(result.env).toBeUndefined();
  });

  it.each(['phantom_fleet_graph', 'phantom_fleet_session'])('rejects unexpected %s arguments', async name => {
    const result = await callNativeTool(name, { env: {} });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toHaveProperty('error');
  });

  it.each(['phantom_fleet_graph', 'phantom_fleet_session'])('returns generic JSON on %s source failures', async name => {
    vi.spyOn(graph, 'seedFleetGraph').mockRejectedValue(new Error('fixture-private-value'));
    vi.spyOn(session, 'collectCodexSessionUsages').mockImplementation(() => { throw new Error('fixture-private-value'); });
    const result = await callNativeTool(name, {});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: 'Fleet observation unavailable' });
  });
});
