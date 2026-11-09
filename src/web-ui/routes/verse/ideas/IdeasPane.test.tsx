import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { IdeasPane } from './IdeasPane.js';

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); });

const item = (i: number, repo = 'org/alpha', extra: object = {}) => ({ id: `id${i}`, title: `Idea ${i}`, repo, score: 100 - i, source: 'issue', ...extra });

describe('IdeasPane', () => {
  it('shows the absent state for a null backlog', async () => {
    stubSurfaceFetch({ routes: { '/api/backlog': () => new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } }) } });
    render(<IdeasPane />);
    expect(await screen.findByText(/No backlog has been built yet/)).toBeInTheDocument();
  });

  it('renders an array response grouped by repo', async () => {
    stubSurfaceFetch({ routes: { '/api/backlog': [item(1), item(2, 'org/beta', { source: 'red main' })] } });
    render(<IdeasPane />);
    expect(await screen.findByText('2 candidates across 2 repos. Top: Idea 1')).toBeInTheDocument();
    expect(screen.getByText('score 98 · red main')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'org/beta' })).toBeInTheDocument();
  });

  it('renders an { items } response', async () => {
    stubSurfaceFetch({ routes: { '/api/backlog': { items: [item(1)] } } });
    render(<IdeasPane />);
    expect(await screen.findByText('1 candidate across 1 repo. Top: Idea 1')).toBeInTheDocument();
  });

  it('says the backlog is empty', async () => {
    stubSurfaceFetch({ routes: { '/api/backlog': [] } });
    render(<IdeasPane />);
    expect(await screen.findByText(/The backlog is empty/)).toBeInTheDocument();
  });

  it('shows an error as an alert', async () => {
    stubSurfaceFetch({ routes: { '/api/backlog': () => new Response(JSON.stringify({ error: 'backlog unreadable' }), { status: 500, headers: { 'Content-Type': 'application/json' } }) } });
    render(<IdeasPane />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/backlog unreadable|failed|HTTP 500/);
  });

  it('expands and collapses a repo group', async () => {
    stubSurfaceFetch({ routes: { '/api/backlog': Array.from({ length: 7 }, (_, i) => item(i)) } });
    render(<IdeasPane />);
    const toggle = await screen.findByRole('button', { name: 'Show 2 more' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Idea 6')).toBeNull();
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText('Idea 6')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders markup in a title as text', async () => {
    stubSurfaceFetch({ routes: { '/api/backlog': [item(1, 'org/alpha', { title: '<script>alert(1)</script>' })] } });
    const { container } = render(<IdeasPane />);
    expect(await screen.findByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
  });
});
