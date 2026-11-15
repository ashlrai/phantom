import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../data/cache.js';
import { installFetch, json } from './context/context-fixtures.test-support.js';
import { resetVerseUi } from './verse-ui-store.js';
import { SidebarResources } from './SidebarResources.js';
import { describeRuntimeIdentity } from './runtime-identity-row.js';

vi.mock('./resources/DotResourceRow.js', () => ({ DotResourceRow: () => null }));

const NOW = Date.parse('2026-11-14T19:32:40Z');
function snap(over: Record<string, unknown> = {}) {
  return {
    v: 1, authority: 'none', generatedAt: '2026-11-14T19:32:00Z',
    snapshot: { host: 'fake-host', tailnetName: 'fake-tailnet', installedVersion: '3.30.34', asOf: '2026-11-14T19:32:00Z', reasons: [], ...over },
  };
}
const serve = (body: unknown, status = 200) =>
  installFetch(({ path }) => path === '/api/verse/fleet/runtime-identity/snapshot' ? json(body, status) : json({}, 404));

beforeEach(() => { evictAll(); resetVerseUi(); vi.useFakeTimers({ toFake: ['Date'], now: NOW }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('runtime identity row in the Resources sidebar', () => {
  it('shows host, version and read age in the ok tone', async () => {
    serve(snap());
    render(<SidebarResources />);
    const row = await screen.findByText('runtime fake-host · v3.30.34 · read 40s ago');
    expect(row.getAttribute('data-tone')).toBe('ok');
  });

  it('turns amber when the reading is older than 5 minutes', async () => {
    serve(snap({ asOf: '2026-11-14T19:25:40Z' }));
    render(<SidebarResources />);
    const row = await screen.findByText('runtime fake-host · v3.30.34 · read 7m ago');
    expect(row.getAttribute('data-tone')).toBe('stale');
  });

  it('turns red "runtime unreachable" on fetch failure', async () => {
    serve({ error: 'x' }, 503);
    render(<SidebarResources />);
    const row = await screen.findByText('runtime unreachable');
    expect(row.getAttribute('data-tone')).toBe('down');
  });

  it('shows unknown for a missing version, never a guess', async () => {
    serve(snap({ installedVersion: 'UNKNOWN' }));
    render(<SidebarResources />);
    expect(await screen.findByText('runtime fake-host · vunknown · read 40s ago')).toBeVisible();
  });
});

describe('describeRuntimeIdentity', () => {
  it('prints unknown for missing host and unparseable read time', () => {
    const row = describeRuntimeIdentity({ v: 1, authority: 'none', generatedAt: '', snapshot: { asOf: 'nope' } } as never, null, NOW);
    expect(row).toEqual({ tone: 'stale', text: 'runtime unknown · vunknown · read unknown' });
  });
});
