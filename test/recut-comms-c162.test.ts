/**
 * RQ-PHX-RECUTCOMMSC162 recut coverage for open #5055
 * (RQ-PHX-RECUTCOMMSN1C147, a recut of #5030 — the chain roots at #4073 /
 * RQ-SWE3-IMSGDEEP-1) on current master. The carried suite
 * (recut-comms-n1-s140.test.ts) covers the end-to-end intake and the
 * outside-send gate; this file pins the one surface fact this recut adds:
 *
 *   - imessage-patch-transfer re-exports BOTH leaf exports — isPatchFrameText
 *     and PATCH_FRAME_MARKERS — so callers keep one import surface while
 *     read-only observers keep importing the leaf without the fs/lock graph.
 *   - The leaf's protocol frames are still never reply-worthy: PATCH frames
 *     classify as protocol traffic, ordinary teammate text as conversational.
 *
 * Pure-function asserts only: no fs, no child_process, no real handles.
 */

import { describe, expect, it } from 'vitest';

import { isPatchFrameText, PATCH_FRAME_MARKERS } from '../src/core/comms/imessage-patch-transfer.js';
import * as leaf from '../src/core/comms/imessage-teammate-inbox.js';
import { teammateNeedsReply } from '../src/core/comms/imessage-teammate-inbox.js';

const SHA = 'a'.repeat(64);

describe('patch-transfer one-surface re-export (#5055)', () => {
  it('re-exports the leaf marker list and test unchanged', () => {
    expect(PATCH_FRAME_MARKERS).toBe(leaf.PATCH_FRAME_MARKERS);
    expect(PATCH_FRAME_MARKERS).toEqual(['PATCH-BEGIN', 'PATCH-PART', 'PATCH-END']);
    expect(isPatchFrameText).toBe(leaf.isPatchFrameText);
  });

  it('marks protocol frames as never needing a reply', () => {
    expect(isPatchFrameText(`PATCH-BEGIN fix-1 1 ${SHA}`)).toBe(true);
    expect(teammateNeedsReply(`PATCH-BEGIN fix-1 1 ${SHA}`)).toBe(false);
    expect(teammateNeedsReply('PATCH-PART fix-1 1/1\nchunk')).toBe(false);
    expect(teammateNeedsReply('can you check the gate?')).toBe(true);
  });
});
