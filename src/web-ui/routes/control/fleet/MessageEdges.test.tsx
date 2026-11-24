import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MapMessage } from '../../../../core/fleet/map-messages.js';
import { isMapMessages } from './fleet-map-queries.js';
import { EDGE_FADE_MS, liveEdges, MessageEdges } from './MessageEdges.js';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const msg = (id: string, ago: number, extra: Partial<MapMessage> = {}): MapMessage => ({ id, from: 'claude', to: 'codex', fromNode: 'lane:claude', toNode: 'lane:codex',
  kind: 'ask', summary: `summary ${id}`, at: new Date(NOW - ago).toISOString(), ...extra });
afterEach(cleanup);

describe('MessageEdges', () => {
  it('draws one edge per recent message and drops those older than 30 seconds', () => {
    const rows = [msg('a', 1_000), msg('b', 29_000, { from: 'leader', fromNode: 'leader' }), msg('old', EDGE_FADE_MS + 1_000)];
    expect(liveEdges(rows, NOW).map(m => m.id)).toEqual(['a', 'b']);
    render(<MessageEdges messages={rows} now={NOW} />);
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'leader to codex, ask' })).toHaveStyle({ animationDelay: '-29000ms' });
  });

  it('shows the summary when an edge is picked, and says so when nothing is live', () => {
    const { rerender } = render(<MessageEdges messages={[msg('a', 1_000)]} now={NOW} />);
    fireEvent.click(screen.getByRole('button', { name: 'claude to codex, ask' }));
    expect(screen.getByRole('status')).toHaveTextContent('claude → codex · ask · summary a');
    rerender(<MessageEdges messages={[]} now={NOW} />);
    expect(screen.getByRole('status')).toHaveTextContent('summary a');
    cleanup();
    render(<MessageEdges messages={[msg('old', 60_000)]} now={NOW} />);
    expect(screen.getByText('No agent messages in the last 30 seconds.')).toBeInTheDocument();
  });

  it('marks an agent the map has no node for', () => {
    const { container } = render(<MessageEdges messages={[msg('a', 1_000, { to: 'mystery', toNode: null })]} now={NOW} />);
    expect(container.querySelector('circle[data-known="false"]')).not.toBeNull();
    expect(container.querySelector('circle[data-known="true"]')).not.toBeNull();
  });

  it('only accepts a well-formed fleet.map-messages.v1', () => {
    const ok = { schema: 'fleet.map-messages.v1', version: 1, messages: [msg('a', 0)] };
    expect(isMapMessages(ok)).toBe(true);
    expect(isMapMessages({ ...ok, messages: null })).toBe(false);
    expect(isMapMessages({ ...ok, messages: [{ id: 'x' }] })).toBe(false);
    expect(isMapMessages({ ...ok, schema: 'other' })).toBe(false);
  });
});
