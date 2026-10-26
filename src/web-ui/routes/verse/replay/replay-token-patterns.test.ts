import { expect, it } from 'vitest';
import { scrubReplayTokens } from './replay-token-patterns.js';

it.each([
  'sk-' + 'Abc123'.repeat(6),
  'ghp_' + 'Abc123'.repeat(6),
  'github_pat_' + 'Abc123'.repeat(6),
  'xai-' + 'Abc123'.repeat(6),
  'cog_' + 'Abc123'.repeat(6),
  'apk_user_' + 'Abc123'.repeat(6),
  'xoxb-' + 'Abc123'.repeat(6),
  'AKIA' + 'A1B2'.repeat(4),
  'eyJabc.payload.signature',
  'glpat-' + 'Abc123'.repeat(6),
  'hf_' + 'Abc123'.repeat(6),
  'npm_' + 'Abc123'.repeat(6),
  'AIza' + 'Abc123'.repeat(5) + 'Abc12',
  '123456789:' + 'Abc12'.repeat(7),
  'a1'.repeat(32),
  '-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----',
])('redacts a recognized provider credential without Node imports: %s', (credential) => {
  const output = scrubReplayTokens(`Before ${credential} after`);
  expect(output).not.toContain(credential);
  expect(output).toContain('[REDACTED]');
  expect(scrubReplayTokens(output)).toBe(output);
});

it('redacts header values, URL passwords and webhook paths while preserving commit identities', () => {
  expect(scrubReplayTokens('Bearer tiny')).toBe('Bearer [REDACTED]');
  expect(scrubReplayTokens('https://user:opaque@localhost')).not.toContain('opaque');
  expect(scrubReplayTokens('https://hooks.slack.com/services/' + 'abc123/'.repeat(3))).toContain('[REDACTED]');
  const commit = 'a1'.repeat(20);
  expect(scrubReplayTokens(commit)).toBe(commit);
});
