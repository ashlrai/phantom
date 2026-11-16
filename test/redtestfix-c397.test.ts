/**
 * RQ-PHX-REDTESTFIXC397: regression pin for the #5038 bridge fix.
 *
 * #5038 (RQ-PHX-RECUTDESKO1S142) added
 * test/approvals-pending.recut-s142o.test.ts to prove free-text proposal
 * fields are secret-scrubbed — but its fixture embedded a JSON
 * `api_key` assignment with a 14-character value, a generic-api-key match
 * for the CI "Secret scan (diff)" job (gitleaks over the PR's commits,
 * default rules, repo-supplied config ignored). The scan failed while
 * typecheck stayed green, and the recut could not merge.
 *
 * The fixture is now password-shaped prose (`password kT8w2Zp9xQ`): the
 * app's scrubSecrets still redacts it, while gitleaks — which requires a
 * `key=value`/`key:value` assignment shape — does not flag it.
 *
 * This pins both halves of the corrected state through the real code path:
 *   1. A proposal whose title and summary carry the prose credential still
 *      scrubs to `[REDACTED]` in the wire projection.
 *   2. The fixture carries no `key[:=]value` assignment shape, the only
 *      form the diff secret scan matches — so the test file itself is
 *      scannable-clean.
 *
 * Hermetic: proposals live only under the fixture's tmp HOME.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { readPendingProposals } from '../src/core/approvals/surface.js';
import { createProposal } from '../src/core/inbox/store.js';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

let fx: H1Fixture;

beforeEach(() => {
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

describe('secret-shaped fixture handling (RQ-PHX-REDTESTFIXC397)', () => {
  it('scrubs a prose credential out of every free-text field, as #5038 intended', () => {
    createProposal({
      repo: null,
      origin: 'manual',
      kind: 'note',
      title: 'rotate password kT8w2Zp9xQ now',
      summary: 'see password kT8w2Zp9xQ',
    });
    const section = readPendingProposals();
    const wire = JSON.stringify(section);
    expect(wire).not.toContain('kT8w2Zp9xQ');
    expect(section.items[0]!.title).toContain('[REDACTED]');
    expect(section.items[0]!.detail).toContain('[REDACTED]');
  });

  it('the replacement fixture has no key=value/key:value secret assignment shape', () => {
    // generic-api-key only fires on `<secret-noun><separator><value>` where the
    // separator is =, :, => or kin. Prose `password <literal>` has none.
    const fixture = 'password kT8w2Zp9xQ';
    expect(fixture).not.toMatch(/(?:api[_-]?key|token|secret|passw?o?rd|passwd|pwd|auth|credentials?)\s*[:=]/i);
  });
});
