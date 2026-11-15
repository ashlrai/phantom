import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { changelogSection, readInstalledChangelog } from '../src/core/verse/changelog-read.js';
import { handleWhatsNewApi } from '../src/core/verse/whats-new-api.js';

const FIXTURE = `# Changelog

## [3.30.28](https://github.com/example/phantom/compare/v3.30.27...v3.30.28) (2026-11-09)

### Features

* **verse:** show [release notes](https://example.com/notes) in the card ([#4321](https://example.com/pull/4321)) ([abc1234](https://example.com/commit/abc1234))
* plain bullet (#4321)

### Bug Fixes

- dash bullet ([abc1234def](https://example.com/commit/abc1234def))

## [3.30.27](https://example.com/compare) (2026-11-08)

* older change only in 3.30.27
`;

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('changelogSection', () => {
  it('returns only the requested version, links reduced to text, refs stripped', () => {
    expect(changelogSection(FIXTURE, '3.30.28')).toEqual([
      '**verse:** show release notes in the card',
      'plain bullet',
      'dash bullet',
    ]);
    expect(changelogSection(FIXTURE, '3.30.27')).toEqual(['older change only in 3.30.27']);
  });

  it('accepts a bare "## x.y.z" heading', () => {
    expect(changelogSection('## 1.2.3\n\n* hi\n', '1.2.3')).toEqual(['hi']);
  });

  it('returns null for an absent version and never prefix-matches', () => {
    expect(changelogSection(FIXTURE, '3.30.29')).toBeNull();
    expect(changelogSection(FIXTURE, '3.30.2')).toBeNull();
    expect(changelogSection(FIXTURE, '3.30')).toBeNull();
  });

  it('caps at 8 bullets', () => {
    const md = `## 1.0.0\n${Array.from({ length: 12 }, (_, i) => `* item ${i}`).join('\n')}\n`;
    expect(changelogSection(md, '1.0.0')).toHaveLength(8);
  });
});

describe('readInstalledChangelog', () => {
  it('reads CHANGELOG.md from the root; missing file or version is null', () => {
    const root = mkdtempSync(join(tmpdir(), 'changelog-original-251s-'));
    dirs.push(root);
    expect(readInstalledChangelog('3.30.28', root)).toBeNull();
    writeFileSync(join(root, 'CHANGELOG.md'), FIXTURE);
    expect(readInstalledChangelog('3.30.28', root)).toHaveLength(3);
    expect(readInstalledChangelog('9.9.9', root)).toBeNull();
  });
});

describe('GET /api/verse/whats-new', () => {
  function call(url: string, method = 'GET', read: (v: string) => string[] | null = () => ['a']) {
    const res = { writeHead: vi.fn(), end: vi.fn(), setHeader: vi.fn(), statusCode: 0 } as unknown as ServerResponse;
    const handled = handleWhatsNewApi({ url } as IncomingMessage, res, '/api/verse/whats-new', method, read);
    const raw = (res.end as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const status = (res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? res.statusCode;
    return { handled, status, body: raw ? JSON.parse(String(raw)) : null };
  }

  it.each(['/api/verse/whats-new?version=1.2', '/api/verse/whats-new?version=../x', '/api/verse/whats-new'])('400s %s', (url) => {
    expect(call(url).status).toBe(400);
  });

  it('returns bullets, or null when the version has no entry', () => {
    expect(call('/api/verse/whats-new?version=1.2.3').body).toEqual({ version: '1.2.3', bullets: ['a'] });
    expect(call('/api/verse/whats-new?version=1.2.3', 'GET', () => null).body).toEqual({ version: '1.2.3', bullets: null });
  });

  it('405s non-GET', () => {
    expect(call('/api/verse/whats-new?version=1.2.3', 'POST').status).toBe(405);
  });
});
