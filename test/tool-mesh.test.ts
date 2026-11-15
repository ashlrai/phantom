import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildToolMesh } from '../src/core/connectors/mesh.js';
import { updateProfile, validateProfile } from '../src/core/connectors/profile.js';

describe('tool mesh', () => {
  it('combines native definitions and profile metadata without exposing invocation details', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mesh-'));
    try {
      const bin = join(home, 'bin'); await mkdir(bin);
      await writeFile(join(bin, 'example'), '', { mode: 0o755 });
      const profile = validateProfile({ version: 1, connectors: [
        { id: 'cli', kind: 'cli', description: 'Repository operations', command: 'example', args: ['private-argument'], scopes: ['read'], tools: ['codex'], lanes: ['work'], credentials: [{ binding: 'AUTH', name: 'vault-name' }] },
        { id: 'remote', kind: 'mcp-http', url: 'https://example.com/mcp' },
        { id: 'missing', kind: 'plugin', command: 'missing' },
      ] });
      await updateProfile(() => profile, home);
      const mesh = await buildToolMesh(home, bin);
      expect(mesh.nativeTools.length).toBeGreaterThan(0);
      expect(mesh.nativeTools[0]).toHaveProperty('inputSchema');
      expect(mesh.connectors.map(c => c.availability)).toEqual(['available', 'unknown', 'unavailable']);
      expect(mesh.connectors[0]?.description).toBe('Repository operations');
      expect(mesh.connectors[0]?.permissions).toEqual({ scopes: ['read'], agents: ['codex'], lanes: ['work'], credentialBindings: ['AUTH'] });
      expect(JSON.stringify(mesh)).not.toContain('private-argument');
      expect(JSON.stringify(mesh)).not.toContain('vault-name');
      expect(JSON.stringify(mesh)).not.toContain('example.com');
      expect(mesh.connectors[0]?.route).toContain('phm connectors exec');
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
