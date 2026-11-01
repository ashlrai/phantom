import { describe, expect, it } from 'vitest';
import { buildPaletteItems } from './palette-model.js';
import { palettePhone } from './palette-phone.js';

const wire = {
  v: 1, generatedAt: '2026-11-01T04:12:00Z', gateway: 'running',
  phoneUrl: 'https://phantom.example/verse/m', publicOrigin: 'https://phantom.example',
  pending: 0, devices: { active: 1, revoked: 0 },
};
const input = { needsYou: [], running: [], sessions: [], seats: [], projects: [], recentActions: [], platform: 'mac' as const };
const phoneCommands = (data: unknown) => buildPaletteItems({ ...input, phone: palettePhone(data) })
  .filter(item => item.key.startsWith('phone:'));

describe('phone command URL gate', () => {
  it.each([
    ['null', null],
    ['http', 'http://phantom.example/verse/m'],
    ['another origin', 'https://other.example/verse/m'],
    ['query', 'https://phantom.example/verse/m?v=1'],
    ['fragment', 'https://phantom.example/verse/m#top'],
  ])('does not offer commands for %s', (_label, phoneUrl) => {
    expect(phoneCommands({ ...wire, phoneUrl })).toEqual([]);
  });

  it('offers both commands for a same-origin HTTPS phone URL', () => {
    expect(phoneCommands(wire).map(item => item.title)).toEqual(['Copy phone URL', 'Open phone URL']);
  });

  it('requires a public origin when a URL is present', () => {
    expect(phoneCommands({ ...wire, publicOrigin: null })).toEqual([]);
  });
});
