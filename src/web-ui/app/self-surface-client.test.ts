// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { inlineImages, runSelfRequest, snapshotPage } from './self-surface-client.js';
import { getVerseUiState } from '../routes/verse/verse-ui-store.js';

afterEach(() => { document.body.innerHTML = ''; });

describe('self-surface client', () => {
  it('snapshots roles, names and stable ids, never input values', () => {
    document.body.innerHTML = '<main><nav><button data-section="fleet" aria-label="Fleet">Fleet</button></nav><h1>Command</h1><input type="password" name="pw" value="hunter2-secret"><input name="q" value="typed text"></main>';
    const snap = snapshotPage();
    const text = JSON.stringify(snap);
    expect(text).toContain('"id":"fleet"');
    expect(text).toContain('Command');
    expect(text).not.toContain('hunter2-secret');
    expect(text).not.toContain('typed text');
    expect(snap).toMatchObject({ overflowX: false, consoleErrors: [] });
  });

  it('clicks and focuses by stable id, refuses password fields and unknown ids', async () => {
    let clicks = 0;
    document.body.innerHTML = '<button data-testid="save">Save</button><input type="password" data-testid="pw">';
    document.querySelector('button')!.addEventListener('click', () => { clicks++; });
    expect(await runSelfRequest({ verb: 'act', testId: 'save', action: 'click' })).toMatchObject({ ok: true, data: { tag: 'button', name: 'Save' } });
    expect(clicks).toBe(1);
    expect(await runSelfRequest({ verb: 'act', testId: 'pw', action: 'focus' })).toMatchObject({ ok: false });
    expect(await runSelfRequest({ verb: 'act', testId: 'missing', action: 'click' })).toMatchObject({ ok: false });
  });

  it('navigates through the verse store and refuses unknown sections', async () => {
    expect(await runSelfRequest({ verb: 'navigate', section: 'settings' })).toMatchObject({ ok: true, data: { section: 'settings' } });
    expect(getVerseUiState().section).toBe('settings');
    expect(await runSelfRequest({ verb: 'navigate', section: 'nowhere' })).toMatchObject({ ok: false });
  });

  it('inlines page images into the capture clone and drops ones it cannot load', async () => {
    document.body.innerHTML = '<img src="/logos/phantom.svg" srcset="/logos/phantom@2x.svg 2x" alt=""><img src="https://cdn.example/x.png" alt=""><img src="data:image/png;base64,AA==" alt="">';
    const clone = document.body.cloneNode(true) as HTMLElement;
    const seen: string[] = [];
    const fetcher = (async (url: string) => {
      seen.push(url);
      if (url.endsWith('phantom.svg')) return { ok: true, blob: async () => new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' }) };
      throw new TypeError('blocked');
    }) as unknown as typeof fetch;
    expect(await inlineImages(document.body, clone, fetcher)).toBe(2);
    const [logo, external, inline] = [...clone.querySelectorAll('img')];
    expect(logo!.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(logo!.hasAttribute('srcset')).toBe(false);
    expect(external!.hasAttribute('src')).toBe(false);
    expect(inline!.getAttribute('src')).toBe('data:image/png;base64,AA==');
    expect(seen).toHaveLength(2);
    expect(document.querySelector('img')!.getAttribute('src')).toBe('/logos/phantom.svg');
  });
});
