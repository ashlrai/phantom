import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SHA256_RE,
  canonicalTimestamp,
  canonicalTimestampMillis,
  deriveDomainSigningKey,
  equalDigest,
  hmacDomainPayload,
  safePrivateDirectory,
  safePrivatePath,
  validProposalId,
} from '../src/core/inbox/operational-projection-helpers.js';
import {
  REMOTE_HANDOFF_RECOVERY_MARKER,
  hasStrongRemoteHandoffIdentity,
  hasValidRemoteHandoffRecovery,
  prUrlMatchesRepository,
  remoteAuthorityBinding,
  remoteIntentAuthorizationId,
  sameRemoteAuthorityBinding,
} from '../src/core/inbox/remote-handoff-time.js';
import {
  REMOTE_HANDOFF_RECOVERY_MARKER as REEXPORTED_MARKER,
  remoteAuthorityBinding as reexportedAuthorityBinding,
  remoteIntentAuthorizationId as reexportedIntentAuthorizationId,
} from '../src/core/inbox/remote-handoff.js';
import type { ProposalLocalMergeIntent, ProposalRemoteHandoff } from '../src/core/types.js';
import type { PrView } from '../src/core/integrations/github.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('inbox operational-projection shared helpers', () => {
  it('validates canonical timestamps, proposal ids, sha256 digests, and domain HMACs', () => {
    const iso = '2026-11-26T09:00:00.000Z';
    expect(canonicalTimestamp(iso)).toBe(true);
    expect(canonicalTimestampMillis(iso)).toBe(Date.parse(iso));
    expect(canonicalTimestamp('2026-11-26T09:00:00Z')).toBe(false);
    expect(canonicalTimestamp('2026-11-26T09:00:00.000+00:00')).toBe(false);
    expect(canonicalTimestampMillis(null)).toBeNull();

    expect(validProposalId('prop-123_abc.v1')).toBe(true);
    expect(validProposalId('a'.repeat(240))).toBe(true);
    expect(validProposalId('a'.repeat(241))).toBe(false);
    expect(validProposalId('.')).toBe(false);
    expect(validProposalId('..')).toBe(false);
    expect(validProposalId('../escape')).toBe(false);

    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    expect(SHA256_RE.test(a)).toBe(true);
    expect(equalDigest(a, a)).toBe(true);
    expect(equalDigest(a, b)).toBe(false);
    expect(equalDigest(a.toUpperCase(), a)).toBe(false);
    expect(equalDigest('short', 'short')).toBe(false);

    const rootKey = Buffer.alloc(32, 7);
    const key1 = deriveDomainSigningKey(rootKey, 'domain.one');
    const key2 = deriveDomainSigningKey(rootKey, 'domain.two');
    expect(key1.length).toBe(32);
    expect(key1.equals(key2)).toBe(false);
    const mac1 = hmacDomainPayload(key1, 'record.v1', '{"a":1}');
    const mac2 = hmacDomainPayload(key1, 'record.v2', '{"a":1}');
    expect(SHA256_RE.test(mac1)).toBe(true);
    expect(mac1).not.toBe(mac2);
  });

  it('enforces private ownership, exact permissions, and rejects symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-inbox-helpers-'));
    tempDirs.push(root);
    const prevHome = process.env['HOME'];
    process.env['HOME'] = root;
    try {
      const dir = join(root, 'private-dir');
      mkdirSync(dir, { mode: 0o700 });
      chmodSync(dir, 0o700);
      expect(safePrivateDirectory(dir)).toBe(true);

      const file = join(dir, 'state.json');
      writeFileSync(file, '{}', { mode: 0o600 });
      chmodSync(file, 0o600);
      expect(safePrivatePath(file, 'file', 0o600)).toBe(true);
      expect(safePrivatePath(file, 'directory', 0o700)).toBe(false);

      const link = join(root, 'link-dir');
      symlinkSync(dir, link);
      expect(safePrivateDirectory(link)).toBe(false);

      if (process.platform !== 'win32') {
        chmodSync(file, 0o644);
        expect(safePrivatePath(file, 'file', 0o600)).toBe(false);
      }
    } finally {
      if (prevHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prevHome;
    }
  });
});

