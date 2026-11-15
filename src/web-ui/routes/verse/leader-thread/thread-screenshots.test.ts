import { describe, expect, it } from 'vitest';
import { splitScreenshotMarkers } from './thread-screenshots.js';

const NAME = '0123456789abcdef.png';
const SHOT = `/tmp/fake-runs/inbox-attachments/${NAME}`;

describe('splitScreenshotMarkers', () => {
  it('accepts the composer\'s exact output shape', () => {
    // The same line appendAttachmentRef writes (LeaderComposer.attachment.test).
    const text = `hello\n[screenshot: ${SHOT}]`;
    expect(splitScreenshotMarkers(text)).toEqual([
      { kind: 'text', text: 'hello\n' },
      { kind: 'shot', name: NAME, raw: `[screenshot: ${SHOT}]` },
    ]);
  });

  it('finds a marker mid-text and several in one message', () => {
    const second = 'aaaaaaaabbbbbbbb.webp';
    const text = `look [screenshot: ~/Library/Application Support/as/inbox-attachments/${NAME}] and [screenshot: /r/inbox-attachments/${second}] done`;
    expect(splitScreenshotMarkers(text)).toEqual([
      { kind: 'text', text: 'look ' },
      { kind: 'shot', name: NAME, raw: `[screenshot: ~/Library/Application Support/as/inbox-attachments/${NAME}]` },
      { kind: 'text', text: ' and ' },
      { kind: 'shot', name: second, raw: `[screenshot: /r/inbox-attachments/${second}]` },
      { kind: 'text', text: ' done' },
    ]);
  });

  it('returns one text segment when there is no marker', () => {
    expect(splitScreenshotMarkers('just words')).toEqual([{ kind: 'text', text: 'just words' }]);
  });

  it('rejects markers pointing at other directories', () => {
    for (const text of [
      `[screenshot: /tmp/fake-runs/other/${NAME}]`,
      `[screenshot: ${NAME}]`,
      `[screenshot: inbox-attachments/${NAME}]`,
    ]) {
      expect(splitScreenshotMarkers(text), text).toEqual([{ kind: 'text', text }]);
    }
  });

  it('reads only the trailing /inbox-attachments/<name>, whatever the prefix holds', () => {
    // The shown path is never trusted — the route serves `name` from the one
    // stored directory — so a `..` earlier in the path changes nothing.
    const text = `[screenshot: /tmp/inbox-attachments/../inbox-attachments/${NAME}]`;
    expect(splitScreenshotMarkers(text)).toEqual([
      { kind: 'shot', name: NAME, raw: text },
    ]);
  });

  it('rejects names that are not the stored shape', () => {
    for (const bad of [
      '/r/inbox-attachments/0123456789abcde.png',   // 15 hex
      '/r/inbox-attachments/0123456789abcdef1.png', // 17 hex
      '/r/inbox-attachments/0123456789abcdef.PNG',  // stored names are lowercase
      '/r/inbox-attachments/0123456789abcdef.gif',
      '/r/inbox-attachments/0123456789abcdefg.png', // not hex
      '/r/inbox-attachments/0123456789abcdef.png.exe',
    ]) {
      const text = `[screenshot: ${bad}]`;
      expect(splitScreenshotMarkers(text), bad).toEqual([{ kind: 'text', text }]);
    }
  });

  it('rejects other bracket text', () => {
    for (const text of [
      '[note: /r/inbox-attachments/0123456789abcdef.png]',
      '[screenshot:/r/inbox-attachments/0123456789abcdef.png]',
      '[screenshot: /r/inbox-attachments/0123456789abcdef.png',
      'a [screenshot: /r/inbox-attachments/0123456789abcdef.png ] b',
    ]) {
      expect(splitScreenshotMarkers(text), text).toEqual([{ kind: 'text', text }]);
    }
  });
});
