import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { formatOperatorGlance, type OperatorGlance } from '../../../../core/fleet/operator-glance.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { fleetControl } from '../command/fixtures.test-support.js';
import { FleetStatusLink } from './FleetStatusLink.js';

const GLANCE_PATH = '/api/verse/fleet/runs/glance';
const now = Date.parse('2026-11-01T12:00:00Z');
const glance = (over: Partial<OperatorGlance> = {}): OperatorGlance => ({
  v: 1, at: '2026-11-01T12:00:00Z', running: 2, target: 4, usagePct: 40, resetsAt: '2026-11-01T15:00:00Z',
  mergesToday: 7, main: 'up', incidents: [], ...over,
});

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('FleetStatusLink glance', () => {
  it('shows the control headline and the same words as the formatter', async () => {
    const control = fleetControl('live', now);
    const g = glance();
    stubSurfaceFetch({ now, routes: { [GLANCE_PATH]: g } });
    render(<FleetStatusLink />);
    const expected = formatOperatorGlance(g, Date.parse(g.at)).split('\n');
    expect(await screen.findByText(expected[0]!)).toBeInTheDocument();
    for (const line of expected) expect(screen.getByText(line)).toBeInTheDocument();
    expect(await screen.findByText(control.headline)).toBeInTheDocument();
  });

  it('renders the glance and Open Fleet without a control state', async () => {
    stubSurfaceFetch({ now, routes: { '/api/verse/fleet/control': null, [GLANCE_PATH]: glance() } });
    render(<FleetStatusLink />);
    expect(await screen.findByText('Running 2 of 4.')).toBeInTheDocument();
    expect(screen.getByTestId('fleet-status-link')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open Fleet/ })).toBeInTheDocument();
  });

  it('keeps the control line unchanged, with no error text, when the glance is 404', async () => {
    const control = fleetControl('live', now);
    stubSurfaceFetch({ now, routes: { [GLANCE_PATH]: null } });
    render(<FleetStatusLink />);
    expect(await screen.findByText(control.headline)).toBeInTheDocument();
    expect(screen.queryByText(/Running \d|Usage|Merges|Main|unknown|error|couldn/i)).toBeNull();
    expect(screen.getByTestId('fleet-status-link').querySelectorAll('p')).toHaveLength(1);
  });

  it('renders nothing when both are absent', async () => {
    const { fetchMock } = stubSurfaceFetch({ now, routes: { '/api/verse/fleet/control': null, [GLANCE_PATH]: null } });
    const view = render(<FleetStatusLink />);
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(view.container).toBeEmptyDOMElement();
  });

  it('gives a down main and incidents the attention tone', async () => {
    stubSurfaceFetch({ now, routes: { [GLANCE_PATH]: glance({ main: 'down', incidents: ['Fake lane stalled'] }) } });
    render(<FleetStatusLink />);
    expect(await screen.findByText('Main needs you.')).toHaveAttribute('data-tone', 'attention');
    expect(screen.getByText('Incidents: Fake lane stalled.')).toHaveAttribute('data-tone', 'attention');
    expect(screen.getByText('Running 2 of 4.')).not.toHaveAttribute('data-tone');
  });
});
