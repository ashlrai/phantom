import { describe, expect, it } from 'vitest';
import { decisionPrUrl } from './decision-link.js';

describe('decisionPrUrl', () => {
  it('links a fully qualified repository and positive PR number', () => {
    expect(decisionPrUrl('ashlrai/phantom', 1938)).toBe('https://github.com/ashlrai/phantom/pull/1938');
    expect(decisionPrUrl('owner.name/repo_name-1', 1)).toBe('https://github.com/owner.name/repo_name-1/pull/1');
  });

  it('does not guess owners or accept malformed repositories', () => {
    for (const repo of ['phantom', '/phantom', 'owner/repo/extra', 'owner/repo\n', 'owner/repo?x']) {
      expect(decisionPrUrl(repo, 1)).toBeNull();
    }
  });

  it('requires a positive integer PR number', () => {
    for (const number of [null, 0, -1, 1.5, NaN, Infinity]) {
      expect(decisionPrUrl('ashlrai/phantom', number)).toBeNull();
    }
  });
});
