import { screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { BuildFooter } from './BuildFooter.js';
import { renderMobile, stubFetch } from './mobile.test-support.js';

afterEach(() => { evictAll(); vi.unstubAllGlobals(); });

it('shows the running Hub version and master revision rather than the client package constant', async () => {
  stubFetch({ 'GET /api/verse/version': {
    schemaVersion: 1, packageVersion: '9.8.7', revision: 'a'.repeat(40), dirty: true, provenance: 'git',
  } });
  renderMobile(<BuildFooter />);
  expect(await screen.findByText(/Phantom 9.8.7/)).toHaveTextContent('Phantom 9.8.7 · master aaaaaaaaaaaa (modified)');
  expect(screen.getByTitle('a'.repeat(40))).toBeInTheDocument();
});

it('reports unavailable build metadata without inventing a version or sha', async () => {
  stubFetch({ 'GET /api/verse/version': { schemaVersion: 1, packageVersion: null, revision: null, dirty: null, provenance: 'unavailable' } });
  renderMobile(<BuildFooter />);
  expect(screen.getByRole('contentinfo')).toHaveTextContent('version unavailable · master sha unavailable');
});
