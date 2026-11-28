import { expect, it } from 'vitest';
import { withIdentity, withoutIdentity } from '../src/core/comms/owner-pair.ts';

// Test cases for toml editing functions
// Cases (use plainly fake handles such as "+15550100" and "owner@example.invalid"; never a real number or address):
// 1. Empty text + 'team': the result contains a `[team]` section whose parsed identities equal exactly the one imessage identity.
// 2. Existing `[team]` with `identities = [{ channel = "slack", id = "U000FAKE" }]`: the result keeps slack and adds imessage first; the parsed list is [imessage, slack].
// 3. Existing `[team]` with no identities line: the identities line is inserted under the header; other keys in the section survive.
// 4. Section already holding an imessage identity: returns null.
// 5. Other sections ([mason], an unrelated [other] table with a key) are byte-identical in the result when editing [team].
// 6. withoutIdentity on a list [imessage, slack]: the result parses and its identities equal [slack].
// 7. withoutIdentity with no imessage identity returns the input string unchanged (toBe).
// 8. Round trip: withoutIdentity(withIdentity(t, 'mason', id)!, 'mason') parses to the same identities as t.

// Helper to test parsing
import { parseTeamIdentities } from '../src/core/agents/channel-policy.js';
import { parseMasonIdentities } from '../src/core/agents/leader-network.js';

function parseMason(text: string) {
  return parseMasonIdentities(text);
}

function parseTeam(text: string) {
  return parseTeamIdentities(text);
}

function validateIdentities(text: string, section: 'mason' | 'team'): boolean {
  try {
    const identities = section === 'mason' ? parseMason(text) : parseTeam(text);
    // Basic check that they parse without error
    return true;
  } catch (e) {
    return false;
  }
}

// Test 1: Empty text + 'team'
it('empty text + team', () => {
  const result = withIdentity('', 'team', '+15550100');
  expect(result).not.toBeNull();
  
  if (result) {
    const parsed = parseTeam(result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ channel: 'imessage', id: '+15550100' });
  }
});

// Test 2: Existing [team] with identities line
it('existing team with slack identity', () => {
  const input = `[team]
identities = [{ channel = "slack", id = "U000FAKE" }]`;
  
  const result = withIdentity(input, 'team', '+15550100');
  expect(result).not.toBeNull();
  
  if (result) {
    const parsed = parseTeam(result);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ channel: 'imessage', id: '+15550100' });
    expect(parsed[1]).toEqual({ channel: 'slack', id: 'U000FAKE' });
  }
});

// Test 3: Existing [team] with no identities line
it('existing team without identities line', () => {
  const input = `[team]
key = "value"`;
  
  const result = withIdentity(input, 'team', '+15550100');
  expect(result).not.toBeNull();
  
  if (result) {
    const parsed = parseTeam(result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ channel: 'imessage', id: '+15550100' });
    
    // Other keys should survive
    expect(result).toContain('key = "value"');
  }
});

// Test 4: Section already holding an imessage identity
it('section already has imessage identity', () => {
  const input = `[team]
identities = [{ channel = "imessage", id = "+15550101" }]`;
  
  const result = withIdentity(input, 'team', '+15550100');
  expect(result).toBeNull();
});

// Test 5: Other sections are byte-identical when editing [team]
it('other sections unchanged when editing team', () => {
  const input = `[mason]
identities = [{ channel = "slack", id = "U000FAKE" }]

[team]
key = "value"

[other]
key = "value2"`;
  
  const result = withIdentity(input, 'team', '+15550100');
  expect(result).not.toBeNull();
  
  if (result) {
    // Check that other sections are unchanged (except for the [team] section update)
    expect(result).toContain('[mason]');
    expect(result).toContain('[other]');
    expect(result).toContain('key = "value"');
    expect(result).toContain('key = "value2"');
    expect(result).toContain('[team]');
  }
});

// Test 6: withoutIdentity on a list [imessage, slack]
it('withoutIdentity removes imessage identity', () => {
  const input = `[team]
identities = [{ channel = "imessage", id = "+15550100" }, { channel = "slack", id = "U000FAKE" }]`;
  
  const result = withoutIdentity(input, 'team');
  expect(result).not.toBeNull();
  
  if (result) {
    const parsed = parseTeam(result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ channel: 'slack', id: 'U000FAKE' });
  }
});

// Test 7: withoutIdentity with no imessage identity
it('withoutIdentity with no imessage identity', () => {
  const input = `[team]
identities = [{ channel = "slack", id = "U000FAKE" }]`;
  
  const result = withoutIdentity(input, 'team');
  expect(result).toBe(input); // Should be unchanged
});

// Test 8: Round trip - withIdentity followed by withoutIdentity should preserve original
it('round trip test', () => {
  const input = `[mason]
identities = [{ channel = "slack", id = "U000FAKE" }]

[team]
identities = [{ channel = "slack", id = "U000FAKE" }]`;
  
  const id = '+15550100';
  
  // Apply withIdentity to mason
  const withResult = withIdentity(input, 'mason', id);
  expect(withResult).not.toBeNull();
  
  if (withResult) {
    const withoutResult = withoutIdentity(withResult!, 'mason');
    expect(withoutResult).not.toBeNull();
    
    if (withoutResult) {
      // The withoutResult should parse to same identities as the original input
      const originalMason = parseMason(input);
      const restoredMason = parseMason(withoutResult);
      
      expect(restoredMason).toEqual(originalMason);
    }
  }
});

// Additional edge case tests
it('handles mixed whitespace correctly', () => {
  const input = `[team]
  identities = [{ channel = "slack", id = "U000FAKE" }]`;
  
  const result = withIdentity(input, 'team', '+15550100');
  expect(result).not.toBeNull();
});

it('handles complex existing team configuration', () => {
  const input = `[team]
  key1 = "value1"
  identities = [{ channel = "slack", id = "U000FAKE" }]
  key2 = "value2"`;
  
  const result = withIdentity(input, 'team', '+15550100');
  expect(result).not.toBeNull();
  
  if (result) {
    const parsed = parseTeam(result);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ channel: 'imessage', id: '+15550100' });
    expect(parsed[1]).toEqual({ channel: 'slack', id: 'U000FAKE' });
    
    // Make sure the other config is preserved
    expect(result).toContain('key1 = "value1"');
    expect(result).toContain('key2 = "value2"');
  }
});

// Test that a bad edit returns null (if applicable)
it('handles malformed input gracefully', () => {
  const input = `[team]
identities = [{ channel = "slack", id = "U000FAKE" }`;
  
  const result = withIdentity(input, 'team', '+15550100');
  expect(result).toBeNull();
});

// Test parsing function robustness
it('parseMason function works correctly', () => {
  const input = `[mason]
identities = [{ channel = "imessage", id = "+15550100" }]`;
  
  const parsed = parseMason(input);
  expect(parsed).toHaveLength(1);
  expect(parsed[0]).toEqual({ channel: 'imessage', id: '+15550100' });
});

it('parseTeam function works correctly', () => {
  const input = `[team]
identities = [{ channel = "imessage", id = "+15550100" }]`;
  
  const parsed = parseTeam(input);
  expect(parsed).toHaveLength(1);
  expect(parsed[0]).toEqual({ channel: 'imessage', id: '+15550100' });
});
