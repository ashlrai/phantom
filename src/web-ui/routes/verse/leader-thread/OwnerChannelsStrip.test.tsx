import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { OwnerChannelsStrip } from './OwnerChannelsStrip.js';

const channel = (id: string, enabled = true) => ({ id, enabled, reason: 'Not configured', nextStep: 'Configure it' });
afterEach(cleanup);
it('orders channels and expands the next step for an off channel', () => {
  render(<OwnerChannelsStrip paused={false} channels={[channel('email'), channel('owner-test-1'), channel('slack'), channel('telegram', false), channel('imessage'), channel('desktop')]} />);
  const list = screen.getByRole('list', { name: 'Owner channels' });
  expect(within(list).getAllByRole('listitem').map(item => item.getAttribute('aria-label'))).toEqual(['Desktop live', 'iMessage live', 'Telegram off', 'Slack live', 'Email live', 'owner-test-1 live']);
  const off = within(list).getByRole('listitem', { name: 'Telegram off' });
  expect(off).toHaveAttribute('title', 'Configure it');
  fireEvent.click(within(off).getByText('Telegram off'));
  expect(within(off).getByText('Configure it')).toBeVisible();
});
it('shows only a paused chip when paused', () => {
  render(<OwnerChannelsStrip paused channels={[channel('desktop')]} />);
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  expect(screen.getByText('Channels paused')).toBeInTheDocument();
});
it('renders nothing without channels', () => {
  const { container } = render(<OwnerChannelsStrip paused={false} channels={[]} />);
  expect(container).toBeEmptyDOMElement();
});
