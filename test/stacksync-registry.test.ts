import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { getOptionalToolRegistry, STACKSYNC_CAPABILITY } from '../src/core/tools-registry.js';

function fixture(endpoint = STACKSYNC_CAPABILITY.endpoint as string, workspaceId = 5411) {
  const callTool = vi.fn().mockResolvedValue({ content: [] });
  return { endpoint, workspaceId, callTool };
}

describe('optional Stacksync registry', () => {
  it('skips cleanly without a session and exposes no callable tools', async () => {
    const [entry] = getOptionalToolRegistry();
    expect(entry).toMatchObject({ id: 'stacksync', status: 'skipped', allowedTools: [] });
    await expect(entry!.callTool('syncs_list')).rejects.toThrow('session unavailable');
  });

  it.each([
    ['https://example.com/mcp', 5411],
    [STACKSYNC_CAPABILITY.endpoint, 42],
  ])('skips a session with mismatched scope', (endpoint, workspaceId) => {
    const session = fixture(endpoint, workspaceId);
    expect(getOptionalToolRegistry({ stacksync: session })[0]?.status).toBe('skipped');
    expect(session.callTool).not.toHaveBeenCalled();
  });

  it('allows reads and pins the workspace', async () => {
    const session = fixture();
    const [entry] = getOptionalToolRegistry({ stacksync: session });
    expect(entry?.status).toBe('ready');
    for (const tool of STACKSYNC_CAPABILITY.readOnlyTools) await entry!.callTool(tool);
    expect(session.callTool).toHaveBeenLastCalledWith({
      name: 'syncs_issues', arguments: { workspace_id: 5411 },
    });
    await expect(entry!.callTool('syncs_list', { workspace_id: 42 })).rejects.toThrow('workspace mismatch');
  });

  it('denies execution, genie prompts and unknown tools by default', async () => {
    const session = fixture();
    const [entry] = getOptionalToolRegistry({ stacksync: session });
    for (const tool of ['workflows_run', 'genies_ask', 'syncs_delete']) {
      await expect(entry!.callTool(tool)).rejects.toThrow('tool not allowed');
    }
    expect(session.callTool).not.toHaveBeenCalled();
  });

  it('requires explicit write opt-in and still denies tools outside the allowlist', async () => {
    const session = fixture();
    const [entry] = getOptionalToolRegistry({ stacksync: session }, { allowWrites: true });
    await entry!.callTool('workflows_run', { workflow_id: 1 });
    await entry!.callTool('genies_ask');
    await expect(entry!.callTool('syncs_delete')).rejects.toThrow('tool not allowed');
    expect(session.callTool).toHaveBeenCalledTimes(2);
  });

  it('documents every allowed tool and the default policy without em dashes', () => {
    const manifest = readFileSync(new URL('../capabilities/stacksync.md', import.meta.url), 'utf8');
    for (const tool of STACKSYNC_CAPABILITY.tools) expect(manifest).toContain(`\`${tool}\``);
    expect(manifest).toContain('Read-only is the default');
    expect(manifest).not.toContain('\u2014');
  });
});
