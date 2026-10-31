import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LimitsPanel } from './LimitsPanel.js';
import type { UsageLimitRow } from './usage-model.js';

function row(backend: string, usedPct: number | null): UsageLimitRow {
  return {
    id: backend,
    backend,
    window: 'five_hour',
    max: 100,
    used: usedPct,
    usedPct,
    standing: usedPct === null ? 'unknown' : 'warn',
    configuredOnly: usedPct === null,
  };
}

describe('LimitsPanel Claude session limits', () => {
  it.each([85, null])('does not present a retired Claude reading (used: %s)', (usedPct) => {
    render(<LimitsPanel rows={[row('claude', usedPct)]} capsNote={null} />);

    expect(screen.getByText('per week')).toHaveAttribute('data-retired', 'true');
    expect(screen.getByText('per week')).toHaveAttribute(
      'title',
      'Anthropic removed the 5-hour limit on this plan. Only the weekly window applies.',
    );
    expect(screen.getByText('weekly only')).toBeInTheDocument();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.queryByText('warn')).not.toBeInTheDocument();
    expect(screen.queryByText('85 / 100')).not.toBeInTheDocument();
  });

  it('retains the Codex session meter and its reading', () => {
    render(<LimitsPanel rows={[row('codex', 85)]} capsNote={null} />);

    expect(screen.getByText('per five hour')).not.toHaveAttribute('data-retired');
    expect(screen.getByRole('meter', { name: 'codex dispatches against its five_hour cap' }))
      .toHaveAttribute('aria-valuenow', '85');
    expect(screen.getByText('85 / 100')).toBeInTheDocument();
  });
});
