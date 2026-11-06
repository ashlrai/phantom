import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { Composer, type ComposerProps } from '../Composer.js';
import * as dock from '../dock/dock-store.js';
import '../fleet-inbox/fleet-inbox.pane.js';
import { CLAUDE_SEAT } from '../fixtures.test-support.js';
import { registerPane } from '../panes/pane-registry.js';

function setup() {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 404 })));
  const open = vi.spyOn(dock, 'openDockPane');
  const props: ComposerProps = {
    seats: [CLAUDE_SEAT], seat: { seatId: 'claude-main', model: 'claude-opus-5' }, engine: 'claude',
    running: false, disabled: false, locked: false, onSend: vi.fn(), onStop: vi.fn(), onSeatChange: vi.fn(),
  };
  render(<Composer {...props} />);
  const box = screen.getByRole('textbox', { name: 'Message' });
  const submit = (text: string) => { fireEvent.change(box, { target: { value: text } }); fireEvent.keyDown(box, { key: 'Enter' }); };
  return { box, open, props, submit };
}

beforeEach(() => { evictAll(); localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

it('opens the Inbox pane and clears the draft', () => {
  const { box, open, props, submit } = setup();
  submit('/pane inbox');
  expect(open).toHaveBeenCalledWith('fleet-inbox');
  expect(screen.getByRole('status')).toHaveTextContent("Opened Leaders' inbox");
  expect(box).toHaveValue('');
  expect(props.onSend).not.toHaveBeenCalled();
});

it('keeps ambiguous and unknown commands in the draft', () => {
  const unregister = registerPane({ id: 'fleet-inbox-extra', title: 'Inbox extra', icon: () => null, component: () => null });
  try {
    const { box, open, props, submit } = setup();
    submit('/pane inbox');
    expect(screen.getByRole('alert')).toHaveTextContent("Leaders' inbox, Inbox extra");
    expect(box).toHaveValue('/pane inbox');
    submit('/pane missing');
    expect(screen.getByRole('alert')).toHaveTextContent('No pane named missing');
    expect(box).toHaveValue('/pane missing');
    expect(open).not.toHaveBeenCalled();
    expect(props.onSend).not.toHaveBeenCalled();
  } finally {
    unregister();
  }
});
