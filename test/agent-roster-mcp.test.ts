import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/fleet/agent-roster.js', () => ({
  collectAgentRoster: vi.fn(async () => ({ schema: 'agent-roster.v1', marker: 'roster-fixture' })),
}));

import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { collectAgentRoster } from '../src/core/fleet/agent-roster.js';

describe('phm_agent_roster', () => {
  beforeEach(() => {
    vi.mocked(collectAgentRoster).mockClear();
  });

  it('is a read-only tool with no arguments', () => {
    expect(nativeToolSafety('phm_agent_roster')).toBe('read');
    expect(listNativeTools().find((tool) => tool.name === 'phm_agent_roster')?.inputSchema).toEqual({
      type: 'object', properties: {}, additionalProperties: false,
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
});
