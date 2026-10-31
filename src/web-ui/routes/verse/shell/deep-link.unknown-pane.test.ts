import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDockState, openPaneInChat, resetDockStore } from '../dock/dock-store.js';
import { parseDeepLink, resolveDeepLinkPane } from './deep-link.js';

describe('deep-link pane resolution', () => {
  beforeEach(() => { localStorage.clear(); resetDockStore(); });

  it('ignores unknown ids and opens known ids after parsing', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const isKnown = (id: string) => id === 'fleet-hub';
    const unknown = parseDeepLink('?pane=missing')!;
    expect(unknown.paneId).toBe('missing');
    const rejected = resolveDeepLinkPane(unknown.paneId, isKnown);
    if (rejected) openPaneInChat(rejected);
    expect(rejected).toBeNull();
    expect(getDockState().tabs).toEqual([]);
    expect(info).toHaveBeenCalledOnce();
    const known = resolveDeepLinkPane(parseDeepLink('?pane=fleet-hub')!.paneId, isKnown);
    if (known) openPaneInChat(known);
    expect(getDockState()).toMatchObject({ tabs: ['fleet-hub'], active: 'fleet-hub' });
  });
});
