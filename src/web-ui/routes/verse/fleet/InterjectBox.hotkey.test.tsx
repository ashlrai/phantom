import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { requestSteerFocus } from '../shell/steer-hotkey.js';
import { InterjectBox } from './InterjectBox.js';

it('focuses the steer box without changing its draft', () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ inbox: [] })));
  render(<InterjectBox />);
  const box = screen.getByRole('textbox');
  fireEvent.change(box, { target: { value: 'Keep this draft' } });
  act(() => { requestSteerFocus(); });
  return vi.waitFor(() => {
    expect(box).toHaveFocus();
    expect(box).toHaveValue('Keep this draft');
  }).finally(() => vi.unstubAllGlobals());
});
