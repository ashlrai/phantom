/** RQ-PHX-COORDLEDGERROW325 — the strip renders the Claims ledger row from the new read. Fake agents only. */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { CoordAnswerStrip } from './CoordAnswerStrip.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

it('shows live agent names in the Claims ledger row', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/verse/fleet/coordination-claims') {
      return json({
        v: 1, generatedAt: new Date().toISOString(), state: 'known', expiredClaims: 0,
        claims: [
          { agent: 'agent-alpha', repo: 'fake-repo', task: 'fake-task', expiresInSeconds: 300 },
          { agent: 'agent-beta', repo: 'fake-repo', task: 'fake-task', expiresInSeconds: 200 },
        ],
      });
    }
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<CoordAnswerStrip visible={true} />);

  await waitFor(() => expect(screen.getByText(/2 live · agents agent-alpha, agent-beta/)).toBeInTheDocument());
  expect(screen.getByText('Claims ledger')).toBeInTheDocument();
});
