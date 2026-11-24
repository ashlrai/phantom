import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { assertLauncherDigestListed } from '../../scripts/canonical-launcher-digests.mjs';

const launcher = readFileSync(new URL('../../bin/ashlr', import.meta.url));
const digests = JSON.parse(readFileSync(new URL('../../scripts/canonical-launcher-digests.json', import.meta.url), 'utf8'));

test('the current launcher digest is listed', () => {
  assert.equal(typeof assertLauncherDigestListed(launcher, digests), 'string');
});

test('the generated-files check rejects a missing current launcher digest', () => {
  assert.throws(() => assertLauncherDigestListed(launcher, []), /missing from the canonical launcher digest list/);
});
