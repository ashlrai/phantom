import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetUsagePane } from './FleetUsagePane.js';

const props = { visible: true } as PaneProps;
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();

const win = (over: Record<string, unknown>) => ({ limitReached: false, measured: true, ...over });
const accounts = (windows: Record<string, unknown[]>) => ({
  sampledAt: at(-60_000), refreshing: false,
  accounts: [
    { id: 'claude-1', label: 'Claude Max', provider: 'claude', state: 'observed', authentication: 'signed-in', windows: windows['claude'] ?? [] },
    { id: 'codex-1', label: 'Codex Team', provider: 'codex', state: 'observed', authentication: 'signed-in', windows: windows['codex'] ?? [] },
    { id: 'grok-1', label: 'Grok', provider: 'grok', state: 'observed', authentication: 'signed-in', windows: windows['grok'] ?? [] },
  ],
});

function stub(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes('/api/verse/accounts') ? Response.json(body) : Response.json({}, { status: 404 })));
}

beforeEach(() => { evictAll(); vi.useFakeTimers({ toFake: ['Date'], now: NOW }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const card = (name: string) => screen.getByText(name).closest('li')!;

it('marks how much of a window has gone and how far use sits from an even spend, where the start is known', async () => {
  stub(accounts({
    // A weekly deadline four days out: three of seven days gone.
    claude: [win({ id: 'seven_day', label: 'Weekly', usedPercent: 20, resetsAt: at(4 * DAY), resetProvenance: { kind: 'weekly-deadline', at: at(4 * DAY) } })],
    // The provider's own period: ten of thirty days gone.
    grok: [win({ id: 'grok_unified_monthly', label: 'Monthly', usedPercent: 50, resetsAt: at(20 * DAY), resetProvenance: { kind: 'fixed-period', startsAt: at(-10 * DAY), at: at(20 * DAY) } })],
  }));
  render(<FleetUsagePane {...props} />);
  const weekly = await screen.findByRole('meter', { name: 'Claude Max Weekly used' });
  expect(weekly).toHaveAttribute('aria-valuenow', '20');
  expect(weekly).toHaveAttribute('aria-valuetext', '20% used, 43% of the window gone');
  expect(weekly.querySelector('[data-part="used"]')).toHaveStyle({ width: '20%' });
  expect(weekly.querySelector('[data-part="elapsed"]')).toHaveStyle({ left: '42.9%' });
  const claudePace = card('Claude Max').querySelector('[data-pace]')!;
  expect(claudePace).toHaveAttribute('data-pace', 'behind');
  expect(claudePace.textContent).toMatch(/^43% of the window gone · use is 23 points behind an even spend · began about .+, seven days before its reset$/);

  const monthly = screen.getByRole('meter', { name: 'Grok Monthly used' });
  expect(monthly).toHaveAttribute('aria-valuetext', '50% used, 33% of the window gone');
  const grokPace = card('Grok').querySelector('[data-pace]')!;
  expect(grokPace).toHaveAttribute('data-pace', 'ahead');
  expect(grokPace.textContent).toMatch(/^33% of the window gone · use is 17 points ahead of an even spend · began .+, as the provider reported$/);
  expect(document.querySelector('[data-bar-key]')?.textContent).toContain('how far the window’s time has run');
});

it('draws no mark, no pace line and no key for windows whose start the read does not hold', async () => {
  stub(accounts({
    codex: [win({ id: 'primary', label: 'Primary', usedPercent: 85, resetsAt: at(2 * DAY) })],
    // A provenance that names another reset than the window's is not this window's.
    claude: [win({ id: 'seven_day', label: 'Weekly', usedPercent: 95, resetsAt: at(4 * DAY), resetProvenance: { kind: 'weekly-deadline', at: at(5 * DAY) } })],
  }));
  render(<FleetUsagePane {...props} />);
  const primary = await screen.findByRole('meter', { name: 'Codex Team Primary used' });
  expect(primary).toHaveAttribute('aria-valuetext', '85% used');
  expect(document.querySelector('[data-part="elapsed"]')).toBeNull();
  expect(document.querySelector('[data-pace]')).toBeNull();
  expect(document.querySelector('[data-bar-key]')).toBeNull();
  // Use is not health: a high reading keeps the plain bar, with no status attribute on it.
  for (const meter of screen.getAllByRole('meter')) expect(meter).not.toHaveAttribute('data-tone');
});

it('keeps time gone in words when the use is unread or only a limit flag, and compares nothing', async () => {
  const provenance = { kind: 'fixed-period', startsAt: at(-DAY), at: at(DAY) };
  stub(accounts({
    grok: [
      win({ id: 'a', label: 'Unread', usedPercent: null, resetsAt: at(DAY), resetProvenance: provenance }),
      win({ id: 'b', label: 'Flagged', usedPercent: 100, limitReached: true, measured: false, resetsAt: at(DAY), resetProvenance: provenance }),
    ],
  }));
  render(<FleetUsagePane {...props} />);
  const unread = await screen.findByRole('meter', { name: 'Grok Unread used' });
  expect(unread).toHaveAttribute('data-unread');
  expect(unread).toHaveAttribute('aria-valuetext', 'unknown');
  expect(unread.querySelector('[data-part="elapsed"]')).toBeNull();
  const lines = [...within(card('Grok')).getAllByText(/of the window gone/)];
  expect(lines).toHaveLength(2);
  for (const line of lines) {
    expect(line).toHaveAttribute('data-pace', 'unread');
    expect(line.textContent).toMatch(/^50% of the window gone · began .+, as the provider reported$/);
  }
  expect(screen.getByRole('img', { name: /Grok Flagged: the provider flagged this window as rate-limited/ })).toBeInTheDocument();
  expect(document.querySelector('[data-bar-key]')).toBeNull();
});
