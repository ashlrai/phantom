import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { releaseChainResponse } from '../src/core/web/release-chain-api.js';

describe('release chain web read', () => {
  it('reads signing evidence from the fleet root', () => {
    const root = mkdtempSync(join(tmpdir(), 'chain-'));
    try {
      mkdirSync(join(root, 'release-sign', 'autorun'), { recursive: true });
      writeFileSync(join(root, 'release-sign', 'autorun', 'sha-abcdef012345.rc'), '12');
      writeFileSync(join(root, 'release-sign', 'v1.2.3-123.log'), 'START v1.2.3 abcdef012345\nReason: attest failed\n');
      expect(releaseChainResponse(root)).toMatchObject({ verdict: 'held', reason: 'Reason: attest failed', version: '1.2.3' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
