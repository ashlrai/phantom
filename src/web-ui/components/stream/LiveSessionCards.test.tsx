import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { evictAll } from '../../data/cache.js';
import { LiveSessionCards } from './LiveSessionCards.js';

const NOW_ISO = new Date().toISOString();

const RUNNING = {
  id: 'r-live',
  goal: 'polish the observability layer',
  status: 'running',
  engine: 'codex',
  provider: 'openai',
  engineModel: 'codex:gpt-5.5',
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
  budget: { maxTokens: 100000, maxSteps: 50, allowCloud: true },
  usage: { tokensIn: 12000, tokensOut: 3000, steps: 3, estCostUsd: 0.42 },
  tasks: [
    { id: 't1', goal: 'scaffold the cards', deps: [], status: 'done' },
    { id: 't2', goal: 'wire the live strip', deps: ['t1'], status: 'running' },
  ],
  steps: [{ ts: NOW_ISO, taskId: 't2', kind: 'tool', summary: 'edited ShowView' }],
};

const DONE = { ...RUNNING, id: 'r-done', status: 'done', goal: 'a finished run' };

function mockFetch(runs: unknown[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/run/')) {
      const id = url.slice('/api/run/'.length).split('?')[0]!.replace(/\/events$/, '');
      const run = runs.find((r) => (r as { id: string }).id === id);
      return run ? new Response(JSON.stringify(run), { status: 200 }) : new Response('not found', { status: 404 });
    }
    if (url.startsWith('/api/runs')) return new Response(JSON.stringify(runs), { status: 200 });
    return new Response('not found', { status: 404 });
  });
}

function renderCards() {
  return render(
    <MemoryRouter>
      <LiveSessionCards />
    </MemoryRouter>,
  );
}

describe('LiveSessionCards', () => {
  beforeEach(() => {
    evictAll();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders nothing when no run is live', async () => {
    vi.stubGlobal('fetch', mockFetch([DONE]));
    const { container } = renderCards();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByText('a finished run')).not.toBeInTheDocument();
  });

  it('shows engine, model, phase and last event for a running run', async () => {
    vi.stubGlobal('fetch', mockFetch([RUNNING, DONE]));
    renderCards();
    await waitFor(() => expect(screen.getByText('polish the observability layer')).toBeInTheDocument());
    expect(screen.getByText('codex')).toBeInTheDocument();
    expect(screen.getByText('codex:gpt-5.5')).toBeInTheDocument();
    expect(screen.getByText('wire the live strip')).toBeInTheDocument();
    expect(screen.getByText(/edited ShowView/)).toBeInTheDocument();
    expect(screen.getByText('1/2 tasks')).toBeInTheDocument();
    expect(screen.getByText(/accounted tok/)).toBeInTheDocument();
    // The finished run never appears as a live session.
    expect(screen.queryByText('a finished run')).not.toBeInTheDocument();
    // Jump into the full run view.
    expect(screen.getByRole('link', { name: 'Open run →' })).toHaveAttribute('href', '/work/runs/r-live');
  });

  it('opens the live stream dialog from the card', async () => {
    vi.stubGlobal('fetch', mockFetch([RUNNING]));
    renderCards();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Watch live' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Watch live' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Watching live' })).toBeInTheDocument();
  });
});
