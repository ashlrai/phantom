import { describe, expect, it } from 'vitest';
import { addShotLine, carriesFiles, draftShots, removeShotLine, REPLY_BOX_MAX, shotMarker } from './reply-attachment-model.js';

const PATH = '/tmp/fake-runs/inbox-attachments/0123456789abcdef.png';
const OTHER = '/tmp/fake-runs/inbox-attachments/fedcba9876543210.jpg';

describe('reply attachment model', () => {
  it('puts the screenshot line at the end of the draft, or alone in an empty one', () => {
    expect(addShotLine('', PATH)).toEqual({ text: shotMarker(PATH) });
    expect(addShotLine('  \n', PATH)).toEqual({ text: shotMarker(PATH) });
    expect(addShotLine('look at this  \n', PATH)).toEqual({ text: `look at this\n${shotMarker(PATH)}` });
  });

  it('does not add the same file twice', () => {
    const once = addShotLine('look', PATH).text!;
    expect(addShotLine(once, PATH)).toEqual({ text: once });
  });

  it('refuses a screenshot that would pass the reply box limit, leaving the draft alone', () => {
    const full = 'x'.repeat(REPLY_BOX_MAX - 10);
    expect(addShotLine(full, PATH)).toEqual({ error: 'The message is too long to add the screenshot (limit 6,000 characters).' });
    expect(addShotLine('x'.repeat(REPLY_BOX_MAX - shotMarker(PATH).length - 1), PATH).text).toHaveLength(REPLY_BOX_MAX);
  });

  it('lists each attached screenshot once, in draft order, and ignores other brackets', () => {
    const draft = `a\n${shotMarker(OTHER)}\n[screenshot: /etc/passwd]\n${shotMarker(PATH)}\n${shotMarker(OTHER)}`;
    expect(draftShots(draft)).toEqual([
      { name: 'fedcba9876543210.jpg', raw: shotMarker(OTHER) },
      { name: '0123456789abcdef.png', raw: shotMarker(PATH) },
    ]);
    expect(draftShots('no images here')).toEqual([]);
  });

  it('removes a marker with the line it had to itself, and only the marker from a shared line', () => {
    expect(removeShotLine(`look\n${shotMarker(PATH)}\nmore`, shotMarker(PATH))).toBe('look\nmore');
    expect(removeShotLine(`see ${shotMarker(PATH)} here`, shotMarker(PATH))).toBe('see  here');
    expect(removeShotLine(shotMarker(PATH), shotMarker(PATH))).toBe('');
    expect(removeShotLine(`${shotMarker(PATH)}\n${shotMarker(OTHER)}`, shotMarker(PATH))).toBe(shotMarker(OTHER));
    expect(removeShotLine('untouched', '')).toBe('untouched');
  });

  it('knows a drag that carries files from one that carries text', () => {
    expect(carriesFiles({ types: ['Files'] })).toBe(true);
    expect(carriesFiles({ types: ['text/plain'] })).toBe(false);
    expect(carriesFiles(null)).toBe(false);
  });
});
