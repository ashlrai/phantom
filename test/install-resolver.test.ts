import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseInstallManifest } from '../src/core/install/manifest.js';
import { readInstallMetadata, resolveInstall, type MetadataReader } from '../src/core/install/resolver.js';

const sha = 'a'.repeat(40);
const base = `https://raw.githubusercontent.com/ashlrai/example/${sha}`;
const registry = 'https://registry.npmjs.org/%40ashlr%2Fexample';
const manifest = { version: 1, id: 'example', install: { kind: 'npm', package: '@ashlr/example', version: '1.2.3', bin: 'example-mcp' }, mcp: { args: [] } };
const pkg = { name: '@ashlr/example', version: '1.2.3', bin: { 'example-mcp': './dist/mcp.js' }, repository: { url: 'git+https://github.com/ashlrai/example.git' } };
const encode = (value: unknown) => JSON.stringify(value);
function reader(files: Record<string, string | null> = {}) {
  const data: Record<string, string | null> = {
    'https://api.github.com/repos/ashlrai/example/commits/HEAD': encode({ sha }),
    [`${registry}/latest`]: encode(pkg), [`${registry}/1.2.3`]: encode(pkg), ...files,
  };
  return vi.fn<MetadataReader>(async url => data[url] ?? null);
}

describe('install manifest', () => {
  it('normalizes defaults and leaves secret binding names as metadata', () => {
    expect(parseInstallManifest({ ...manifest, mcp: {}, secrets: [{ env: 'EXAMPLE_API_KEY', name: 'example-key' }] })).toMatchObject({ mcp: { args: [] }, secrets: [{ env: 'EXAMPLE_API_KEY', name: 'example-key' }] });
    expect(parseInstallManifest(manifest).secrets).toEqual([]);
  });
  it.each([
    { ...manifest, version: 2 },
    { ...manifest, id: '__proto__' },
    { ...manifest, id: 'constructor' },
    { ...manifest, setup: 'npm run build' },
    { ...manifest, install: { ...manifest.install, version: '^1.2.3' } },
    { ...manifest, install: { ...manifest.install, version: '1.2.3-01' } },
    { ...manifest, install: { ...manifest.install, package: 'https://example.com/tool.tgz' } },
    { ...manifest, mcp: { args: ['--token', 'value'] } },
    { ...manifest, mcp: { args: ['line\nbreak'] } },
    { ...manifest, mcp: { env: { EXAMPLE_API_KEY: 'value' } } },
    { ...manifest, secrets: [{ env: 'KEY', name: 'one' }, { env: 'KEY', name: 'two' }] },
    { ...manifest, secrets: [{ env: 'KEY', name: 'one', value: 'value' }] },
  ])('refuses malformed or executable metadata %#', value => {
    expect(() => parseInstallManifest(value)).toThrow();
  });
  it('withholds rejected secret-shaped values from diagnostics', () => {
    const secret = 'ghp_' + 'x'.repeat(36);
    expect(() => parseInstallManifest({ ...manifest, mcp: { args: [secret] } })).toThrow('secret-shaped');
    try { parseInstallManifest({ ...manifest, mcp: { args: [secret] } }); } catch (error) { expect(String(error)).not.toContain(secret); }
  });
  it('supports pinned git Node entrypoints and rejects path traversal', () => {
    const git = { ...manifest, install: { kind: 'git', repo: 'ashlrai/example', commit: sha, bin: 'dist/server.mjs' } };
    expect(parseInstallManifest(git).install.kind).toBe('git');
    for (const bin of ['../server.js', '/server.js', 'a/../../server.js', 'a//server.js', 'server.sh', 'a\\server.js']) expect(() => parseInstallManifest({ ...git, install: { ...git.install, bin } })).toThrow();
  });
  it('ships a strict versioned JSON schema with all installation variants', () => {
    const schema = JSON.parse(readFileSync(new URL('../schema/phantom.install.v1.schema.json', import.meta.url), 'utf8'));
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.version.const).toBe(1);
    expect(schema.properties.install.oneOf.map((entry: { properties: { kind: { const: string } } }) => entry.properties.kind.const)).toEqual(['npm', 'git']);
  });
});

