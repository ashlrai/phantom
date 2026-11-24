import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { LaneCapBadges } from './LaneCapBadges.js';
import { laneCapBadges } from './lane-caps.js';

const texts = (lane: string) => within(screen.getByRole('list', { name: `${lane} capabilities` })).getAllByRole('listitem').map((e) => e.textContent);

it('shows every capability for an all-true lane', () => {
  render(<LaneCapBadges lane="codex" caps={{ gh: true, browser: true, network: true, signedIn: true }} />);
  expect(texts('codex')).toEqual(['gh', 'browser', 'network', 'signed in']);
});

it('says no gh and explains it in one sentence', () => {
  render(<LaneCapBadges lane="claude" caps={{ gh: false, browser: true, network: true, signedIn: true }} />);
  expect(texts('claude')[0]).toBe('no gh');
  expect(screen.getByText('no gh')).toHaveAttribute('title', 'no gh: jobs that run gh go elsewhere.');
});

it('shows unknown, never a guess, for missing caps', () => {
  render(<LaneCapBadges lane="gemini" caps={undefined} />);
  expect(texts('gemini')).toEqual(['gh: unknown', 'browser: unknown', 'network: unknown', 'signed in: unknown']);
});

it('treats a partial or null capability as unknown', () => {
  expect(laneCapBadges({ gh: true, network: null }).map((b) => b.state)).toEqual(['yes', 'unknown', 'unknown', 'unknown']);
});
