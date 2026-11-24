import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/fleet/agent-roster.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/fleet/agent-roster.js')>(),
  collectAgentRoster: vi.fn(async () => ({ schema: 'agent-roster.v1', marker: 'roster-fixture', sessions: [], sources: [] })),
}));

import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { collectAgentRoster } from '../src/core/fleet/agent-roster.js';

describe('phm_agent_roster', () => {
  beforeEach(() => {
    vi.mocked(collectAgentRoster).mockClear();
  });

  it('is a read-only tool with only principal and allOwners selectors', () => {
    expect(nativeToolSafety('phm_agent_roster')).toBe('read');
    expect(listNativeTools().find((tool) => tool.name === 'phm_agent_roster')?.inputSchema).toEqual({
      type: 'object', properties: {
        principal: { type: 'string', pattern: '^(local|own_[a-f0-9]{32})$' },
        allOwners: { type: 'boolean' },
      }, additionalProperties: false,
    });
  });

  it('returns the roster and refuses extra arguments', async () => {
    const result = await callNativeTool('phm_agent_roster', {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(result.content[0]?.text).toContain('roster-fixture');
    expect(collectAgentRoster).toHaveBeenCalledOnce();
    const refused = await callNativeTool('phm_agent_roster', { path: '/tmp/sessions' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain('invalid roster arguments');
  });

  it('M2-4 returns a reduced native MCP projection and refuses conflicting selectors', async () => {
    const result = await callNativeTool('phm_agent_roster', { allOwners: true });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe('[]');
    const refused = await callNativeTool('phm_agent_roster', { allOwners: true, principal: 'local' });
    expect(refused.isError).toBe(true);
  });
});
