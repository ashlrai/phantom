import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderMobile } from '../mobile.test-support.js';
import { MoreScreen } from './MoreScreen.js';

describe('MoreScreen — Go to', () => {
  it.each([
    ['Leaders', 'leader'],
    ['Agents', 'agents'],
    ['Inbox', 'inbox'],
  ])('navigates from %s', (title, destination) => {
    const { context } = renderMobile(<MoreScreen />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${title}`) }));
    expect(context.navigate).toHaveBeenCalledWith({ screen: destination });
  });
});
