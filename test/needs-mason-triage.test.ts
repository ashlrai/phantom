import { expect, it } from 'vitest';
import { classifyNeedsItem, triageNeedsItems } from '../src/core/fleet/needs-mason-triage.js';

it.each([
  ['secrets', ['macOS Keychain prompt needs one click', 'Enter a password', 'sign in prompt', '~/.codex auth repair', 'API key required']],
  ['money', ['Approve the $40/mo plan', 'Review billing', 'subscription upgrade', 'cancel subscription']],
  ['outside-send', ['send the LinkedIn reply to Jane', 'LinkedIn post pending', 'comms.toml approval', 'publish to an outside person']],
  ['destroy-data', ['force-push main to drop the bad commit', 'drop database fixture', 'DNS change', 'rm -rf fake-dir']],
] as const)('retains %s requests', (limit, texts) => {
  for (const text of texts) expect(classifyNeedsItem(text)).toMatchObject({ class: 'hard-limit', limit });
});

it.each(['Release v3.30.1 is waiting on Merge Gate', 'unpark RQ-FOO-1'])('automates recognized item %s', text => {
  expect(classifyNeedsItem(text)).toEqual({ class: 'auto', reason: 'outside the four hard limits' });
});

it.each(['Pick the fixture colour', 'tokenizer refactor', 'repurchaseable color', 'design review', 'skill cleanup', 'consigned boxes'])('defaults unknown item %s to needs-Mason', text => {
  // Unrecognized text is never auto, and substrings ("design", "skill", "token") do not trip a keyword.
  expect(classifyNeedsItem(text)).toEqual({ class: 'hard-limit', limit: 'unrecognized', reason: 'unrecognized item defaults to needs-Mason' });
});

it.each([
  'signing', 'click Always Allow for the signing wrapper', 'codesign the app', 'notarize v3.31', 'notarization pending',
  'attestation gate refused', 'provenance missing', 'standing authority renewal', 'approve the new device', 'device approval',
  'KILL is set', 'grants needed', 'grant the scope',
])('keeps authority request %s for Mason', text => {
  expect(classifyNeedsItem(text)).toMatchObject({ class: 'hard-limit', limit: 'authority' });
});

it.each(['add API credits', 'spend cap', 'cost overrun', 'top-up the account', 'quota purchase', 'charge the card'])('keeps money request %s for Mason', text => {
  expect(classifyNeedsItem(text)).toMatchObject({ class: 'hard-limit', limit: 'money' });
});

it('does not let a keyword hide inside an auto-looking item', () => {
  expect(classifyNeedsItem('unpark RQ-FOO-1 and spend credits')).toMatchObject({ class: 'hard-limit' });
});
it('uses hard-limit precedence and ignores case', () => {
  expect(classifyNeedsItem('PAYMENT for a TOKEN')).toMatchObject({ limit: 'secrets' });
});
it('partitions items while preserving their fields', () => {
  const auto = { id: 'a', text: 'unpark RQ-JOB-1', extra: 1 }, hard = { id: 'b', text: 'wipe disk', extra: 2 };
  expect(triageNeedsItems([auto, hard])).toEqual({ auto: [auto], hardLimit: [{ ...hard, limit: 'destroy-data', reason: 'destroy data or change DNS' }] });
  expect(triageNeedsItems([])).toEqual({ auto: [], hardLimit: [] });
});