describe('install resolver', () => {
  it('pins repository reads and gives the manifest priority over documentation', async () => {
    const read = reader({ [`${base}/phantom.install.json`]: encode(manifest), [`${base}/AGENTS.md`]: 'ignored' });
    const result = await resolveInstall('https://github.com/ashlrai/example.git', read);
    expect(result).toMatchObject({ manifest: { ...manifest, secrets: [] }, entrypoint: 'dist/mcp.js', source: `${base}/phantom.install.json` });
    expect(read.mock.calls.map(([url]) => url)).toEqual(['https://api.github.com/repos/ashlrai/example/commits/HEAD', `${base}/phantom.install.json`, `${registry}/1.2.3`]);
  });
  it('resolves npm names through latest and then exact version metadata', async () => {
    const read = reader();
    const result = await resolveInstall('@ashlr/example', read);
    expect(result).toMatchObject({ entrypoint: 'dist/mcp.js', source: `${registry}/1.2.3`, manifest: { mcp: { args: [] }, install: { version: '1.2.3' } } });
    expect(read.mock.calls).toEqual([[`${registry}/latest`], [`${registry}/1.2.3`]]);
  });
  it('keeps ordinary single-bin packages tool-only without guessing MCP args', async () => {
    const read = reader({ [`${registry}/1.2.3`]: encode({ ...pkg, bin: { example: 'dist/cli.js' } }) });
    const result = await resolveInstall('@ashlr/example', read);
    expect(result.manifest.mcp).toBeUndefined();
    expect(result.manifest.install).toMatchObject({ bin: 'example' });
  });
  it('derives safe ids for numeric and long npm names', async () => {
    for (const name of ['123', 'constructor', 'long-package-name-'.repeat(6)]) {
      const read = vi.fn<MetadataReader>(async () => encode({ ...pkg, name }));
      const result = await resolveInstall(name, read);
      expect(result.manifest.id).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
    }
  });
  it('reads an explicit documentation fence and never executes its surrounding prose', async () => {
    const read = reader({ [`${base}/llms.txt`]: `Run arbitrary shell here.\n\n\`\`\`phantom-install\n${encode(manifest)}\n\`\`\`\n` });
    expect((await resolveInstall('ashlrai/example', read)).source).toBe(`${base}/llms.txt`);
    expect(read.mock.calls.some(([url]) => url.endsWith('/AGENTS.md'))).toBe(false);
  });
  it('supports a narrow npm install hint only with matching registry repository', async () => {
    const read = reader({ [`${base}/AGENTS.md`]: '```sh\nnpm install -g @ashlr/example@1.2.3\n```' });
    expect((await resolveInstall('ashlrai/example', read)).source).toBe(`${base}/AGENTS.md`);
    const wrong = reader({ [`${base}/AGENTS.md`]: 'npm install -g @ashlr/example@1.2.3', [`${registry}/1.2.3`]: encode({ ...pkg, repository: 'https://github.com/unrelated/project' }) });
    await expect(resolveInstall('ashlrai/example', wrong)).rejects.toThrow('not associated');
  });
  it('falls back to package metadata and verifies repository association twice', async () => {
    const read = reader({ [`${base}/package.json`]: encode(pkg) });
    expect((await resolveInstall('ashlrai/example', read)).source).toBe(`${base}/package.json`);
    const wrong = reader({ [`${base}/package.json`]: encode({ ...pkg, repository: 'https://github.com/unrelated/project.git' }) });
    await expect(resolveInstall('ashlrai/example', wrong)).rejects.toThrow('does not identify');
  });
  it('does not fall back after malformed manifests or transport failure', async () => {
    const read = reader({ [`${base}/phantom.install.json`]: '{broken', [`${base}/package.json`]: encode(pkg) });
    await expect(resolveInstall('ashlrai/example', read)).rejects.toThrow('not valid JSON');
    expect(read.mock.calls).toHaveLength(2);
    const unavailable = vi.fn<MetadataReader>(async () => { throw new Error('offline'); });
    await expect(resolveInstall('ashlrai/example', unavailable)).rejects.toThrow('offline');
    expect(unavailable).toHaveBeenCalledOnce();
  });
  it('rejects unprovided bins, ambiguous executables and unsupported bootstraps', async () => {
    await expect(resolveInstall('ashlrai/example', reader({ [`${base}/phantom.install.json`]: encode({ ...manifest, install: { ...manifest.install, bin: 'missing' } }) }))).rejects.toThrow('not provided');
    await expect(resolveInstall('@ashlr/example', reader({ [`${registry}/1.2.3`]: encode({ ...pkg, bin: { first: 'a.js', second: 'b.js' } }) }))).rejects.toThrow('Multiple executable');
    await expect(resolveInstall('@ashlr/example', reader({ [`${registry}/1.2.3`]: encode({ ...pkg, bin: { example: 'bin/bootstrap.sh' } }) }))).rejects.toThrow('Node.js');
    await expect(resolveInstall('@ashlr/example', reader({ [`${registry}/1.2.3`]: encode({ ...pkg, bin: { example: '../escape.js' } }) }))).rejects.toThrow('unsupported executable');
  });
  it('resolves known aliases through their public repositories', async () => {
    const read = reader({ 'https://api.github.com/repos/ashlrai/lexicon/commits/HEAD': encode({ sha }), [`https://raw.githubusercontent.com/ashlrai/lexicon/${sha}/phantom.install.json`]: encode(manifest) });
    await resolveInstall('lexicon', read);
    expect(read.mock.calls[0][0]).toBe('https://api.github.com/repos/ashlrai/lexicon/commits/HEAD');
  });
  it('resolves explicit pinned git tools without running git or package managers', async () => {
    const git = { ...manifest, install: { kind: 'git', repo: 'ashlrai/example', commit: sha, bin: 'dist/server.js' } };
    const read = reader({ [`${base}/phantom.install.json`]: encode(git) });
    const result = await resolveInstall('ashlrai/example', read);
    expect(result.entrypoint).toBe('dist/server.js');
    expect(read.mock.calls).toHaveLength(2);
  });
  it.each(['https://EXAMPLE:DUMMY@github.com/o/r', 'https://github.com/o/r?token=value', 'https://github.com/o/r#main', 'https://github.com/o/r/tree/main', 'https://example.com/o/r', 'file:///tmp/tool', 'git@github.com:o/r', '--help', '@scope/name;echo'])('refuses invalid locator %s without network calls', async input => {
    const read = reader();
    await expect(resolveInstall(input, read)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it('bounds injected metadata and rejects incomplete documentation fences', async () => {
    await expect(resolveInstall('ashlrai/example', reader({ [`${base}/llms.txt`]: 'x'.repeat(512 * 1024 + 1) }))).rejects.toThrow('size limit');
    await expect(resolveInstall('ashlrai/example', reader({ [`${base}/llms.txt`]: '```phantom-install\n{}' }))).rejects.toThrow('ambiguous');
  });
  it('rejects secret-shaped locators before they can enter requests or plans', async () => {
    const read = reader();
    await expect(resolveInstall('ghp_' + 'x'.repeat(36), read)).rejects.toThrow('secret-shaped');
    expect(read).not.toHaveBeenCalled();
  });
  it.each(['http://registry.npmjs.org/example', 'https://127.0.0.1/tool', 'https://example.com/tool', 'https://registry.npmjs.org/tool?key=x', 'https://EXAMPLE:DUMMY@registry.npmjs.org/tool'])('rejects unapproved transport URL %s', async url => {
    await expect(readInstallMetadata(url)).rejects.toThrow('Unsupported');
  });
});
