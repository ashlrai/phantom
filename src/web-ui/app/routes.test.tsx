import { Suspense } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, useNavigate } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from './routes.js';

vi.mock('../components/layout/Shell.js', () => ({
  Shell: () => <><span>Persistent shell</span><Navigation /><Suspense fallback={<p>Loading</p>}><Outlet /></Suspense></>,
}));
vi.mock('../routes/fleet-dashboard/FleetDashboardView.js', () => ({
  FleetDashboardView: () => <h1>Overview loaded</h1>,
}));
vi.mock('../routes/control/fleet/FleetView.js', () => ({
  FleetView: () => <h1>Fleet loaded</h1>,
}));

function Navigation() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/control/fleet')}>Open fleet</button>;
}

describe('AppRoutes', () => {
  it('loads routes on navigation while retaining the shell', async () => {
    render(<MemoryRouter initialEntries={['/overview']}><AppRoutes /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: 'Overview loaded' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open fleet' }));
    expect(await screen.findByRole('heading', { name: 'Fleet loaded' })).toBeInTheDocument();
    expect(screen.getByText('Persistent shell')).toBeInTheDocument();
  });
});
