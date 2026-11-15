import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { OwnerChannelsStrip } from './OwnerChannelsStrip.js';

afterEach(cleanup);
const gap = (state: 'ok' | 'late' | 'unknown') => [{ teammate: 'Dot', unansweredCount: 2, oldestUnansweredMs: 14 * 60_000, state }];
it('renders a warning chip when a teammate text is late', () => {
  render(<OwnerChannelsStrip paused={false} channels={[]} replyGap={gap('late')} />);
  const chip = screen.getByRole('listitem', { name: 'Dot: 2 unanswered, 14m' });
  expect(chip).toHaveAttribute('data-state', 'late');
});
it('renders nothing extra when answered in time', () => {
  render(<OwnerChannelsStrip paused={false} channels={[{ id: 'desktop', enabled: true, reason: '', nextStep: null }]} replyGap={gap('ok')} />);
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
});
it('says unknown without an evidence source', () => {
  render(<OwnerChannelsStrip paused={false} channels={[]} replyGap={gap('unknown')} />);
  expect(screen.getByText('unknown')).toBeInTheDocument();
});
