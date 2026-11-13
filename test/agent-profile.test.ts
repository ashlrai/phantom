import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAgentProfile, writeAgentProfile, readAgentProfile, pinAgentProfile, agentProfileVersions } from '../src/core/agents/agent-profile.js';
const input = { id: 'helper', displayName: 'Helper', doctrine: 'doctrine.md' };
describe('agent profiles', () => {
  it('defaults to restrictive policy and rejects unknown fields', () => {
    expect(validateAgentProfile(input).policy.limitsTodo).toBe(true);
    expect(() => validateAgentProfile({ ...input, unexpected: true })).toThrow();
    expect(() => validateAgentProfile({ ...input, policy: { unexpected: true } })).toThrow();
  });
  it('bumps changed writes, retains unchanged versions and retains exact pins', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-profile-'));
    try {
      const first = await writeAgentProfile(input, home);
      expect((await writeAgentProfile(first, home)).version).toBe(1);
      const changed = await writeAgentProfile({ ...first, displayName: 'Updated' }, home);
      expect(changed.version).toBe(2);
      expect(await readAgentProfile('helper', home)).toEqual(changed);
      expect((await stat(join(home, '.phantom/agents/helper.toml'))).mode & 0o777).toBe(0o600);
      expect(await pinAgentProfile('helper', 1, home)).toEqual(first);
      expect(await agentProfileVersions('helper', home)).toEqual([1, 2]);
      await expect(pinAgentProfile('helper', 3, home)).rejects.toThrow();
      await expect(writeAgentProfile(first, home)).rejects.toThrow();
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('rejects paths as ids and unresolved connectors', async () => {
    expect(() => validateAgentProfile({ ...input, id: '../escape' })).toThrow();
    const home = await mkdtemp(join(tmpdir(), 'agent-profile-'));
    try { await expect(writeAgentProfile({ ...input, mcpServers: ['missing'] }, home)).rejects.toThrow(); }
    finally { await rm(home, { recursive: true, force: true }); }
  });
});
