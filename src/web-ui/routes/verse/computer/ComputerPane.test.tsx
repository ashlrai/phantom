import { cleanup, render, screen, act } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { NativeComputerStateEvent } from './native-computer.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { ComputerPane } from './ComputerPane.js';
import { nativeComputer } from './native-computer.js';

vi.mock('./native-computer.js', () => ({ nativeComputer: vi.fn(() => null) }));
afterEach(cleanup);
const props = { visible: true } as PaneProps;

it('explains unavailable native control without requesting any access', () => {
  render(<ComputerPane {...props} />);
  expect(screen.getByText(/requires a supported Phantom desktop shell/)).toBeVisible();
});

it('subscribes to native status while visible and releases the listener', () => {
  let listener: ((event: NativeComputerStateEvent) => void) | undefined;
  const off = vi.fn();
  vi.mocked(nativeComputer).mockReturnValue({ version: 1, send: vi.fn(), request: vi.fn(), onState: (fn) => { listener = fn; return off; } });
  const view = render(<ComputerPane {...props} />);
  act(() => listener?.({ kind: 'state', state: 'paused' }));
  expect(screen.getByText('Desktop control: paused.')).toBeVisible();
  view.rerender(<ComputerPane {...props} visible={false} />);
  expect(off).toHaveBeenCalledOnce();
});
