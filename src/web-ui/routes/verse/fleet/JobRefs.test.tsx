import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { JobRefs } from './JobRefs.js';

afterEach(cleanup);

it('renders actionable job and pull request references with their surrounding text', () => {
  const onOpenJob = vi.fn();
  const { container } = render(<JobRefs text="launched (RQ-PHX-FOO), merged ashlrai/phantom #1719." onOpenJob={onOpenJob} />);
  const button = screen.getByRole('button', { name: 'Open log for RQ-PHX-FOO' });
  expect(button).toHaveAttribute('type', 'button');
  fireEvent.click(button);
  expect(onOpenJob).toHaveBeenCalledWith('RQ-PHX-FOO');
  const link = screen.getByRole('link', { name: '#1719' });
  expect(link).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/1719');
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(container).toHaveTextContent('launched (RQ-PHX-FOO), merged ashlrai/phantom #1719.');
});
