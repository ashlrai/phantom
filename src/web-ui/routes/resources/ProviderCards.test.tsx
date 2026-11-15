import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { buildResourceView } from '../../../core/fabric/resource-view.js';
import { burnDownInput, ProviderCards } from './ProviderCards.js';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const iso = (h: number) => new Date(NOW + h * 3_600_000).toISOString();
const view = buildResourceView({ readings: {
  'claude-max': { pool: 'claude-max', pctUsed: 40, resetAt: iso(3), fetchedAt: iso(0), source: 'claude-max-reader', burnRatePctPerHour: 10 },
} }, NOW);

describe('ProviderCards', () => {
  it('renders a card per provider with monograms, unknown readings and no chart for them', () => {
    render(<ProviderCards view={view} />);
    for (const name of ['OpenAI', 'Anthropic', 'Cognition / Devin', 'xAI']) expect(screen.getByRole('article', { name: `${name} capacity` })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Anthropic mark' })).toHaveTextContent('A');
    expect(screen.getByRole('article', { name: 'xAI capacity' })).toHaveTextContent('Highest used unknown');
    expect(screen.getAllByText(/No burn-down/).length).toBe(5);
    expect(screen.getByRole('article', { name: 'Local models capacity' })).toHaveTextContent('Local models: unknown');
    expect(screen.getByText('40.0% used')).toBeInTheDocument();
  });
  it('only builds burn-down input from a complete reading', () => {
    const pools = Object.fromEntries(view.pools.map(p => [p.pool, p]));
    expect(burnDownInput(pools['terra']!, view.generatedAt)).toBeNull();
    const input = burnDownInput(pools['claude-max']!, view.generatedAt)!;
    expect(input.points.map(p => p.remaining)).toEqual([70, 60]);
  });
});
