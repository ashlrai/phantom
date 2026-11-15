import { fireEvent, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { renderMobile } from '../mobile.test-support.js';
import { MoreScreen } from './MoreScreen.js';

it('opens the Feed from the first "Go to" row', () => {
  const { context } = renderMobile(<MoreScreen />);
  const row = screen.getByRole('button', { name: /^Feed/ });
  expect(row).toHaveTextContent('Your news, alerts and fleet updates in one stream');
  fireEvent.click(row);
  expect(context.navigate).toHaveBeenCalledWith({ screen: 'feed' });
});
