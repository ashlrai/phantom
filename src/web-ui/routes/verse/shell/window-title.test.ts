import { createElement } from 'react';
import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { formatWindowTitle, useWindowTitle } from './window-title.js';

const badge = { workers: 23, merges: 2, switchesOn: [] as string[] };
const Title = () => { useWindowTitle(); return null; };

afterEach(() => { vi.unstubAllGlobals(); evictAll(); });

describe('formatWindowTitle', () => {
  it('formats known fleet data without inventing missing values', () => {
    expect(formatWindowTitle({ badge: null })).toBe('Phantom');
    expect(formatWindowTitle({ badge })).toBe('Phantom · 23 working · 2 merged/h');
    expect(formatWindowTitle({ badge: { ...badge, workers: 1, merges: null } })).toBe('Phantom · 1 working');
    expect(formatWindowTitle({ badge: { ...badge, switchesOn: ['HOLD'] } })).toBe('Phantom · 23 working · 2 merged/h · switches on');
  });

  it('limits the title to 80 characters', () => {
    const title = formatWindowTitle({ badge: { ...badge, workers: Number.MAX_VALUE, merges: Number.MAX_VALUE, switchesOn: ['HOLD'] } });
    expect(title).toHaveLength(80);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('useWindowTitle', () => {
  it('updates from the shared fleet query and restores the previous title', async () => {
    document.title = 'Previous';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      v: 1, workers: [{ job: 'A' }], leaders: [], mergesLastHour: { count: 1 }, switches: [],
    }), { status: 200 })));
    const view = render(createElement(Title));
    await waitFor(() => expect(document.title).toBe('Phantom · 1 working · 1 merged/h'));
    view.unmount();
    expect(document.title).toBe('Previous');
  });

  it('leaves the title untouched when the route is missing', async () => {
    document.title = 'Previous';
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const view = render(createElement(Title));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(document.title).toBe('Previous');
    view.unmount();
    expect(document.title).toBe('Previous');
  });
});
