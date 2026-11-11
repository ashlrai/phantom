import { fireEvent, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { renderMobile } from '../mobile.test-support.js';
import { MoreScreen } from './MoreScreen.js';

it('opens Goals and Ideas from the "Go to" rows beside Feed', () => {
  const { context } = renderMobile(<MoreScreen />);
  fireEvent.click(screen.getByRole('button', { name: /^Goals/ }));
  expect(context.navigate).toHaveBeenCalledWith({ screen: 'goals' });
  fireEvent.click(screen.getByRole('button', { name: /^Ideas/ }));
  expect(context.navigate).toHaveBeenCalledWith({ screen: 'ideas' });
});
