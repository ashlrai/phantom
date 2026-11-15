import { expect, it } from 'vitest';
import type { ReleaseChainStatus } from '../src/core/fleet/release-chain-status.js';
import { releaseChainLine } from '../src/web-ui/routes/verse/sections/release-chain-line.js';

it('renders a failed release with the complete evidence-bearing status', () => {
  const status: ReleaseChainStatus = {
    verdict: 'failed', reason: 'Signing failed', latestAutorun: { sha: 'abc', rc: 1, mtime: '2026-01-01T00:00:00Z' },
    version: null, installedVersion: null, sources: [],
    evidence: { versionJoin: 'none', feedRc: null, feedState: null, boundLog: null, diagnostics: [] },
  };
  expect(releaseChainLine(status, Date.parse('2026-01-01T00:02:00Z'))).toEqual({
    step: 'desktop signing', reason: 'Signing failed', ageText: '2m ago',
  });
});
