import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('docs/REMOTE-PHONE.md phone section', () => {
  const phoneMd = readFileSync('docs/REMOTE-PHONE.md', 'utf-8');
  const policyTs = readFileSync('src/core/web/remote-gateway-policy.ts', 'utf-8');

  it('contains the "What the phone can see and do" heading', () => {
    assert.ok(
      phoneMd.includes('## What the phone can see and do'),
      'Expected the new section heading to exist in docs/REMOTE-PHONE.md',
    );
  });

  it('extracts all /api/verse/... paths from the new section and verifies they exist in READ_ROUTES', () => {
    // Extract the section text (from heading to next heading or end)
    const sectionStart = phoneMd.indexOf('## What the phone can see and do');
    const nextSectionStart = phoneMd.indexOf('## ', sectionStart + 1);
    const sectionText = nextSectionStart !== -1
      ? phoneMd.slice(sectionStart, nextSectionStart)
      : phoneMd.slice(sectionStart);

    // Extract every /api/verse/... path from the section (table content)
    const docPaths = [
      ...sectionText.matchAll(/\/api\/verse\/[A-Za-z0-9/._-]+/g),
    ].map((m) => m[0]);

    assert.ok(docPaths.length > 0, 'Expected at least one /api/verse/... path in the section');

    // Extract paths ONLY from the READ_ROUTES Set constructor block,
    // not from route-matching patterns inside validateRemoteMutation.
    // Find the text between 'new Set<RemoteReadRoute>(' and the closing ')' of the Set constructor.
    const setStart = policyTs.indexOf('new Set<RemoteReadRoute>(');
    const setClose = policyTs.indexOf(')', setStart);
    const setBlock = policyTs.slice(setStart, setClose + 1);

    // Extract quoted /api/verse/... paths from just the Set constructor
    const policyPaths = [
      ...setBlock.matchAll(/['"]\/api\/verse\/[A-Za-z0-9/._-]+['"]/g),
    ].map((m) => m[0].slice(1, -1)); // strip surrounding quotes

    assert.ok(policyPaths.length > 0, 'Expected READ_ROUTES entries in remote-gateway-policy.ts');

    // Every path listed in the documentation must exist in READ_ROUTES
    for (const docPath of docPaths) {
      assert.ok(
        policyPaths.includes(docPath),
        `Documented path "${docPath}" must exist in READ_ROUTES of src/core/web/remote-gateway-policy.ts`,
      );
    }

    // Reverse: every READ_ROUTES path should appear in the documentation
    // (the doc should cover the full set)
    for (const policyPath of policyPaths) {
      assert.ok(
        docPaths.includes(policyPath),
        `READ_ROUTES path "${policyPath}" must appear in the documentation`,
      );
    }
  });
});
