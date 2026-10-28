import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { EMBEDDED_CATALOG } from '../src/core/providers/coding-cli/catalog-defaults.js';
import { loadCatalog, parseCatalog } from '../src/core/providers/coding-cli/catalog.js';

vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  readFileSync: vi.fn(),
}));

describe('packaged coding CLI catalog', () => {
  const read = vi.mocked(readFileSync);

  it('keeps the compiled fallback identical to the operator inventory', async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const source = fs.readFileSync(new URL('../config/coding-cli-models.json', import.meta.url), 'utf8');
    expect(parseCatalog(JSON.stringify(EMBEDDED_CATALOG))).toEqual(parseCatalog(source));
  });

  it('loads independent, validated defaults when the installed package has no config directory', () => {
    read.mockImplementation(() => { throw Object.assign(new Error('missing catalog'), { code: 'ENOENT' }); });
    const first = loadCatalog();
    expect(first).toEqual(parseCatalog(JSON.stringify(EMBEDDED_CATALOG)));
    expect(first.meteredEnabledByDefault).toBe(false);
    expect(first.tiers.frontier.every(row => row.accountStatus !== 'accepted')).toBe(true);
    expect(loadCatalog()).not.toBe(first);
  });

  it('preserves explicit missing paths, permission errors and malformed configuration', () => {
    const missing = Object.assign(new Error('missing catalog'), { code: 'ENOENT' });
    read.mockImplementation(() => { throw missing; });
    expect(() => loadCatalog('/explicit/catalog.json')).toThrow(missing);
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    read.mockImplementation(() => { throw denied; });
    expect(() => loadCatalog()).toThrow(denied);
    read.mockReturnValue('not JSON');
    expect(() => loadCatalog()).toThrow('coding CLI catalog: invalid JSON');
    read.mockReturnValue('{}');
    expect(() => loadCatalog()).toThrow('coding CLI catalog: version');
  });
});
