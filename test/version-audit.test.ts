import { describe, expect, it, vi } from 'vitest';
import { auditFleet, auditRepository, badgeVersions, catalogBadges, latest, manifest, publicRead, REPOSITORIES, registryBelongsTo, stableVersion } from '../scripts/version-audit.mjs';

const json = (data: unknown) => ({ text: JSON.stringify(data) });
function fixture(options: { version?: string; release?: string; badge?: string; cargo?: boolean; private?: boolean; repo?: string } = {}) {
  return vi.fn(async (url: string) => {
    const version = options.version ?? '1.2.3';
    if (url.includes('/contents/')) {
      if (options.cargo && url.endsWith('package.json')) return { missing: true };
      const content = options.cargo ? `[package]\nname="demo"\nversion="${version}"` : JSON.stringify({ name: '@ashlr/demo', version, private: options.private });
      return json({ encoding: 'base64', content: Buffer.from(content).toString('base64') });
    }
    if (url.includes('/tags?')) return json([{ name: `v${version}` }, { name: 'v99.0.0-rc.1' }]);
    if (url.includes('/releases?')) return json([{ tag_name: options.release ?? version }, { tag_name: '99.0.0', prerelease: true }]);
    if (url.includes('registry.npmjs.org')) return json({ version, repository: `https://github.com/ashlrai/${options.repo ?? 'phantom'}` });
    if (url.includes('crates.io')) return json({ crate: { max_stable_version: version, repository: `https://github.com/ashlrai/${options.repo ?? 'phantom'}` } });
    const repo = 'phantom';
    return { text: `<article><a href="https://github.com/ashlrai/${repo}">repo</a><span data-version="${options.badge ?? version}"></span></article>` };
  });
}

