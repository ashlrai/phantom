import { expect, it } from 'vitest';
import type { ReleaseChainStatus } from '../../../../core/fleet/release-chain-status.js';
import { releaseChainLine } from './release-chain-line.js';

it('renders a failed chain with unproven version evidence', () => {
  const status: ReleaseChainStatus = {
    verdict: 'failed', reason: 'Signing failed',
    latestAutorun: { sha: 'abcd', rc: 1, mtime: '2026-01-01T00:00:00Z' },
    version: null, installedVersion: null, sources: [],
    evidence: { versionJoin: 'none', feedRc: null, feedState: null, boundLog: null, diagnostics: [] },
  };
  expect(releaseChainLine(status, Date.parse('2026-01-01T00:01:00Z'))).toEqual({
    step: 'desktop signing', reason: 'Signing failed', ageText: '1m ago',
  });
});
