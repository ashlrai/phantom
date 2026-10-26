import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json } from '../context/context-fixtures.test-support.js';
import { revealAnchor } from '../shell/reveal-anchor.js';
import { AgentsSection } from './AgentsSection.js';
vi.mock('../agents/AgentsBoard.js', () => ({ AgentsBoard: () => <div>Coding board fixture</div> }));
beforeEach(() => { evictAll(); });
afterEach(() => { evictAll(); vi.unstubAllGlobals(); });
function installProactiveFetch() {
  return installFetch(call => {
    if (call.path === '/api/verse/proactive-agents/coordination') return json({ schemaVersion: 1,
      revision: 0, tasks: [], packetDestinations: [], sourceState: 'missing', planningOnly: true, transport: 'unavailable' });
    if (call.path === '/api/verse/proactive-agents') return json({ schemaVersion: 1, profiles: [] });
    throw new Error(`Unexpected agent-view request: ${call.path}`);
  });
}
describe('agent views', () => {
  it('keeps coding as default without proactive reads, then loads the actual profile view on selection', async () => {
    const { calls } = installProactiveFetch();
    render(<AgentsSection />);
    expect(screen.getByText('Coding board fixture')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole('radio', { name: 'Proactive agents' }));
    await screen.findByText('Bring your persistent agents together');
    expect(calls.map(call => [call.method, call.path]).sort()).toEqual([
      ['GET', '/api/verse/proactive-agents'],
      ['GET', '/api/verse/proactive-agents/coordination'],
    ]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Proactive agents' })).toHaveAttribute('aria-checked', 'true');
  });
  it('accepts the existing Resources navigation intent before its lazy section mounts', async () => {
    installProactiveFetch();
    render(<div data-surface="agents"><AgentsSection /></div>);
    await revealAnchor({ section: 'agents', anchor: 'proactive-agents' });
    await screen.findByText('Bring your persistent agents together');
    expect(screen.queryByText('Coding board fixture')).not.toBeInTheDocument();
  });
});
