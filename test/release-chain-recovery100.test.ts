import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { releaseChainResponse } from '../src/core/web/release-chain-api.js';

it('reports missing evidence as unknown and binds a held reason to its signing run', () => {
  const root = mkdtempSync(join(tmpdir(), 'chain-recovery-'));
  try {
    expect(releaseChainResponse(root)).toMatchObject({ verdict: 'unknown', reason: null, installedVersion: null, latestAutorun: null });
    const sign = join(root, 'release-sign');
    mkdirSync(join(sign, 'autorun'), { recursive: true });
    writeFileSync(join(sign, 'autorun', 'sha-abcdef012345.rc'), '12');
    writeFileSync(join(sign, 'v1.2.3-123.log'), 'START v1.2.3 abcdef012345\nReason: signing is held\n');
    expect(releaseChainResponse(root)).toMatchObject({ verdict: 'held', reason: 'Reason: signing is held', version: '1.2.3', installedVersion: null, evidence: { versionJoin: 'log-field' } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
