import { describe, expect, it } from 'vitest';
import { narrowPoolReach, poolReachSummary } from './pool-reach-model.js';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const FRESH = '2026-11-14T11:59:30Z';
const host = (slot: string, alias: string, online: unknown, extra: Record<string, unknown> = {}) =>
  ({ slot, alias, matched: true, online, lastSeen: FRESH, ageSeconds: 30, isSelf: false, ...extra });
const reach = (o: Record<string, unknown> = {}) => ({
  asOf: FRESH, self: 'mac-primary', role: 'primary',
  hosts: [host('primary', 'mac-primary', true), host('backup', 'mac-backup', true)], reasons: [], ...o });
const sum = (o?: Record<string, unknown>) => poolReachSummary(narrowPoolReach(reach(o))!, NOW);

describe('narrowPoolReach', () => {
  it('rejects non-objects', () => {
    for (const raw of [null, undefined, 'x', 3, true, []]) expect(narrowPoolReach(raw)).toBeNull();
  });
  it('accepts the route envelope and a bare reach', () => {
    const env = narrowPoolReach({ v: 1, generatedAt: FRESH, reach: reach() });
    expect(env?.hosts).toHaveLength(2);
    expect(narrowPoolReach(reach())).toEqual(env);
    expect(env?.hosts[0]).toMatchObject({ slot: 'primary', alias: 'mac-primary', online: true, ageSeconds: 30, isSelf: false });
  });
  it('drops malformed host rows and counts them', () => {
    const v = narrowPoolReach(reach({ hosts: ['junk', null, { slot: 'spare', alias: 'x' }, { slot: 'backup' }] }));
    expect(v?.hosts).toEqual([]);
    expect(v?.dropped).toBe(4);
  });
  it('caps rows at 4', () => {
    const hosts = Array.from({ length: 9 }, () => host('backup', 'mac-backup', true));
    expect(narrowPoolReach(reach({ hosts }))?.hosts).toHaveLength(4);
  });
  it('coerces bad online and ageSeconds to unknown', () => {
    const v = narrowPoolReach(reach({ hosts: [host('primary', 'mac-primary', 'yes', { ageSeconds: -1 }), host('backup', 'mac-backup', 1, { ageSeconds: '5' })] }));
    expect(v?.hosts.map((h) => [h.online, h.ageSeconds])).toEqual([['unknown', 'unknown'], ['unknown', 'unknown']]);
  });
  it('tolerates missing hosts and reasons', () => {
    expect(narrowPoolReach({ asOf: FRESH })).toMatchObject({ hosts: [], reasons: [], dropped: 0 });
  });
});

describe('poolReachSummary', () => {
  it('both online is good', () => expect(sum()).toEqual({ text: 'Primary and backup reachable', tone: 'good' }));
  it('backup offline is warn', () => {
    expect(sum({ hosts: [host('primary', 'mac-primary', true), host('backup', 'mac-backup', false)] }))
      .toEqual({ text: 'Backup mac-backup not reachable: failover would fail', tone: 'warn' });
  });
  it('backup unknown is warn', () => {
    expect(sum({ hosts: [host('primary', 'mac-primary', true), host('backup', 'mac-backup', 'unknown')] }).tone).toBe('warn');
  });
  it('missing backup is warn', () => {
    expect(sum({ hosts: [host('primary', 'mac-primary', true)] }).tone).toBe('warn');
  });
  it('primary offline is bad', () => {
    expect(sum({ hosts: [host('primary', 'mac-primary', false), host('backup', 'mac-backup', true)] }))
      .toEqual({ text: 'Primary mac-primary offline', tone: 'bad' });
  });
  it('primary unknown is warn', () => {
    expect(sum({ hosts: [host('primary', 'mac-primary', 'unknown'), host('backup', 'mac-backup', true)] }).tone).toBe('warn');
  });
  it('no hosts is unknown and shows the first reason', () => {
    expect(sum({ hosts: [], reasons: ['pool not configured', 'second'] })).toEqual({ text: 'pool not configured', tone: 'unknown' });
  });
  it('stale snapshot is never good', () => {
    expect(sum({ asOf: '2026-11-14T11:57:00Z' })).toEqual({ text: 'Primary and backup reachable (stale)', tone: 'warn' });
  });
  it('exactly 120 s is not stale; 121 s is', () => {
    expect(sum({ asOf: '2026-11-14T11:58:00Z' }).tone).toBe('good');
    expect(sum({ asOf: '2026-11-14T11:57:59Z' }).tone).toBe('warn');
  });
  it('stale keeps bad and unknown tones', () => {
    const old = '2026-11-14T10:00:00Z';
    expect(sum({ asOf: old, hosts: [host('primary', 'mac-primary', false)] })).toEqual({ text: 'Primary mac-primary offline (stale)', tone: 'bad' });
    expect(sum({ asOf: old, hosts: [], reasons: ['none'] })).toEqual({ text: 'none (stale)', tone: 'unknown' });
  });
  it('unreadable asOf counts as stale', () => {
    expect(sum({ asOf: 'nope' }).text).toMatch(/\(stale\)$/);
  });
});
