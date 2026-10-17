/**
 * Confined (non-autonomous) runs get the repo's reviewed companion MCP servers
 * through the fleet sidecar (src/core/run/sandboxed-engine.ts). Only exact
 * reviewed npx specs pass; anything else a repo's .mcp.json declares is ignored.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { COMPANION_RELEASES } from '../src/core/companion-inventory.js';
import {
  FLEET_COMPANION_MCP_SPECS,
  FLEET_MCP_CONFIG_FILENAME,
  fleetEfficiencyMcpArgs,
  trackedCompanionMcpServers,
  writeMcpConfigIfAvailable,
} from '../src/core/run/sandboxed-engine.js';

const dirs: string[] = [];
const worktree = (mcpJson?: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-companions-'));
  dirs.push(dir);
  if (mcpJson !== undefined) writeFileSync(join(dir, '.mcp.json'), typeof mcpJson === 'string' ? mcpJson : JSON.stringify(mcpJson));
  return dir;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const repoMcp = JSON.parse(readFileSync(join(process.cwd(), '.mcp.json'), 'utf8')) as { mcpServers: Record<string, { command: string; args: string[] }> };
const NO_PATH = '/nonexistent-fleet-companion-path';

describe('fleet companion MCP specs', () => {
  it('pin the reviewed companion releases and match the repo .mcp.json exactly', () => {
    const version = (id: string): string => COMPANION_RELEASES.find(r => r.id === id)!.version;
    expect(FLEET_COMPANION_MCP_SPECS['phantom-secrets']).toContain(`phantom-secrets-mcp@${version('secrets')}`);
    expect(FLEET_COMPANION_MCP_SPECS['locus']).toContain(`@ashlrai/locus-mcp@${version('locus')}`);
    expect(FLEET_COMPANION_MCP_SPECS['lexicon']).toContain(`@ashlr/lexicon@${version('lexicon')}`);
    for (const [name, args] of Object.entries(FLEET_COMPANION_MCP_SPECS)) {
      expect(repoMcp.mcpServers[name]).toEqual({ command: 'npx', args: [...args] });
    }
    // Stack has no reviewed release yet, so confined runs do not start it.
    expect(Object.keys(trackedCompanionMcpServers(process.cwd())).sort()).toEqual(['lexicon', 'locus', 'phantom-secrets']);
  });
});

describe('trackedCompanionMcpServers', () => {
  it('takes only exact reviewed specs', () => {
    const dir = worktree({ mcpServers: {
      'phantom-secrets': { command: 'npx', args: ['-y', 'phantom-secrets-mcp@0.7.9'] },
      locus: { command: 'npx', args: ['-y', '@ashlrai/locus-mcp@0.4.0'] },
      lexicon: { command: 'npx', args: ['-y', '-p', '@ashlr/lexicon@0.5.4', 'lexicon-mcp'], env: { X: '1' } },
      other: { command: 'sh', args: ['-c', 'echo hi'] },
    } });
    expect(trackedCompanionMcpServers(dir)).toEqual({
      'phantom-secrets': { command: 'npx', args: ['-y', 'phantom-secrets-mcp@0.7.9'] },
    });
  });

  it('is empty for a missing, malformed or non-object file', () => {
    expect(trackedCompanionMcpServers(worktree())).toEqual({});
    expect(trackedCompanionMcpServers(worktree('{not json'))).toEqual({});
    expect(trackedCompanionMcpServers(worktree({ mcpServers: [] }))).toEqual({});
  });
});

describe('fleet sidecar with companions', () => {
  it('writes companions without ashlr-mcp and stays off for codex', () => {
    const dir = worktree({ mcpServers: { locus: { command: 'npx', args: ['-y', '@ashlrai/locus-mcp@0.5.0'] } } });
    const path = writeMcpConfigIfAvailable(dir, NO_PATH);
    expect(path).toBe(join(dir, FLEET_MCP_CONFIG_FILENAME));
    const written = JSON.parse(readFileSync(path!, 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(written.mcpServers['locus']).toEqual({ command: 'npx', args: ['-y', '@ashlrai/locus-mcp@0.5.0'] });
    expect(fleetEfficiencyMcpArgs('claude', { path: path!, command: null })).toEqual(['--mcp-config', path, '--strict-mcp-config']);
    expect(fleetEfficiencyMcpArgs('codex', { path: path!, command: null })).toEqual([]);
  });

  it('writes nothing when there is neither ashlr-mcp nor a reviewed companion', () => {
    const dir = worktree({ mcpServers: { other: { command: 'npx', args: ['x'] } } });
    // ashlr-mcp may sit in ~/.local/bin on a dev machine; only assert when it does not.
    const path = writeMcpConfigIfAvailable(dir, NO_PATH);
    if (path) expect(Object.keys((JSON.parse(readFileSync(path, 'utf8')) as { mcpServers: object }).mcpServers)).toEqual(['ashlr']);
    else expect(path).toBeNull();
  });
});
