import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentIdentityKeys, agentLabels, qualifiedAgentSchema, readAgentRegistry,
  registerAgentIdentity, resolveAgent, type AgentRegistry,
} from '../src/core/agents/bus-identity.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-m2-identity-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('M2-2 structured qualification only', () => {
  it.each([
    { handle: 'reviewer', aliases: ['reviewer@owner-b'] },
    { handle: 'own_abc' }, { handle: 'OWN_abc' },
    { handle: 'reviewer', aliases: ['OWN_x'] },
    { handle: 'reviewer', aliases: ['own_x'] },
  ])('refuses qualified handles and aliases at registration: %j', input => {
    expect(registerAgentIdentity(input, { root }).status).toBe('invalid');
  });

  it('never resolves qualified labels through legacy aliases or lowercase fallback', () => {
    expect(registerAgentIdentity({ handle: 'reviewer', aliases: ['Reviewer'] }, { root }).status).toBe('created');
    const read = readAgentRegistry({ root });
    expect(read.status).toBe('ok');
    if (read.status !== 'ok') throw new Error('fixture registry unavailable');
    const registry: AgentRegistry = read.registry;
    const identity = registry.identities[0]!;
    identity.aliases.push('reviewer@owner-b', 'OWN_x', 'own_x');
    for (const label of ['reviewer@owner-b', 'Reviewer@Owner-B', 'OWN_x', 'own_x', 'agent:own_abc']) {
      expect(resolveAgent(registry, label)).toBeUndefined();
      expect(resolveAgent(registry, label.toLowerCase())).toBeUndefined();
    }
    expect(resolveAgent(registry, 'reviewer')?.handle).toBe('reviewer');
    expect(agentLabels(identity)).not.toEqual(expect.arrayContaining(['reviewer@owner-b', 'OWN_x', 'own_x']));
    writeFileSync(join(root, 'agent-identities', 'registry.json'), JSON.stringify(registry), { mode: 0o600 });
    expect(readAgentRegistry({ root }).status).toBe('unavailable');
    expect(agentIdentityKeys({ root })).toBeUndefined();
    identity.handle = 'own_abc';
    expect(resolveAgent(registry, 'Reviewer')).toBeUndefined();
    expect(resolveAgent(registry, identity.id)).toBeUndefined();
    expect(agentLabels(identity)).toEqual([]);
  });

  it('does not split reviewer@owner-b even when reviewer exists', () => {
    registerAgentIdentity({ handle: 'reviewer' }, { root });
    expect(agentIdentityKeys({ root })?.('reviewer@owner-b')).toBeUndefined();
    expect(agentIdentityKeys({ root })?.('REVIEWER@OWNER-B')).toBeUndefined();
    expect(agentIdentityKeys({ root })?.('Reviewer')).toBeDefined();
  });

  it('validates only a strict structured pair with the complete own_ shape', () => {
    const owner = `own_${'a'.repeat(32)}`;
    expect(qualifiedAgentSchema.parse({ handle: 'reviewer', owner })).toEqual({ handle: 'reviewer', owner });
    for (const invalid of [
      `reviewer@${owner}`, { handle: 'reviewer', owner: 'own_abc' },
      { handle: 'reviewer', owner: `OWN_${'a'.repeat(32)}` },
      { handle: 'reviewer@owner-b', owner }, { handle: 'reviewer', owner, extra: true },
    ]) expect(qualifiedAgentSchema.safeParse(invalid).success).toBe(false);
  });
});