describe('anonymous nightly version audit', () => {
  it('compares stable versions numerically, rejects invalid and prerelease values', () => {
    expect(latest(['v1.9.0', '1.10.0', '2.0.0-rc.1', '01.0.0'])).toBe('1.10.0');
    expect(stableVersion('v1.2.3+build.9')).toBe('1.2.3');
    expect(stableVersion('garbage')).toBeNull();
    expect(stableVersion('1.2.3+invalid_metadata')).toBeNull();
    expect(stableVersion('1.2.3+invalid..metadata')).toBeNull();
  });
  it('rejects registry name collisions and unverified package ownership', async () => {
    expect(registryBelongsTo({ url: 'git+https://github.com/ashlrai/phantom.git' }, 'phantom')).toBe(true);
    expect(registryBelongsTo('https://github.com/other/phantom', 'phantom')).toBe(false);
    expect(registryBelongsTo(undefined, 'phantom')).toBe(false);
    const normal = fixture();
    const result = await auditRepository('phantom', async (url: string) => url.includes('registry.npmjs.org')
      ? json({ version: '99.0.0', repository: 'https://github.com/other/phantom' }) : normal(url));
    expect(result.status).toBe('incomplete');
    expect(result.drift).toEqual([]);
    expect(result.unknown[0].reason).toBe('registry identity unverified');
  });
  it('reads Cargo workspace inheritance and npm privacy', () => {
    expect(manifest('[package]\nname="x"\nversion.workspace=true\n[workspace.package]\nversion="1.2.3"', 'cargo').version).toBe('1.2.3');
    expect(manifest('{"name":"x","version":"1.0.0","private":true}', 'npm').private).toBe(true);
    expect(() => manifest('[workspace]', 'cargo')).toThrow();
  });
  it('does not mistake prose, dependencies or another product for a badge', () => {
    expect(badgeVersions('Dependency 4.5.6 <p>v2.0.0</p>')).toEqual([]);
    expect(catalogBadges('<article><a href="https://github.com/ashlrai/locus"></a><i data-version="9.0.0"></i></article>', 'phantom')).toEqual([]);
    expect(badgeVersions('<img alt="version: v1.2.3"><img src="https://img.shields.io/badge/version-1.2.3-blue">')).toEqual(['1.2.3']);
  });
  it('extracts repository-specific structured softwareVersion', () => {
    const html = '<script type="application/ld+json">{"@graph":[{"codeRepository":"https://github.com/ashlrai/phantom","softwareVersion":"1.2.3"}]}</script>';
    expect(catalogBadges(html, 'phantom')).toEqual(['1.2.3']);
  });
  it('reports fully aligned evidence and encoded scoped npm packages', async () => {
    const read = fixture();
    const result = await auditRepository('phantom', read);
    expect(result.status).toBe('aligned');
    expect(result.drift).toEqual([]);
    expect(read.mock.calls.some(([url]) => url.includes('%40ashlr%2Fdemo'))).toBe(true);
  });
  it('reports release and badge drift separately, suggesting only documentation review', async () => {
    const result = await auditRepository('phantom', fixture({ release: '1.2.2', badge: '1.2.1' }));
    expect(result.status).toBe('drift');
    expect(result.drift).toEqual([
      { source: 'releases', expected: '1.2.3', actual: '1.2.2' },
      { source: 'badges', expected: '1.2.2', actual: '1.2.1' },
    ]);
    expect(result.repairSuggestions[0].scope).toEqual(['docs', 'badges', 'changelog']);
  });
  it('falls back to Cargo and reads crates stable version', async () => {
    const result = await auditRepository('phantom', fixture({ cargo: true }));
    expect(result.status).toBe('aligned');
    expect(result.evidence.find((e: { source: string }) => e.source === 'cargo').version).toBe('1.2.3');
  });
  it('audits virtual Cargo workspaces, member inheritance and npm wrappers', async () => {
    const normal = fixture({ repo: 'locus' });
    const read = async (url: string) => {
      if (url.endsWith('/contents/package.json')) return { missing: true };
      if (url.includes('/contents/')) {
        let content;
        if (url.endsWith('/contents/Cargo.toml')) content = '[workspace.package]\nversion="1.2.3"';
        else if (url.endsWith('Cargo.toml')) content = '[package]\nname="product-cli"\nversion.workspace=true';
        else content = '{"name":"product-wrapper","version":"1.2.3"}';
        return json({ encoding: 'base64', content: Buffer.from(content).toString('base64') });
      }
      return normal(url);
    };
    const result = await auditRepository('locus', read);
    expect(result.packages).toHaveLength(5);
    expect(result.packages.every((p: { version: string }) => p.version === '1.2.3')).toBe(true);
    expect(result.evidence.some((e: { source: string }) => e.source === 'cargo:product-cli')).toBe(true);
    expect(result.evidence.some((e: { source: string }) => e.source === 'npm:product-wrapper')).toBe(true);
    expect(result.unknown.map((e: { source: string }) => e.source)).toEqual(['badges']);
  });
  it('ignores a private monorepo root version when comparing published Stack packages', async () => {
    const normal = fixture({ repo: 'ashlr-stack' });
    const read = async (url: string) => {
      if (url.endsWith('/contents/package.json')) {
        return json({ encoding: 'base64', content: Buffer.from('{"name":"root","version":"0.0.1","private":true}').toString('base64') });
      }
      return normal(url);
    };
    const result = await auditRepository('ashlr-stack', read);
    expect(result.package.version).toBe('1.2.3');
    expect(result.drift).toEqual([]);
  });
  it('preserves confirmed drift when the registry is missing and badges are absent', async () => {
    const normal = fixture({ release: '1.2.2' });
    const read = async (url: string) => url.includes('registry.npmjs.org') ? { missing: true } : url.includes('ashlr.ai/') ? { text: '<p>no badge</p>' } : normal(url);
    const result = await auditRepository('phantom', read);
    expect(result.status).toBe('incomplete');
    expect(result.drift).toHaveLength(1);
    expect(result.unknown.map((e: { source: string }) => e.source)).toEqual(['npm', 'badges']);
  });
  it('marks prerelease manifests incomplete instead of treating them as stable', async () => {
    expect((await auditRepository('phantom', fixture({ version: '2.0.0-rc.1' }))).status).toBe('incomplete');
  });
  it('does not query a registry for private packages', async () => {
    const read = fixture({ private: true });
    await auditRepository('phantom', read);
    expect(read.mock.calls.some(([url]) => /registry.npmjs.org|crates.io/.test(url))).toBe(false);
  });
  it('keeps missing and failed evidence incomplete and never reflects error bodies', async () => {
    const result = await auditRepository('phantom', async () => { throw new Error('sensitive upstream body'); });
    expect(result.status).toBe('incomplete');
    expect(JSON.stringify(result)).not.toContain('sensitive');
    expect(result.drift).toEqual([]);
  });
  it('paginates tags before selecting the newest stable version', async () => {
    const normal = fixture();
    const read = async (url: string) => {
      if (url.includes('/tags?')) return json(url.endsWith('page=1') ? Array.from({ length: 100 }, () => ({ name: '1.0.0' })) : [{ name: '1.2.3' }]);
      return normal(url);
    };
    expect((await auditRepository('phantom', read)).status).toBe('aligned');
  });
  it('marks capped or malformed collections incomplete', async () => {
    const normal = fixture();
    const read = async (url: string) => url.includes('/tags?') ? json(Array.from({ length: 100 }, () => ({ name: '1.2.3' }))) : normal(url);
    expect((await auditRepository('phantom', read)).status).toBe('incomplete');
    expect((await auditRepository('phantom', async () => json({}))).status).toBe('incomplete');
  });
  it('audits all seven repositories and rejects arbitrary targets', async () => {
    const read = fixture();
    const result = await auditFleet(read);
    expect(read.mock.calls.filter(([url]) => url === 'https://ashlr.ai/developer-tools')).toHaveLength(1);
    expect(result.repositories.map((r: { repo: string }) => r.repo)).toEqual(REPOSITORIES.map((r: string) => `ashlrai/${r}`));
    expect(result.toolsUsed).toEqual([]);
    await expect(auditRepository('../other', fixture())).rejects.toThrow('outside fleet');
  });
  it('bounds response bodies and treats a 404 as missing', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response('x'.repeat(2_000_001)));
    try {
      expect(await publicRead('https://ashlr.ai/developer-tools')).toEqual({ missing: true });
      await expect(publicRead('https://ashlr.ai/developer-tools')).rejects.toThrow('response too large');
    } finally { fetch.mockRestore(); }
  });
  it('makes only anonymous GETs and refuses redirects or error body disclosure', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private body', { status: 403 }));
    try {
      await expect(publicRead('https://api.github.com/repos/ashlrai/phantom/tags')).rejects.toThrow('HTTP 403');
      expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' });
      expect(fetch.mock.calls[0][1]?.headers).not.toHaveProperty('Authorization');
    } finally { fetch.mockRestore(); }
  });
});
