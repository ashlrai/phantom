import { describe, expect, it } from 'vitest';
import { mirrorByChannel, mirrorHint } from './channel-bus-mirror.js';

const now = Date.parse('2026-10-31T05:00:00Z');
const entry = (source: string, at = now) => ({ source, at: new Date(at).toISOString(), text: 'fake message' });

describe('channel bus mirrors — local-only channels', () => {
  it('iMessage inbox rows within the hour count inbox but never mirror', () => {
    const inbox = [entry('imessage', now), entry('imessage', now)];
    const rows = mirrorByChannel(inbox, [], now);
    const im = rows.get('imessage');
    expect(im).toEqual({ inbox: 2, mirrored: 0, tone: 'none', text: 'kept local: 2 in the last hour, not mirrored to the bus' });
  });

  it('mirrorHint("none", "available") is null', () => {
    expect(mirrorHint('none', 'available')).toBeNull();
  });

  it('an email row with zero receipts still gives tone warn (unchanged behavior)', () => {
    const inbox = [entry('email', now)];
    const rows = mirrorByChannel(inbox, [], now);
    expect(rows.get('email')).toMatchObject({ inbox: 1, mirrored: 0, tone: 'warn' });
  });
});
