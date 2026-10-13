import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { EcosystemView } from './EcosystemView.js';
import { evictAll } from '../../../data/cache.js';

const REPORT = {
  schemaVersion: 1, kind: 'ashlr-ecosystem-up', generatedAt: new Date().toISOString(), mode: 'status', workspace: '/Users/m/ashlr', ready: false,
  steps: [
    { step: 'github', status: 'already', detail: 'gh is signed in' },
    { step: 'grant', status: 'waiting-on-you', detail: 'no active grant (none); signing needs you (Touch ID)', command: 'ashlr ecosystem up   # in your own terminal' },
  ],
  repos: [{ name: 'locus', nameWithOwner: 'ashlrai/locus', path: '/Users/m/ashlr/locus', present: 'found', enrolled: true, autoMerge: false, defaultBranch: 'main', requiredChecks: ['test'], verifyRequired: false, inGrant: false, ok: false, fixes: [{ why: 'auto-merge is off', command: 'gh repo edit ashlrai/locus --enable-auto-merge' }] }],
  grantScope: { repos: ['ashlrai/locus'], allowed: ['open pull requests'], reserved: ['release tags and package publishing'] },
  nextCommand: 'ashlr ecosystem up',
};

describe('EcosystemView', () => {
  beforeEach(() => evictAll());
  afterEach(() => vi.unstubAllGlobals());

  it('shows per-repo status, exact fixes, reserved actions and the Enable autonomy button', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(REPORT), { status: 200 })));
    render(<MemoryRouter><EcosystemView /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('locus')).toBeInTheDocument());
    expect(screen.getByText('gh repo edit ashlrai/locus --enable-auto-merge')).toBeInTheDocument();
    expect(screen.getByText(/release tags and package publishing/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable autonomy' })).toBeEnabled();
  });

  it('has an actionable empty/error state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })));
    render(<MemoryRouter><EcosystemView /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/Ecosystem status could not load/)).toBeInTheDocument());
  });
});
