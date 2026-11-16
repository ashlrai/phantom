import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateProfile, validateProfile } from '../src/core/connectors/profile.js';
import {
  agentProfileVersions,
  listAgentProfiles,
  pinAgentProfile,
  readAgentProfile,
  validateAgentProfile,
  writeAgentProfile,
} from '../src/core/agents/agent-profile.js';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'agent-profile-history-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const connector = {
  id: 'context7', kind: 'mcp-http', url: 'https://mcp.context7.com/mcp',
  scopes: ['docs'], tools: ['claude'], lanes: ['work'],
  credentials: [{ binding: 'ACCESS', name: 'context7-access' }],
};
const input = { id: 'helper', displayName: 'Helper', doctrine: 'doctrine.md' };

describe('agent profile revision history recovery', () => {
  it('pins exact revisions, rejects stale writes and future pins without mutating current metadata', async () => {
    await updateProfile(() => validateProfile({ version: 1, connectors: [connector] }), home);
    const first = await writeAgentProfile({ ...input, mcpServers: ['context7'] }, home);
    expect(first.version).toBe(1);

    const second = await writeAgentProfile({ ...first, displayName: 'Helper v2' }, home);
    expect(second.version).toBe(2);
    expect(await agentProfileVersions('helper', home)).toEqual([1, 2]);

    expect(await pinAgentProfile('helper', 1, home)).toEqual(first);
    expect(await pinAgentProfile('helper', 2, home)).toEqual(second);
    expect(await readAgentProfile('helper', home)).toEqual(second);
    expect(await listAgentProfiles(home)).toEqual([second]);

    // A stale caller version is refused and leaves revision 2 untouched.
    await expect(writeAgentProfile(first, home)).rejects.toThrow('Stale agent profile version.');
    expect(await readAgentProfile('helper', home)).toEqual(second);
    expect(await pinAgentProfile('helper', 1, home)).toEqual(first);

    // A nonexistent future revision is refused without mutating current metadata.
    await expect(pinAgentProfile('helper', 3, home)).rejects.toThrow('Pinned agent profile version unavailable.');
    expect(await readAgentProfile('helper', home)).toEqual(second);
    expect(await agentProfileVersions('helper', home)).toEqual([1, 2]);
  });

  it('keeps revision history secret-free and private', async () => {
    const first = await writeAgentProfile(input, home);
    const second = await writeAgentProfile({ ...first, channels: ['owner-thread'] }, home);
    expect(second.version).toBe(2);
    const pinned = await pinAgentProfile('helper', 1, home);
    expect(pinned).toEqual(first);
    expect(pinned.policy.send).toBe('drafts-only');
    expect(() => validateAgentProfile({ ...input, policy: { send: 'allowlist-auto', perMessageApproval: false } })).not.toThrow();
    expect(validateAgentProfile(input).version).toBe(1);
  });
});