describe('inbox remote-handoff shared authority and identity helpers', () => {
  it('re-exports canonical authority helpers from remote-handoff.ts and normalizes push URLs', () => {
    expect(REEXPORTED_MARKER).toBe(REMOTE_HANDOFF_RECOVERY_MARKER);
    expect(reexportedAuthorityBinding).toBe(remoteAuthorityBinding);
    expect(reexportedIntentAuthorizationId).toBe(remoteIntentAuthorizationId);

    const clean = remoteAuthorityBinding({
      nameWithOwner: 'ashlrai/fixture',
      fetchUrls: ['https://github.com/ashlrai/fixture.git'],
      pushUrls: ['https://github.com/ashlrai/fixture.git'],
    });
    const normalized = remoteAuthorityBinding({
      nameWithOwner: 'ashlrai/fixture',
      fetchUrls: ['https://github.com/ashlrai/fixture.git'],
      pushUrls: [
        'https://alice@GitHub.COM/ashlrai/fixture.git/?x=1#frag',
        'https://github.com/ashlrai/fixture.git///',
      ],
    });
    expect(clean).not.toBeNull();
    expect(normalized).toEqual(clean);
    expect(sameRemoteAuthorityBinding(clean ?? undefined, normalized ?? undefined)).toBe(true);
    expect(sameRemoteAuthorityBinding(clean ?? undefined, undefined)).toBe(false);
    expect(sameRemoteAuthorityBinding(
      { provider: 'github', nameWithOwner: 'ashlrai/fixture', pushAuthorityDigest: 'A'.repeat(64) },
      { provider: 'github', nameWithOwner: 'ashlrai/fixture', pushAuthorityDigest: 'A'.repeat(64) },
    )).toBe(false);
    expect(remoteAuthorityBinding({ nameWithOwner: '', fetchUrls: [], pushUrls: ['https://github.com/a/b.git'] })).toBeNull();
    expect(remoteAuthorityBinding({ nameWithOwner: 'a/b', fetchUrls: [], pushUrls: [] })).toBeNull();
  });

  it('derives phase- and protocol-bound authorization ids and validates handoff identity', () => {
    const authority = remoteAuthorityBinding({
      nameWithOwner: 'ashlrai/fixture',
      fetchUrls: ['https://github.com/ashlrai/fixture.git'],
      pushUrls: ['https://github.com/ashlrai/fixture.git'],
    })!;
    const baseIntent: Omit<ProposalLocalMergeIntent, 'attestation' | 'authorizationId'> = {
      schemaVersion: 1,
      branch: 'ashlr/merge/prop-1',
      base: 'master',
      baseBeforeOid: 'a'.repeat(40),
      proposalHeadOid: 'b'.repeat(40),
      diffHash: 'c'.repeat(64),
      evidencePackDigest: 'd'.repeat(64),
      authorizedAt: '2026-11-26T00:00:00.000Z',
      remoteAuthority: authority,
    };
    const ids = [
      remoteIntentAuthorizationId('pre-effect', baseIntent),
      remoteIntentAuthorizationId('recovery', baseIntent),
      remoteIntentAuthorizationId('pre-effect', { ...baseIntent, evidenceProtocol: 'sealed-v3' }),
    ];
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(ids).size).toBe(3);
    expect(remoteIntentAuthorizationId('pre-effect', { ...baseIntent, remoteAuthority: undefined })).toBe('');

    const handoff: ProposalRemoteHandoff = {
      provider: 'github',
      state: 'awaiting-host-merge',
      prUrl: 'https://github.com/AshlrAI/Fixture/pull/42',
      branch: 'ashlr/merge/prop-1',
      base: 'master',
      expectedHeadOid: 'a'.repeat(40),
      createdAt: '2026-11-26T00:00:00.000Z',
      updatedAt: '2026-11-26T00:00:00.000Z',
      recovery: {
        schemaVersion: 1,
        attempt: 1,
        marker: REMOTE_HANDOFF_RECOVERY_MARKER,
        authorizedAt: '2026-11-26T00:01:00.000Z',
      },
    };
    expect(hasValidRemoteHandoffRecovery(handoff)).toBe(true);
    expect(hasValidRemoteHandoffRecovery({ ...handoff, recovery: { ...handoff.recovery!, marker: '[wrong]' } })).toBe(false);

    expect(prUrlMatchesRepository(handoff.prUrl, 'ashlrai/fixture')).toBe(true);
    expect(prUrlMatchesRepository('https://github.com/other/fixture/pull/42', 'ashlrai/fixture')).toBe(false);
    expect(prUrlMatchesRepository('https://github.com/ashlrai/fixture/pull/0', 'ashlrai/fixture')).toBe(false);
    expect(prUrlMatchesRepository('https://github.com/ashlrai?x/fixture/pull/42', 'ashlrai?x/fixture')).toBe(false);
    expect(prUrlMatchesRepository(undefined, 'ashlrai/fixture')).toBe(false);

    const pr: PrView = {
      number: 42,
      url: handoff.prUrl!,
      state: 'OPEN',
      headRefName: 'ashlr/merge/prop-1',
      baseRefName: 'master',
      headRefOid: 'A'.repeat(40),
    };
    expect(hasStrongRemoteHandoffIdentity(handoff, pr)).toBe(true);
    expect(hasStrongRemoteHandoffIdentity(handoff, { ...pr, headRefOid: 'b'.repeat(40) })).toBe(false);
  });
});
