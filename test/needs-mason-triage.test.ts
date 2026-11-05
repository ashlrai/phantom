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

it.each(['Release v3.30.1 is waiting on Merge Gate', 'unpark RQ-FOO-1', 'tokenizer refactor', 'repurchaseable color'])('automates %s', text => {
  // "token" must not match "tokenizer".
  expect(classifyNeedsItem(text)).toEqual({ class: 'auto', reason: 'outside the four hard limits' });
});
it('uses hard-limit precedence and ignores case', () => {
  expect(classifyNeedsItem('PAYMENT for a TOKEN')).toMatchObject({ limit: 'secrets' });
});
it('partitions items while preserving their fields', () => {
  const auto = { id: 'a', text: 'unpark job', extra: 1 }, hard = { id: 'b', text: 'wipe disk', extra: 2 };
  expect(triageNeedsItems([auto, hard])).toEqual({ auto: [auto], hardLimit: [{ ...hard, limit: 'destroy-data', reason: 'destroy data or change DNS' }] });
  expect(triageNeedsItems([])).toEqual({ auto: [], hardLimit: [] });
});
