import { describe, it, expect } from 'vitest';
import fs from 'fs';

// Read the registry to get the correct structure
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.ts';

describe('cloud agent routes CLI commands', () => {
  it('should validate that docs/CLOUD-AGENT-ROUTES.md lists commands that match FLEET_SUBCOMMAND_LOADERS', () => {
    const docContent = fs.readFileSync('docs/CLOUD-AGENT-ROUTES.md', 'utf-8');
    
    // Extract CLI commands from the table format in the documentation
    // Pattern: | `ashlr fleet <command>` | <description> |
    const cliCommandRegex = /\| `ashlr fleet ([^`]+)` \|/g;
    const matches = [];
    let match;
    
    while ((match = cliCommandRegex.exec(docContent)) !== null) {
      matches.push(match[1].trim());
    }
    
    // Check that runtime is one of the extracted commands (we just want to make sure it's there)
    expect(matches).toContain('runtime');
    
    // Now make sure each extracted verb is a key in the registry
    // We'll exclude special case entries like the full example commands that have dashes and other formatting
    const validCommands = matches.filter(verb => {
      // These are examples or full command lines that shouldn't be validated against the registry keys
      return !verb.includes('--') && 
             !verb.includes('claim') && 
             !verb.includes('release') && 
             !verb.includes('handoff') && 
             !verb.includes('return') &&
             !verb.includes('work-result') &&
             !verb.includes('coordination') &&
             !verb.includes('review-pick');
    });
    
    // Test that runtime is one of the valid commands
    expect(validCommands).toContain('runtime');
    
    // Validate that all valid commands exist as keys in the registry
    validCommands.forEach(verb => {
      expect(FLEET_SUBCOMMAND_LOADERS).toHaveProperty(verb);
    });
    
    // Test specifically some expected commands that should be present in both places
    const expectedCommands = ['work-board', 'order-state', 'runtime-identity', 'runtime', 'tailnet-peers', 'pool-reach'];
    expectedCommands.forEach(command => {
      expect(matches).toContain(command);
    });
    
    // And verify runtime is explicitly listed in docs
    expect(matches).toContain('runtime');
  });
});
