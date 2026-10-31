import { fireEvent, render, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { VerseApp } from '../VerseApp.js';
import { registerCommandHandler, resetCommandBus } from './command-bus.js';
import { keyPassesToPage } from '../terminal/panel-keys.js';

afterEach(() => { cleanup(); resetCommandBus(); });

it('dispatches the global interjection chord from a focused non-input element', () => {
  render(createElement(ToastProvider, null, createElement(VerseApp)));
  const handler = vi.fn();
  const unregister = registerCommandHandler('fleet.interject', handler);
  const button = document.createElement('button');
  document.body.appendChild(button);
  button.focus();
  fireEvent.keyDown(button, { key: 'm', code: 'KeyM', ctrlKey: true, altKey: true });
  expect(handler).toHaveBeenCalledOnce();
  expect(keyPassesToPage(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, altKey: true }), 'other')).toBe(true);
  button.remove();
  unregister();
});
