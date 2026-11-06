import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../data/cache.js';
import { APP_VERSION } from '../routes/verse/sections/app-version.js';
import { writeAutoUpdatePolicy } from '../routes/verse/sections/update-auto-model.js';
import { SIDECAR_RESTARTED_EVENT } from './sidecar-restart.js';
import { UpdateReloadBanner } from './UpdateReloadBanner.js';

const flush = async () => { await act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); }); };
let sha: string;
let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  evictAll(); localStorage.clear(); sessionStorage.clear(); vi.useFakeTimers();
  sha = 'aaaaaaa'; reload = vi.fn();
  const realWindow = window;
  const fakeWindow = new Proxy({} as Window, {
    get: (_target, key) => {
      if (key === 'location') return { reload };
      const value = Reflect.get(realWindow, key, realWindow) as unknown;
      return typeof value === 'function' ? value.bind(realWindow) : value;
    },
  });
  vi.stubGlobal('window', fakeWindow);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sourceState: 'healthy', installedVersion: APP_VERSION, headSha: sha })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function restart() {
  render(<><textarea aria-label="Composer" /><UpdateReloadBanner /></>);
  await flush(); sha = 'bbbbbbb';
  act(() => window.dispatchEvent(new Event(SIDECAR_RESTARTED_EVENT)));
  await flush();
}
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

it('counts down and reloads once after a restart with the policy on', async () => {
  writeAutoUpdatePolicy({ enabled: true, quietMinutes: 10 });
  await restart();
  expect(screen.getByRole('status')).toHaveTextContent('Reloading in 15 s');
  await advance(14_000); expect(reload).not.toHaveBeenCalled();
  expect(screen.getByRole('status')).toHaveTextContent('Reloading in 1 s');
  await advance(10_000); expect(reload).toHaveBeenCalledTimes(1);
});

it('pauses while a textarea is focused and resumes after focus leaves', async () => {
  writeAutoUpdatePolicy({ enabled: true, quietMinutes: 10 });
  await restart(); screen.getByLabelText('Composer').focus();
  await advance(20_000);
  expect(screen.getByRole('status')).toHaveTextContent('Paused while you type');
  expect(reload).not.toHaveBeenCalled();
  (screen.getByLabelText('Composer') as HTMLElement).blur();
  await advance(1_000); expect(reload).toHaveBeenCalledTimes(1);
});

it('keeps the page for this sha and asks again for a new one', async () => {
  writeAutoUpdatePolicy({ enabled: true, quietMinutes: 10 });
  await restart(); fireEvent.click(screen.getByRole('button', { name: 'Keep this page' }));
  await advance(20_000); expect(reload).not.toHaveBeenCalled();
  expect(screen.queryByRole('status')).toBeNull();
  sha = 'ccccccc'; act(() => window.dispatchEvent(new Event(SIDECAR_RESTARTED_EVENT)));
  await flush(); expect(screen.getByRole('status')).toHaveTextContent('Reloading in 15 s');
});

it('reacts to policy changes without changing the manual banner', async () => {
  await restart(); expect(screen.queryByText(/Reloading in/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Keep this page' })).toBeNull();
  act(() => writeAutoUpdatePolicy({ enabled: true, quietMinutes: 10 }));
  expect(screen.getByRole('status')).toHaveTextContent('Reloading in 15 s');
  act(() => writeAutoUpdatePolicy({ enabled: false, quietMinutes: 10 }));
  await advance(20_000); expect(reload).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Later' })).toBeInTheDocument();
});


it('does not reload while the document is hidden', async () => {
  writeAutoUpdatePolicy({ enabled: true, quietMinutes: 10 });
  await restart();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  try {
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await advance(20_000);
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Paused while this page is hidden');
  } finally {
    delete (document as { visibilityState?: string }).visibilityState;
  }
});
