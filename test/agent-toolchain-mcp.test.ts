// The repo's .mcp.json gives every Claude Code session working on Phantom the
// companion MCP servers. Pins must match the reviewed companion releases so an
// agent never runs an interface Phantom has not reviewed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPANION_RELEASES } from '../src/core/companion-inventory.js';

interface McpServer { command: string; args: string[] }
const config = JSON.parse(readFileSync(join(__dirname, '..', '.mcp.json'), 'utf8')) as { mcpServers: Record<string, McpServer> };
const reviewed = (id: string): string => {
  const release = COMPANION_RELEASES.find(r => r.id === id);
  if (!release) throw new Error(`no reviewed release for ${id}`);
  return release.version;
};

describe('repo .mcp.json companion servers', () => {
  it('launches every server through npx with exact package versions', () => {
    for (const [name, server] of Object.entries(config.mcpServers)) {
      expect(server.command, name).toBe('npx');
      expect(server.args[0], name).toBe('-y');
      const specs = server.args.filter((arg, i) => i > 0 && !arg.startsWith('-') && arg.includes('@'));
      expect(specs.length, name).toBeGreaterThan(0);
      for (const spec of specs) expect(spec, name).toMatch(/@\d+\.\d+\.\d+$/);
    }
  });

  it('pins Phantom Secrets, Locus and Lexicon to the reviewed companion releases', () => {
    const args = (name: string) => config.mcpServers[name]?.args.join(' ') ?? '';
    expect(args('phantom-secrets')).toContain(`phantom-secrets-mcp@${reviewed('secrets')}`);
    expect(args('locus')).toContain(`@ashlrai/locus-mcp@${reviewed('locus')}`);
    expect(args('lexicon')).toContain(`@ashlr/lexicon@${reviewed('lexicon')}`);
    // Stack reads the vault through the phantom CLI, so it carries the same Secrets pin.
    expect(args('stack')).toContain(`phantom-secrets@${reviewed('secrets')}`);
  });
});
