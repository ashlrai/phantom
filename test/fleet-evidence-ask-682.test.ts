import { describe, expect, it } from 'vitest';
import { LIVE_EVIDENCE_SIGNALS, isLiveEvidenceAsk } from '../src/core/fleet/evidence-ask.js';

const EVIDENCE_TEXT = 'Please recheck the current runtime rather than relying on yesterday’s blocked state. Return sanitized evidence of runtime identity, a fresh shared context/claims read, and the existing owner of the Example bridge. If this reply worker still can’t reach live state, report the exact missing bridge instead of claiming dispatch.';

describe('isLiveEvidenceAsk', () => {
  it('lists five signal groups', () => { expect(LIVE_EVIDENCE_SIGNALS).toHaveLength(5); });
  it('accepts a paraphrase of the owner evidence ask', () => { expect(isLiveEvidenceAsk(EVIDENCE_TEXT)).toBe(true); });
  it('accepts two groups in different words', () => {
    expect(isLiveEvidenceAsk('re-verify live state, then give me the bridge owner')).toBe(true);
  });
  it.each([
    ['short recheck', 'recheck'],
    ['PR recheck', 'recheck PR #5315 please'],
    ['long release order', `Ship the release once CI is green. ${'Cut the tag, update the changelog and notify the team. '.repeat(10)}`],
    ['only one group', 'Please return the runtime identity of the host and nothing else, thanks.'],
    ['empty', ''],
    ['over 4000 chars', `${EVIDENCE_TEXT} ${'x'.repeat(4000)}`],
  ])('rejects %s', (_name, text) => { expect(isLiveEvidenceAsk(text)).toBe(false); });
  it('rejects non-strings', () => {
    for (const v of [undefined, null, 5, {}, []]) expect(isLiveEvidenceAsk(v as unknown as string)).toBe(false);
  });
});
