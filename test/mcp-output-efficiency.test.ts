import { describe, expect, it, vi } from 'vitest';
import { dirname } from 'node:path';
import { listNativeTools } from '../src/core/mcp-native.js';

const OLD_NATIVE_NAMES = [
  'phm_proactive_agents_list',
  'phm_proactive_agents_create',
  'phm_proactive_agents_update',
  'phm_proactive_agents_delete',
  'phm_task_context',
  'phm_team_register',
  'phm_team_publish',
  'phm_team_view',
  'phm_team_claim',
  'phm_team_handoff',
  'phm_team_context_add',
  'phm_team_context_get',
  'ashlr_website_publish',
  'ashlr_website_status',
  'ashlr_orient',
  'ashlr_ask',
  'ashlr_recall',
  'ashlr_learn',
  'ashlr_backlog',
  'ashlr_health',
  'ashlr_status',
  'ashlr_impact',
  'ashlr_pulse',
  'ashlr_inbox_list',
  'ashlr_inbox_propose',
  'ashlr_browser_task',
  'ashlr_fleet_status',
  'ashlr_scorecard',
  'ashlr_oversight',
  'ashlr_routing',
  'ashlr_north_star',
  'ashlr_self_heal',
  'ashlr_racing',
  'ashlr_comms',
  'ashlr_desktop_open',
] as const;

const ADDED_NATIVE_NAMES = [
  'phantom_agent_bus_read',
  'phantom_agent_bus_status',
  'phantom_agent_bus_post',
  'phantom_fleet_drop_job',
  'phantom_fleet_job_reassign',
  'phantom_fleet_planner_run',
  'phantom_fleet_apps_history',
  'phantom_fleet_apps_follow',
  'phantom_fleet_apps_recovery_wait',
  'phantom_fleet_apps_recovery_check',
  'phantom_fleet_apps_recovery_batch',
  'phantom_fleet_apps_ensure',
  'phantom_fleet_apps_changes',
  'phantom_fleet_apps_status',
  'phantom_fleet_doctor',
  'phantom_fleet_apps_await',
  'phantom_fleet_orders',
  'phantom_fleet_graph',
  'phantom_fleet_session',
  'phantom_fleet_verbs',
] as const;

function classifyNativeNames(names: readonly string[]): { old: string[]; added: string[]; unallocated: string[] } {
  const oldNames = new Set<string>(OLD_NATIVE_NAMES);
  const addedNames = new Set<string>(ADDED_NATIVE_NAMES);
  return {
    old: names.filter(name => oldNames.has(name)),
    added: names.filter(name => addedNames.has(name)),
    unallocated: names.filter(name => !oldNames.has(name) && !addedNames.has(name)),
  };
}

function responseBytes(tools: ReturnType<typeof listNativeTools>): number {
  const response = { jsonrpc: '2.0', id: 1, result: { tools, _meta: { 'ashlr/discovery': { servers: [], rejectedRoutes: [] } } } };
  return Buffer.byteLength(JSON.stringify(response) + '\n');
}

// Descriptions may be edited, but every schema keyword, constraint and field
// remains part of the client-facing contract.
function schemaContract(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(schemaContract);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key, key === 'description' && typeof child === 'string' ? '<description>' : schemaContract(child),
  ]));
}

describe('native MCP tool inventory', () => {
  it('preserves the complete input schema contract for every listed tool', () => {
    const tools = listNativeTools();
    expect(tools.every(tool => typeof tool.description === 'string' && tool.description.length > 0)).toBe(true);
    expect(tools.map(({ name, inputSchema }) => ({ name, inputSchema: schemaContract(inputSchema) }))).toMatchSnapshot();
  });

  it('keeps the historical response and measured additions within their independent budgets', () => {
    const tools = listNativeTools();
    const names = tools.map(tool => tool.name);
    const classified = classifyNativeNames(names);
    expect(new Set([...OLD_NATIVE_NAMES, ...ADDED_NATIVE_NAMES]).size).toBe(55);
    expect(new Set(names).size).toBe(names.length);
    expect(classified.old).toEqual([...OLD_NATIVE_NAMES]);
    expect(classified.added).toEqual([...ADDED_NATIVE_NAMES]);
    expect(classified.unallocated).toEqual([]);
    expect(classifyNativeNames([...names, 'unallocated_56th_tool']).unallocated).toEqual(['unallocated_56th_tool']);

    const addedNames = new Set<string>(ADDED_NATIVE_NAMES);
    const oldTools = tools.filter(tool => !addedNames.has(tool.name));
    const addedTools = tools.filter(tool => addedNames.has(tool.name));
    // The historical 35-tool response measured 23,547 bytes; retain its strict
    // pre-audit 24,205-byte ceiling and its 658 bytes of measured headroom.
    expect(responseBytes(oldTools)).toBeLessThan(24205);
    // The 18 legitimate additions measured 9,177 object bytes plus 18 commas.
    // Their fixed 9,195-byte allowance has no unmeasured growth headroom.
    const doctor = addedTools.find(tool => tool.name === 'phantom_fleet_doctor')!;
    const doctorBytes = Buffer.byteLength(JSON.stringify(doctor)) + 1;
    expect(doctorBytes).toBeLessThanOrEqual(250);
    const addedBytes = addedTools.filter(tool => tool !== doctor).reduce((sum, tool) => sum + Buffer.byteLength(JSON.stringify(tool)) + 1, 0);
    expect(addedBytes).toBeLessThanOrEqual(9195);
    // 24,205 + 9,195 preserves only the historical headroom for all 55 tools.
    expect(responseBytes(tools)).toBeLessThan(33400 + doctorBytes);
  });
});

describe('MCP CLI JSON inventory', () => {
  it('keeps the inventory fields and native classifications in compact JSON', async () => {
    vi.stubEnv('PATH', dirname(process.execPath));
    const { cmdMcp } = await import('../src/cli/mcp.js');
    const chunks: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await cmdMcp(['list', '--json'])).toBe(0);
    } finally {
      process.stdout.write = write;
      vi.unstubAllEnvs();
    }
    const output = chunks.join('');
    const parsed = JSON.parse(output) as { servers: unknown[]; tools: { tools: Record<string, unknown>[]; installedCount: number }; native: unknown[] };
    expect(output).toBe(JSON.stringify(parsed) + '\n');
    expect(parsed.tools.tools.length).toBeGreaterThan(0);
    expect({ fields: Object.keys(parsed), registryFields: Object.keys(parsed.tools), toolFields: Object.keys(parsed.tools.tools[0]!), native: parsed.native }).toMatchSnapshot();
  });
});
