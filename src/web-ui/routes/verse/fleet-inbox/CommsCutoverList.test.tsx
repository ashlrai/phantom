import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { CommsCutoverList } from './CommsCutoverList.js';
import { readCutover } from './comms-cutover-model.js';

afterEach(cleanup);
const cap = (state: string) => ({ state, reason: `reason-${state}`, nextStep: `next-${state}` });
const view = readCutover({ cutover: { overall: { state: 'incomplete', blockers: [] }, capabilities: {
  emailPolling: cap('ready'), emailOutbox: cap('unsupported'), ownerImessageIntake: cap('unverified'), linkedin: cap('blocked'),
} } })!;

it('lists blocked rows first, then unverified, then the rest', () => {
  render(<CommsCutoverList view={view} />);
  expect(screen.getAllByRole('listitem').map(li => li.textContent?.split(':')[0])).toEqual([
    'LinkedIn', "Mason's iMessage in", 'Email intake', 'Email reply outbox',
  ]);
});
it('shows a copy pill only on rows that are not ready', () => {
  render(<CommsCutoverList view={view} />);
  expect(screen.getAllByRole('button')).toHaveLength(3);
  expect(screen.queryByLabelText(/next step for Email intake/)).not.toBeInTheDocument();
  expect(screen.getByLabelText('Copy the next step for LinkedIn: next-blocked')).toBeInTheDocument();
});
it('words unsupported as Not on this Mac and shows the headline', () => {
  render(<CommsCutoverList view={view} />);
  expect(screen.getByText(/Email reply outbox: Not on this Mac/)).toBeInTheDocument();
  expect(screen.getByText('Off Grok Bot: 1 of 8 ready')).toBeInTheDocument();
});
