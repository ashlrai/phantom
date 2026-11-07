import { describe, expect, it } from 'vitest';
import { parseDeepLink } from '../shell/deep-link.js';
import { paneLinkUrl } from './pane-link.js';

describe('paneLinkUrl', () => {
  const base = 'http://127.0.0.1:7777/verse/?chat=old&pane=old&keep=1#section';

  it('rejects malformed pane ids and normalizes legacy ids', () => {
    for (const id of ['', 'Bad Pane', '../terminal', 'a'.repeat(41)]) expect(paneLinkUrl(id, null, false, base)).toBeNull();
    expect(parseDeepLink(new URL(paneLinkUrl('preview', null, false, base)!).search)).toEqual({ paneId: 'browser', sessionId: null });
  });

  it('includes a valid chat only when the pane needs a session', () => {
    const withChat = paneLinkUrl('terminal', 'chat-42', true, base)!;
    expect(withChat).toBe('http://127.0.0.1:7777/verse/?keep=1&chat=chat-42&pane=terminal');
    expect(parseDeepLink(new URL(withChat).search)).toEqual({ paneId: 'terminal', sessionId: 'chat-42' });
    for (const link of [paneLinkUrl('fleet-lanes', 'chat-42', false, base), paneLinkUrl('terminal', null, true, base), paneLinkUrl('terminal', '../bad', true, base)]) {
      expect(parseDeepLink(new URL(link!).search)?.sessionId).toBeNull();
    }
  });
});
