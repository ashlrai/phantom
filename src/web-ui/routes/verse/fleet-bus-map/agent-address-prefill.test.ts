import { describe, expect, it } from 'vitest';
import { agentAddressPrefill } from './agent-address-prefill.js';

describe('agentAddressPrefill', () => {
  it('addresses an agent and optionally adds the last-seen line', () => {
    expect(agentAddressPrefill('graph-coordinator')).toBe('@graph-coordinator: ');
    expect(agentAddressPrefill('graph-coordinator', '3 min ago')).toBe('@graph-coordinator: \n(last seen 3 min ago)');
    expect(agentAddressPrefill('a'.repeat(128))).toBe(`@${'a'.repeat(128)}: `);
  });

  it('rejects invalid bus addresses', () => {
    for (const id of ['', 'two words', 'agent\n', 'é', 'a'.repeat(129)]) {
      expect(agentAddressPrefill(id)).toBeNull();
    }
  });
});
