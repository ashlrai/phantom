import { expect, it } from 'vitest';
import { releaseLine } from './release-line.js';
const baseNow = Date.parse('2026-10-31T12:00:00Z');

it('ships 17 days ago with candidate', () => {
  const r = { version: '3.30.0', latestTag: 'v3.29.15', gh: { latestRelease: { tag: 'v3.29.15', publishedAt: new Date(baseNow - 17 * 86_400_000).toISOString() } } };
  expect(releaseLine(r as any, baseNow)).toBe('v3.29.15 shipped 17 days ago · 3.30.0 candidate');
});
it('ships today with current', () => {
  const r = { version: '3.29.15', latestTag: 'v3.29.15', gh: { latestRelease: { tag: 'v3.29.15', publishedAt: new Date(baseNow).toISOString() } } };
  expect(releaseLine(r as any, baseNow)).toBe('v3.29.15 shipped today · current');
});
it('ships yesterday (singular "day")', () => {
  const r = { version: null, latestTag: 'v1.0.0', gh: { latestRelease: { tag: 'v1.0.0', publishedAt: new Date(baseNow - 86_400_000).toISOString() } } };
  expect(releaseLine(r as any, baseNow)).toBe('v1.0.0 shipped 1 day ago');
});
it('ships when publishedAt is null', () => {
  const r = { version: null, latestTag: 'v2.0.0', gh: { latestRelease: { tag: 'v2.0.0', publishedAt: null } } };
  expect(releaseLine(r as any, baseNow)).toBe('v2.0.0 shipped');
});
it('status unknown when gh is null, with version', () => {
  expect(releaseLine({ version: '4.0.0', latestTag: null, gh: null } as any, baseNow)).toBe('release status unknown · 4.0.0 candidate');
});
it('status unknown with no version', () => {
  expect(releaseLine({ version: null, latestTag: null, gh: null } as any, baseNow)).toBe('release status unknown');
});
it('nothing shipped when gh present but latestRelease null', () => {
  expect(releaseLine({ version: null, latestTag: 'v0.1.0', gh: { latestRelease: null } } as any, baseNow)).toBe('nothing shipped yet');
});
it('current when version equals tag stripped of v', () => {
  const r = { version: '3.29.15', latestTag: 'v3.29.15', gh: null };
  expect(releaseLine(r as any, baseNow)).toBe('release status unknown · current');
});
it('no candidate when version is null', () => {
  const r = { version: null, latestTag: 'v1.0.0', gh: { latestRelease: { tag: 'v1.0.0', publishedAt: null } } };
  expect(releaseLine(r as any, baseNow)).toBe('v1.0.0 shipped');
});
it('invalid publishedAt treated as null', () => {
  const r = { version: null, latestTag: 'v1.0.0', gh: { latestRelease: { tag: 'v1.0.0', publishedAt: 'not-a-date' } } };
  expect(releaseLine(r as any, baseNow)).toBe('v1.0.0 shipped');
});
