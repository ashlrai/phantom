import { describe, expect, it } from 'vitest';
import * as core from '../../../../../core/fleet/drop-job-writer.js';
import * as model from './drop-job-model.js';
import { formatMobileHash, parseMobileHash, tabOf } from '../mobile-router.js';
const valid = { id: 'PHONE1101', lane: 'codex-personal', tier: 'mid', body: '#job repo=phantom lane=codex-personal tier=mid\n\nFix the queue' };
describe('mobile drop job model', () => {
  it('matches the core constants and file byte budget', () => {
    expect(model.DROP_JOB_LANES).toEqual(core.DROP_JOB_LANES);
    expect(model.DROP_JOB_TIERS).toEqual(core.DROP_JOB_TIERS);
    expect(model.DROP_JOB_ID.source).toBe(core.DROP_JOB_ID.source);
    expect(model.DROP_JOB_MAX_FILE_BYTES).toBe(core.DROP_JOB_MAX_FILE_BYTES);
    expect(model.dropJobBytes(valid)).toBe(new TextEncoder().encode(core.composeDropJobFile(valid)).length);
  });
  it('round trips the drop-job route under More', () => {
    const route = { screen: 'drop-job' } as const;
    expect(parseMobileHash(formatMobileHash(route))).toEqual(route);
    expect(tabOf(route)).toBe('more');
  });
  it('accepts a valid payload', () => expect(model.validateDropJob(valid)).toEqual({ ok: true, payload: valid }));
  it.each([
    [{ id: 'bad-id!' }, 'id-shape'], [{ lane: 'unknown' }, 'lane'], [{ tier: 'unknown' }, 'tier'],
    [{ body: '🦊'.repeat(2100) }, 'too-large'], [{ body: 'auth.json' }, 'denied-content'],
    [{ body: '\u0000' }, 'control-characters'], [{ body: ' ' }, 'empty-body'],
  ])('rejects invalid draft %j', (change, reason) => {
    const payload = { ...valid, ...change };
    expect(model.validateDropJob(payload)).toEqual({ ok: false, reason });
    expect(core.validateDropJob(payload).ok).toBe(false);
  });
  it.each(['Fix: queue / now!', '!!!', 'a', 'a'.repeat(80)])('suggests safe bounded ids from %s', goal => {
    const id = model.suggestId(goal, new Date(2026, 10, 1).getTime());
    expect(id).toMatch(/^[A-Z0-9]{6,20}$/);
    expect(id.endsWith('1101')).toBe(true);
  });
});
