import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LaneAllowanceRow, LaneAllowanceSnapshot } from '../../../../core/usage/lane-allowance.js';
import { apiGet } from '../../../data/client.js';
import { LaneAllowanceCard, LaneAllowanceCards, PoolAllowanceBar } from './LaneAllowanceCards.js';

vi.mock('../../../data/client.js', () => ({ apiGet: vi.fn() }));
let poll: (() => void) | null = null;
vi.mock('../shell/section-visibility.js', () => ({ usePollWhileVisible: (run: () => void) => { poll = run; } }));
vi.mock('../seat-subscription.js', () => ({ useCapacityClock: () => Date.parse('2026-12-02T00:00:00.000Z') }));

const now = Date.parse('2026-12-02T00:00:00.000Z');
const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();
const HOUR = 3_600_000;
const row = (changes: Partial<LaneAllowanceRow> = {}): LaneAllowanceRow => ({ lane: 'claude', label: 'Claude', used: 62, limit: 100,
  left: 38, unit: 'percent', usedPct: 62, resetAt: at(HOUR), resetsInHours: 1, windowStart: null,
  measuredAt: at(-240_000), ageSeconds: 240, freshness: 'live', posture: 'balanced', postureReason: 'fixture',
  costClass: 'included', projectedUnusedPct: null, history: null, reason: null, devin: null, ...changes });
const snapshot = (lanes: LaneAllowanceRow[]): LaneAllowanceSnapshot => ({ v: 1, asOf: at(0), lanes });
const part = (meter: HTMLElement, name: string) => meter.querySelector<HTMLElement>(`[data-part="${name}"]`);

afterEach(() => { vi.resetAllMocks(); poll = null; });

describe('lane allowance card bar', () => {
  it('renders owner pools with their provider mark and keeps unmeasured quota hatched', () => {
    const lanes = [row({ lane: 'agy', label: 'Google AI Ultra · Antigravity',
      measuredAt: null, used: null, limit: null, left: null, usedPct: null, freshness: 'unknown',
      resource: { source: null, sourceTier: null, expiresAt: null, burnPerHour: null, projectedUnused: null },
    })];
    const { container } = render(<PoolAllowanceBar lanes={lanes} expanded now={now} />);
    expect(screen.getByRole('meter', { name: 'Google AI Ultra · Antigravity used' })).toHaveAttribute('data-unread', 'true');
    expect(container.querySelector('[data-provider="gemini"]')).toBeInTheDocument();
    expect(screen.getByText(/Usage unknown · .*Source unknown · Not measured/)).toBeVisible();
  });
  it('renders a custom provider fallback and the measured usage in both resource views', () => {
    const custom = row({ lane: 'custom:studio', label: 'Studio agents',
      resource: { provider: 'Example AI', source: 'cli-status', sourceTier: 'official',
        expiresAt: null, burnPerHour: 2, projectedUnused: 36 },
    });
    const { container } = render(<><PoolAllowanceBar lanes={[custom]} expanded now={now} />
      <ul><LaneAllowanceCard row={custom} now={now} /></ul></>);
    expect(screen.getAllByRole('meter', { name: 'Studio agents used' })).toHaveLength(2);
    expect(container.querySelectorAll('[data-provider="unknown"]')).toHaveLength(2);
    expect(screen.getAllByText(/cli-status/)).toHaveLength(2);
  });
  it('draws the measured share on the shared bar, named for the lane, beside its provider mark', () => {
    render(<LaneAllowanceCard row={row()} now={now} />);
    const meter = screen.getByRole('meter', { name: 'Claude used' });
    expect(meter).toHaveAttribute('aria-valuenow', '62');
    expect(meter).toHaveAttribute('aria-valuetext', '62% used');
    expect(part(meter, 'used')).toHaveStyle({ width: '62%' });
    expect(part(meter, 'more')).toBeNull();
    expect(part(meter, 'unused')).toBeNull();
    expect(part(meter, 'elapsed')).toBeNull();
    expect(screen.getByRole('listitem').querySelector('svg[data-provider="claude"]')).toHaveAttribute('aria-hidden', 'true');
  });

  it('hatches the bar for a lane with no reading: no value, no fill, never 0%', () => {
    render(<LaneAllowanceCard row={row({ used: null, limit: null, left: null, usedPct: 0, measuredAt: null, freshness: 'unknown', reason: 'reading-missing' })} now={now} />);
    const meter = screen.getByRole('meter', { name: 'Claude used' });
    expect(meter).toHaveAttribute('data-unread', 'true');
    expect(meter).not.toHaveAttribute('aria-valuenow');
    expect(meter).toHaveAttribute('aria-valuetext', 'usage unknown');
    expect(meter.querySelector('[data-part]')).toBeNull();
    expect(screen.getByText('unknown — not measured')).toBeVisible();
    expect(screen.getByText('Not measured yet')).toBeVisible();
  });

  it('shows the router projection and the time gone as shares of the bar and as sentences', () => {
    render(<LaneAllowanceCard row={row({ posture: 'burn', projectedUnusedPct: 30, windowStart: at(-3 * HOUR) })} now={now} />);
    const meter = screen.getByRole('meter', { name: 'Claude used' });
    expect(meter).toHaveAttribute('data-ending', 'unused');
    expect(part(meter, 'more')).toHaveStyle({ width: '8%' });
    expect(part(meter, 'unused')).toHaveStyle({ width: '30%' });
    expect(part(meter, 'elapsed')).toHaveStyle({ left: '75%' });
    expect(screen.getByText('About 30% would go unused at the reset, by the router’s projection.')).toHaveAttribute('data-ending', 'unused');
    expect(screen.getByText('75% of the window gone; use is 13 points behind an even spend.')).toHaveAttribute('data-pace', 'behind');
    expect(meter.getAttribute('aria-valuetext')).toContain('About 30% would go unused');
  });

  it('paints the bar dry when the measured burn ends before the reset', () => {
    render(<LaneAllowanceCard row={row({ history: { points: [], burn: { perHour: 80, from: at(-HOUR), to: at(0) }, exhaustAt: at(HOUR / 2), resetAt: at(HOUR) } })} now={now} />);
    const meter = screen.getByRole('meter', { name: 'Claude used' });
    expect(meter).toHaveAttribute('data-ending', 'dry');
    expect(part(meter, 'more')).toHaveStyle({ width: '38%' });
    expect(screen.getByText(/^Runs out about .+, before the reset, at the measured burn\.$/)).toHaveAttribute('data-ending', 'dry');
  });

  it('gives the reset as a countdown and a clock time, and says when it has passed', () => {
    const { unmount } = render(<LaneAllowanceCard row={row()} now={now} />);
    expect(screen.getByText('Resets in 1h 0m')).toBeVisible();
    expect(screen.getByRole('listitem').querySelector('time')).toHaveAttribute('datetime', at(HOUR));
    unmount();
    render(<LaneAllowanceCard row={row({ resetAt: at(-60_000), reason: 'reset-passed' })} now={now} />);
    expect(screen.getByText('Reset time has passed')).toBeVisible();
    expect(screen.queryByText(/Resets in/)).not.toBeInTheDocument();
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', '62% used; its recorded reset has passed');
  });

  it('keeps a stale reading as a last share and projects nothing from it', () => {
    render(<LaneAllowanceCard row={row({ freshness: 'stale', reason: 'reading-stale', posture: 'burn', projectedUnusedPct: 30, windowStart: at(-HOUR) })} now={now} />);
    const meter = screen.getByRole('meter');
    expect(meter).toHaveAttribute('data-ending', 'last');
    expect(part(meter, 'used')).toHaveStyle({ width: '62%' });
    expect(meter.querySelectorAll('[data-part]')).toHaveLength(1);
    expect(screen.queryByText(/would go unused|of the window gone/)).not.toBeInTheDocument();
  });
});

