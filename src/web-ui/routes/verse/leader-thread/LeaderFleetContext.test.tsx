import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { LeaderFleetContext } from './LeaderFleetContext.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

afterEach(() => { evictAll(); vi.unstubAllGlobals(); });

describe('Leader fleet context', () => {
  it('uses fixed evidence views, distinguishes zero, and restores keyboard focus on close', () => {
    const open = vi.fn();
    render(<LeaderFleetContext evidence={{ routing: null, lanes: 2, delivery: 0 }} onOpen={open} />);
    const toggle = screen.getByRole('button', { name: 'Fleet context' });
    expect(screen.queryByRole('region', { name: 'Fleet context' })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    const context = within(screen.getByRole('region', { name: 'Fleet context' }));
    expect(context.getByText('Unknown')).toBeInTheDocument();
    fireEvent.click(context.getByRole('button', { name: 'Lanes' }));
    expect(context.getByText('2')).toBeInTheDocument();
    fireEvent.click(context.getByRole('button', { name: 'Delivery' }));
    expect(context.getByText('0')).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(context.getByRole('button', { name: 'Open merge evidence' }));
    expect(open).toHaveBeenCalledExactlyOnceWith('fleet-merges');
    fireEvent.keyDown(context.getByRole('button', { name: 'Delivery' }), { key: 'Escape' });
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it.each([
    { mergeSource: 'healthy', expected: '7' },
    { mergeSource: 'degraded', expected: 'Unknown' },
  ])('keeps the composer and uses only trusted delivery evidence from a $mergeSource source', async ({ mergeSource, expected }) => {
    const request = stubSurfaceFetch({ routes: {
      '/api/verse/leader/thread': { messages: [] },
      '/api/verse/leader/directives': { directives: [] },
      '/api/verse/fleet/runs': { inbox: [], sources: { merges: mergeSource }, mergesLastHour: { count: 7, items: [] } },
    } });
    render(<LeaderThreadPane visible />);
    const composer = screen.getByRole('textbox', { name: 'Reply to the Leader' });
    fireEvent.change(composer, { target: { value: 'Keep this unsent' } });
    await screen.findByText('All quiet');
    fireEvent.click(screen.getByRole('button', { name: 'Fleet context' }));
    const context = within(screen.getByRole('region', { name: 'Fleet context' }));
    fireEvent.click(context.getByRole('button', { name: 'Delivery' }));
    expect(await context.findByText(expected)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Reply to the Leader' })).toBe(composer);
    expect(composer).toHaveValue('Keep this unsent');
    expect(request.fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });
});
