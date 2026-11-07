import { describe, expect, it } from 'vitest';
import { buildPaletteItems, paletteView } from './palette-model.js';
import { palettePhone, phoneItemSubtitle, phoneItemTitle } from './palette-phone.js';

const wire = {
  v: 1, generatedAt: '2026-11-01T04:12:00Z', gateway: 'running',
  phoneUrl: 'https://phantom.example/verse/m', publicOrigin: 'https://phantom.example',
  pending: 1, devices: { active: 2, revoked: 3 },
};
const input = { needsYou: [], running: [], sessions: [], seats: [], projects: [], recentActions: [], platform: 'mac' as const };

describe('palettePhone', () => {
  it('narrows the contract and only retains the fields the palette needs', () => {
    const phone = palettePhone({ ...wire, token: 'hidden', devices: { ...wire.devices, audience: 'hidden' } });
    expect(phone).toEqual({ phoneUrl: wire.phoneUrl, gateway: 'running', active: 2, pending: 1 });
    expect(phoneItemTitle(phone!)).toBe('Copy phone URL');
    expect(phoneItemSubtitle(phone!)).toBe('gateway running · 2 phones paired · 1 waiting for you');
    expect(phoneItemSubtitle({ ...phone!, active: 1, pending: 0 })).toBe('gateway running · 1 phone paired');
    expect(phoneItemSubtitle({ ...phone!, gateway: 'not-running' })).toBe('gateway not running');
    expect(palettePhone({ ...wire, phoneUrl: null, publicOrigin: null })).not.toBeNull();
  });

  it('rejects invalid responses, counts and unsafe or non-phone URLs', () => {
    for (const value of [null, [], {}, { ...wire, v: 2 }, { ...wire, generatedAt: 'bad' },
      { ...wire, gateway: 'starting' }, { ...wire, pending: -1 }, { ...wire, pending: 0.5 },
      { ...wire, devices: { active: 2, revoked: -1 } }, { ...wire, publicOrigin: 'http://phantom.example' },
      ...['http://phantom.example/verse/m', 'https://u@phantom.example/verse/m',
        'https://phantom.example/verse/m?v=1', 'https://phantom.example/verse/m#top',
        'https://phantom.example/verse/m/elsewhere', 'not a URL'].map(phoneUrl => ({ ...wire, phoneUrl }))]) {
      expect(palettePhone(value)).toBeNull();
    }
  });

  it('makes a searchable lane-group command, with warning tone for waiting phones', () => {
    const phone = palettePhone(wire)!;
    const item = paletteView(buildPaletteItems({ ...input, phone }), 'phone', [], 'mac').flat[0]!;
    expect(item).toMatchObject({ kind: 'command', group: 'lanes', tone: 'warn', payload: { kind: 'copy-text', text: wire.phoneUrl } });
    expect(buildPaletteItems({ ...input, phone: { ...phone, pending: 0 } }).find(i => i.key === item.key)?.tone).toBe('neutral');
    expect(buildPaletteItems({ ...input, phone: { ...phone, phoneUrl: null } }).some(i => i.key === item.key)).toBe(false);
  });
});
