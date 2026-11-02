import { describe, expect, it } from 'vitest';
import { inviteCommand, phoneAccessTell, phoneUrlFitsQr, readPhoneAccess } from './phone-access-model.js';

const snapshot = { v: 1, generatedAt: '2026-11-01T04:12:00Z', gateway: 'running',
  phoneUrl: 'https://phone.example.invalid/verse/m', publicOrigin: 'https://phone.example.invalid',
  pending: 1, devices: { active: 1, revoked: 2 } };

describe('phone access', () => {
  it('accepts a valid snapshot and describes its counts', () => {
    const access = readPhoneAccess(snapshot);
    expect(access).not.toBeNull();
    expect(phoneAccessTell(access!)).toBe('Gateway running · 1 phone paired · 1 pairing waits for you');
    expect(inviteCommand()).toBe('ashlr verse remote invite <Access-subject> act');
  });
  it('describes missing configuration and a stopped gateway', () => {
    expect(phoneAccessTell(readPhoneAccess({ ...snapshot, publicOrigin: null, phoneUrl: null })!)).toBe('No phone gateway configured yet');
    expect(phoneAccessTell(readPhoneAccess({ ...snapshot, gateway: 'not-running' })!)).toBe('Gateway not running · start the Mac with --remote-config');
    expect(phoneAccessTell(readPhoneAccess({ ...snapshot, pending: 0, devices: { active: 2, revoked: 0 } })!))
      .toBe('Gateway running · 2 phones paired · 0 pairings wait for you');
  });
  it('rejects missing or malformed contract fields', () => {
    expect(readPhoneAccess(null)).toBeNull();
    expect(readPhoneAccess({ ...snapshot, pending: undefined })).toBeNull();
    expect(readPhoneAccess({ ...snapshot, devices: { active: -1, revoked: 0 } })).toBeNull();
    expect(readPhoneAccess({ ...snapshot, gateway: 'unknown' })).toBeNull();
  });
  it.each([
    'http://phone.example.invalid/verse/m', 'https://phone.example.invalid/verse/other',
    'https://other.example.invalid/verse/m', 'https://u@phone.example.invalid/verse/m',
    'https://phone.example.invalid/verse/m?v=1', 'https://phone.example.invalid/verse/m#top',
  ])('rejects unsafe phone URL %s', phoneUrl => {
    expect(readPhoneAccess({ ...snapshot, phoneUrl })).toBeNull();
  });
  it('rejects a URL without a valid public origin', () => {
    expect(readPhoneAccess({ ...snapshot, publicOrigin: null })).toBeNull();
    expect(readPhoneAccess({ ...snapshot, publicOrigin: 'https://phone.example.invalid/path' })).toBeNull();
  });
  it('limits QR encoding to the 213-byte UTF-8 capacity', () => {
    const host = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.invalid`;
    const long = `https://${host}/verse/m`;
    expect(new TextEncoder().encode(long).length).toBe(215);
    expect(phoneUrlFitsQr(snapshot.phoneUrl)).toBe(true);
    expect(phoneUrlFitsQr(`https://${'d'.repeat(189)}.invalid/verse/m`)).toBe(true);
    expect(phoneUrlFitsQr(long)).toBe(false);
    expect(readPhoneAccess({ ...snapshot, phoneUrl: long, publicOrigin: `https://${host}` })).not.toBeNull();
  });
});
