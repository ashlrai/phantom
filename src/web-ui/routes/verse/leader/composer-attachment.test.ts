import { describe, expect, it } from 'vitest';
import { appendAttachmentRef, ATTACHMENT_MAX_BYTES, checkImage, pickImage } from './composer-attachment.js';
import { LEADER_MESSAGE_MAX } from './thread-model.js';

const png = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' });

describe('checkImage', () => {
  it('accepts png, jpeg and webp within the limit', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp']) expect(checkImage({ type, size: 10 })).toBeNull();
    expect(checkImage({ type: 'image/png', size: ATTACHMENT_MAX_BYTES })).toBeNull();
  });
  it('refuses other types, empty and oversize files', () => {
    expect(checkImage({ type: 'image/gif', size: 10 })).toMatch(/PNG, JPEG or WebP/);
    expect(checkImage({ type: 'image/png', size: 0 })).toMatch(/empty/);
    expect(checkImage({ type: 'image/png', size: ATTACHMENT_MAX_BYTES + 1 })).toMatch(/8 MiB/);
  });
});

describe('pickImage', () => {
  it('takes the first image file, else the first image item, else null', () => {
    const text = new File(['x'], 't.txt', { type: 'text/plain' });
    expect(pickImage({ files: [text, png] as unknown as FileList, items: [] as unknown as DataTransferItemList })).toBe(png);
    const items = [{ kind: 'file', type: 'image/png', getAsFile: () => png }] as unknown as DataTransferItemList;
    expect(pickImage({ files: [] as unknown as FileList, items })).toBe(png);
    expect(pickImage({ files: [text] as unknown as FileList, items: [] as unknown as DataTransferItemList })).toBeNull();
    expect(pickImage(null)).toBeNull();
  });
});

describe('appendAttachmentRef', () => {
  it('appends the ref on its own line, or stands alone for an empty message', () => {
    expect(appendAttachmentRef('look at this  \n', '/tmp/x/a.png')).toEqual({ text: 'look at this\n[screenshot: /tmp/x/a.png]' });
    expect(appendAttachmentRef('  ', '/tmp/x/a.png')).toEqual({ text: '[screenshot: /tmp/x/a.png]' });
  });
  it('returns an error string when the line would not fit', () => {
    const r = appendAttachmentRef('a'.repeat(LEADER_MESSAGE_MAX - 5), '/tmp/x/a.png');
    expect(r.text).toBeUndefined();
    expect(r.error).toMatch(/too long/);
  });
});
