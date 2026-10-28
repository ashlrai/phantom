import { describe, expect, it, vi } from 'vitest';
import { appendFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
vi.mock('node:fs/promises', () => ({ appendFile: vi.fn().mockResolvedValue(undefined) }));
import { GROK_USAGE_DOM_READ, readGrokUsage, type VerifiedGrokPage } from '../src/core/fabric/readers/grok-usage.js';

const now = () => new Date('2026-10-26T20:46:00.000Z');
const pin: VerifiedGrokPage = {
  url: 'https://grok.com/settings/usage', verifiedAt: now().toISOString(),
  referencePctUsed: 68, referenceResetAt: '2026-11-02T01:21:00.000Z',
};

describe('Grok weekly pool reader', () => {
  it('logs an unavailable session as unknown with fixed provenance', async () => {
    await readGrokUsage({ now, logPath: 'usage-readings.log' });
    expect(appendFile).toHaveBeenCalledWith('usage-readings.log', expect.any(String), { mode: 0o600 });
    const line = vi.mocked(appendFile).mock.calls.at(-1)![1];
    expect(JSON.parse(String(line))).toMatchObject({ source: 'grok-reader', used: 'unknown', pctUsed: null });
  });
  it.each([
    ['<section>Grok Ultra Weekly Cursor 68% used <time datetime="2026-11-02T01:21:00Z"></time></section>', 68],
    ['<section>API weekly 68% used <time datetime="2026-11-02T01:21:00Z"></time></section>', null],
    ['<section>Grok Ultra Weekly Cursor 68% used 40% used <time datetime="2026-11-02T01:21:00Z"></time></section>', null],
    ['<section>Grok Ultra Weekly Cursor 68% used</section>', null],
  ])('extracts only unambiguous rendered weekly pool data', (html, expected) => {
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    // jsdom does not implement rendered innerText.
    for (const el of dom.window.document.querySelectorAll('section')) {
      Object.defineProperty(el, 'innerText', { value: el.textContent });
    }
    const result = JSON.parse(dom.window.eval(GROK_USAGE_DOM_READ));
    expect(result?.pctUsed ?? null).toBe(expected);
    dom.window.close();
  });
  it('does not probe an unverified page or guess from the manual reference', async () => {
    const readPage = vi.fn();
    expect(await readGrokUsage({ now, readPage })).toMatchObject({ pctUsed: null, resetAt: null });
    expect(readPage).not.toHaveBeenCalled();
  });
  it('returns only numeric usage and reset from the verified weekly pool', async () => {
    const readPage = vi.fn().mockResolvedValue({ pctUsed: 69.5, resetAt: pin.referenceResetAt, ignored: 'TEST private page content' });
    expect(await readGrokUsage({ now, verifiedPage: pin, readPage })).toEqual({
      pool: 'grok-ultra', pctUsed: 69.5, resetAt: pin.referenceResetAt, source: 'grok-reader', fetchedAt: now().toISOString(),
    });
  });
  it.each([null, {}, { pctUsed: -1, resetAt: pin.referenceResetAt },
    { pctUsed: 101, resetAt: pin.referenceResetAt }, { pctUsed: '68', resetAt: pin.referenceResetAt },
    { pctUsed: 68, resetAt: '2026-11-03T01:21:00Z' }, { pctUsed: 68, resetAt: 'Sunday' }])('fails closed for missing or different pool data: %j', async value => {
    expect(await readGrokUsage({ now, verifiedPage: pin, readPage: async () => value })).toMatchObject({ pctUsed: null, resetAt: null });
  });
  it('scrubs automation failures', async () => {
    expect(await readGrokUsage({ now, verifiedPage: pin, readPage: async () => { throw new Error('TEST private content'); } }))
      .toMatchObject({ pctUsed: null });
  });
  it.each(['https://example.com/settings/usage', 'https://grok.com/dashboard?private=TEST', 'https://grok.com/chat'])('rejects non-usage locations: %s', async url => {
    const readPage = vi.fn();
    await readGrokUsage({ now, verifiedPage: { ...pin, url }, readPage });
    expect(readPage).not.toHaveBeenCalled();
  });
  it('requires re-verification after the weekly reset', async () => {
    const readPage = vi.fn();
    await readGrokUsage({ now: () => new Date('2026-11-03'), verifiedPage: pin, readPage });
    expect(readPage).not.toHaveBeenCalled();
  });
});
