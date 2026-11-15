/**
 * RouteErrorBoundary.report.test.tsx — a caught render crash posts exactly
 * one report to /api/verse/desktop-errors with the route surface, and the
 * fallback still renders (RQ-PHX-DESKTOPCRASHREPORT100).
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../data/auth-store.js';
import { RouteErrorBoundary } from './RouteErrorBoundary.js';

const MUTATION_TOKEN = 'a'.repeat(64);
const PATH = '/api/verse/desktop-errors';

function Broken(): never {
  throw new Error('render exploded');
}

describe('RouteErrorBoundary crash reporting', () => {
  afterEach(() => {
    clearMutationToken();
    vi.unstubAllGlobals();
  });

  it('posts one report with the route surface and still renders the fallback', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) =>
      new Response('{"ok":true,"recorded":true}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    setMutationToken(MUTATION_TOKEN);

    render(<RouteErrorBoundary resetKey="/fleet"><Broken /></RouteErrorBoundary>);

    expect(screen.getByRole('alert')).toHaveTextContent('This view hit an error');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe(PATH);
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['x-ashlr-token']).toBe(MUTATION_TOKEN);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.surface).toBe('route:fleet');
    expect(body.message).toBe('render exploded');
    expect(typeof body.stack).toBe('string');
    expect(body.appVersion).toBeTruthy();
  });

  it('sends nothing when no mutation token is held', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    render(<RouteErrorBoundary resetKey="/fleet"><Broken /></RouteErrorBoundary>);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
