import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

describe('Leader push service worker', () => {
  it('shows fixed content and opens only allowed paths', async () => {
    const handlers: Record<string, (event: unknown) => void> = {};
    const showNotification = vi.fn(async () => undefined);
    const openWindow = vi.fn(async (_path: string) => undefined);
    const self = { addEventListener: (name: string, fn: (event: unknown) => void) => { handlers[name] = fn; },
      registration: { showNotification }, clients: { matchAll: async () => [], openWindow }, location: { origin: 'https://example.test' } };
    runInNewContext(readFileSync('src/web-ui/public/verse-m/sw.js', 'utf8'), { self, URL });
    let pending: Promise<unknown> = Promise.resolve();
    handlers.push!({ data: { json: () => ({ kind: 'leader-reply', count: 1, detail: 'private reply' }) }, waitUntil: (p: Promise<unknown>) => { pending = p; } });
    await pending;
    expect(showNotification).toHaveBeenCalledWith('Phantom', expect.objectContaining({ body: 'The Leader replied. Open Phantom to read it.', tag: 'ashlr-leader-reply', data: { path: '/verse/m/#/leader' } }));
    for (const path of ['/verse/m/#/leader', '/untrusted']) {
      handlers.notificationclick!({ notification: { data: { path }, close: vi.fn() }, waitUntil: (p: Promise<unknown>) => { pending = p; } });
      await pending;
    }
    expect(openWindow.mock.calls.map(call => call[0])).toEqual(['/verse/m/#/leader', '/verse/m/#/needs']);
  });
});