describe('lane allowances section', () => {
  it('counts the lanes measured and explains the bar once a card projects', async () => {
    vi.mocked(apiGet).mockResolvedValue(snapshot([
      row({ posture: 'burn', projectedUnusedPct: 30 }),
      row({ lane: 'devin', label: 'Devin', used: null, limit: null, left: null, usedPct: null, measuredAt: null, freshness: 'unknown' }),
    ]));
    const { container } = render(<LaneAllowanceCards />);
    expect(await screen.findByText('1 of 2 measured')).toBeVisible();
    const key = container.querySelector('[data-allowance-key]')!;
    expect(key).toHaveTextContent('used so far');
    expect(key).toHaveTextContent('left unused at the reset');
    expect(screen.getAllByRole('meter')).toHaveLength(2);
  });

  it('leaves the key out while every card draws only its measured share', async () => {
    vi.mocked(apiGet).mockResolvedValue(snapshot([row()]));
    const { container } = render(<LaneAllowanceCards />);
    expect(await screen.findByText('1 of 1 measured')).toBeVisible();
    expect(container.querySelector('[data-allowance-key]')).toBeNull();
  });

  it('keeps the cards on screen through a refresh, and says so when the refresh fails', async () => {
    vi.mocked(apiGet).mockResolvedValueOnce(snapshot([row()]));
    render(<LaneAllowanceCards />);
    const list = await screen.findByRole('list');
    expect(within(list).getByText('62% used · 38% left')).toBeVisible();

    let answer: (value: LaneAllowanceSnapshot) => void = () => {};
    vi.mocked(apiGet).mockReturnValueOnce(new Promise<LaneAllowanceSnapshot>(resolve => { answer = resolve; }));
    act(() => poll!());
    // The second read is still out: the first cards stay, with no loading line in their place.
    expect(screen.getByText('62% used · 38% left')).toBeVisible();
    expect(screen.queryByText('Reading lane allowances…')).not.toBeInTheDocument();
    await act(async () => { answer(snapshot([row({ used: 70, left: 30, usedPct: 70 })])); });
    expect(screen.getByText('70% used · 30% left')).toBeVisible();

    vi.mocked(apiGet).mockRejectedValueOnce(new Error('offline'));
    await act(async () => { poll!(); });
    expect(screen.getByText('70% used · 30% left')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('The last refresh failed. Showing what was read');
    expect(screen.queryByText('unknown — allowance readings unavailable')).not.toBeInTheDocument();

    vi.mocked(apiGet).mockResolvedValueOnce(snapshot([row()]));
    await act(async () => { poll!(); });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
