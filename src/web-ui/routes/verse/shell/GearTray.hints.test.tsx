import { createRef } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { setHintSettings } from '../hints/hint-settings.js';
import { GearTray } from './GearTray.js';

const probe = vi.hoisted(() => ({ imported: vi.fn(), rendered: vi.fn() }));
vi.mock('../hints/HintNavigation.js', () => {
  probe.imported();
  return { default: ({ blocked }: { blocked: boolean }) => {
    probe.rendered(blocked);
    return <div data-testid="hint-probe" data-blocked={String(blocked)} />;
  } };
});
afterEach(cleanup);

it('never imports disabled hints, loads after enabling, keeps the same gate through overlay blocking, and honors persisted opt-in', async () => {
  localStorage.clear();
  setHintSettings({ enabled: false, chord: 'ctrl-alt-h' });
  const props = { open: false, anchorRef: createRef<HTMLButtonElement>(), onClose: vi.fn(), compact: false };
  const view = render(<GearTray {...props} />);
  expect(probe.imported).not.toHaveBeenCalled();
  expect(probe.rendered).not.toHaveBeenCalled();
  act(() => setHintSettings({ enabled: true, chord: 'ctrl-alt-h' }));
  await waitFor(() => expect(screen.getByTestId('hint-probe')).toHaveAttribute('data-blocked', 'false'));
  expect(probe.imported).toHaveBeenCalledTimes(1);
  view.rerender(<GearTray {...props} hintBlocked />);
  expect(screen.getByTestId('hint-probe')).toHaveAttribute('data-blocked', 'true');
  view.rerender(<GearTray {...props} open />);
  expect(screen.getByTestId('hint-probe')).toHaveAttribute('data-blocked', 'true');
  act(() => setHintSettings({ enabled: false, chord: 'ctrl-alt-h' }));
  expect(screen.getByTestId('hint-probe')).toBeInTheDocument();
  expect(probe.imported).toHaveBeenCalledTimes(1); // Warm owner stays mounted to drain consumed keys.
  view.unmount();
  // A fresh mounted tray reads the persisted setting, rather than waiting for a settings-change event.
  setHintSettings({ enabled: true, chord: 'ctrl-shift-h' });
  render(<GearTray {...props} />);
  expect(await screen.findByTestId('hint-probe')).toHaveAttribute('data-blocked', 'false');
});
