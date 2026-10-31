import { afterEach, describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, lstat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listConnectors, setConnectorEnabled } from '../src/core/verse/connector-manager.js';
import { discoverMcpServers } from '../src/core/mcp-registry.js';

const directories: string[] = [];
async function fixtureDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'connectors-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('Phantom gateway connector manager', () => {
  it('preserves secrets and unrelated config; disabled servers disappear from discovery', async () => {
    const path = join(await fixtureDirectory(), 'settings.json');
    const spec = { command: 'node', args: ['server'], env: { TOKEN: 'synthetic-secret' }, capability: 'synthetic-capability' };
    await writeFile(path, JSON.stringify({ mcpServers: { locus: spec }, other: 42 }));
    const before = await listConnectors(path);
    expect(JSON.stringify(before)).not.toMatch(/synthetic-/);
    const disabled = await setConnectorEnabled('locus', false, before.revision, path);
    expect(disabled.connectors).toEqual([{ name: 'locus', enabled: false }]);
    expect(discoverMcpServers([path]).servers).toEqual([]);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await expect(setConnectorEnabled('locus', true, before.revision, path)).rejects.toThrow('conflict');
    await setConnectorEnabled('locus', true, disabled.revision, path);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ mcpServers: { locus: spec }, phantomDisabledMcpServers: {}, other: 42 });
    expect(discoverMcpServers([path]).servers).toHaveLength(1);
  });

  it('refuses malformed, overlapping, and symlinked registries without overwriting them', async () => {
    const dir = await fixtureDirectory();
    const path = join(dir, 'settings.json');
    for (const raw of ['broken', '{"mcpServers":[]}', '{"mcpServers":{"x":{}},"phantomDisabledMcpServers":{"x":{}}}']) {
      await writeFile(path, raw);
      await expect(listConnectors(path)).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe(raw);
    }
    const link = join(dir, 'link.json');
    await symlink(path, link);
    await expect(listConnectors(link)).rejects.toThrow();
  });

  it('serializes competing writes and refuses an unknown name', async () => {
    const path = join(await fixtureDirectory(), 'settings.json');
    await writeFile(path, JSON.stringify({ mcpServers: { one: { command: 'node' }, two: { command: 'node' } } }));
    const snapshot = await listConnectors(path);
    await expect(setConnectorEnabled('missing', false, snapshot.revision, path)).rejects.toThrow('conflict');
    const results = await Promise.allSettled(['one', 'two'].map((name) => setConnectorEnabled(name, false, snapshot.revision, path)));
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
  });
});
