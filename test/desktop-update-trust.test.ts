/** Focused tests for src/core/desktop/update-trust.ts */
import { describe, expect, it } from 'vitest';
import {
  UPDATER_PUBLIC_KEY,
  getDesktopUpdateTrust,
  getDesktopUpdateTrustForProfile,
} from '../src/core/desktop/update-trust.js';

describe('UPDATER_PUBLIC_KEY', () => {
  it('is a non-empty base64 minisign key string', () => {
    expect(typeof UPDATER_PUBLIC_KEY).toBe('string');
    expect(UPDATER_PUBLIC_KEY.length).toBeGreaterThan(0);
    expect(UPDATER_PUBLIC_KEY.startsWith('dW50cnVzdGVk')).toBe(true);
  });
});

describe('getDesktopUpdateTrust()', () => {
  it('returns the frozen trust object with the commissioned key', () => {
    const trust = getDesktopUpdateTrust();
    expect(trust.publicKey).toBe(UPDATER_PUBLIC_KEY);
    expect(trust.repository.fullName).toBe('ashlrai/ashlr-hub');
    expect(trust.repository.repositoryId).toBe(1263526319);
    expect(trust.channel).toBe('stable');
    expect(trust.platform).toBe('darwin-aarch64');
    expect(Object.isFrozen(trust)).toBe(true);
    expect(Object.isFrozen(trust.repository)).toBe(true);
  });
});

describe('getDesktopUpdateTrustForProfile()', () => {
  it('returns ashlr-hub trust for legacy-v1', () => {
    const trust = getDesktopUpdateTrustForProfile('legacy-v1');
    expect(trust.repository.fullName).toBe('ashlrai/ashlr-hub');
  });

  it('returns phantom trust for canonical-v2', () => {
    const trust = getDesktopUpdateTrustForProfile('canonical-v2');
    expect(trust.repository.fullName).toBe('ashlrai/phantom');
  });

  it('throws on an invalid profile name', () => {
    const invalid = 'bad-profile' as unknown as 'legacy-v1' | 'canonical-v2';
    expect(() => getDesktopUpdateTrustForProfile(invalid)).toThrow(
      'identity profile',
    );
  });
});
