/** The live-build line on the Leader card and the phone Home: current, behind with a date, unknown. */
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupplyDoctorReport } from '../../../../core/fleet/supply-doctor.js';
import { evictAll } from '../../../data/cache.js';
import { json, renderMobile, stubFetch } from '../mobile/mobile.test-support.js';
import { LiveBuildLine } from './LiveBuildLine.js';
import { SUPPLY_PATH } from './SupplyCard.js';

const withBuild = (build: unknown) => ({
  schema: 'doctor.supply.v1', verdict: 'v', ingested: { state: 'known', path: 'p', sources: [] }, rejected: { state: 'known', path: 'p', total24h: 0, byReason: {} },
  selfSupply: { landed24h: 0, lastLanded: null }, hook: {}, ...(build ? { build } : {}) }) as unknown as SupplyDoctorReport;
const known = (count: number, since: string | null) => ({ commit: { state: 'known', sha: 'abc1234', source: 'git' }, behind: { state: 'known', count, ref: 'origin/master', since } });

afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

describe('LiveBuildLine', () => {
  it.each([
    ['current', known(0, null), 'Live build: current', 'ok'],
    ['behind', known(644, '2026-11-12T08:00:00.000Z'), 'Live build: 644 behind (since Nov 12)', 'red'],
    ['unknown', { commit: { state: 'unknown', why: 'x' }, behind: { state: 'unknown', why: 'x' } }, 'Live build: unknown', 'unknown'],
    ['an older Mac with no build field', null, 'Live build: unknown', 'unknown'],
  ])('%s', async (_name, build, text, tone) => {
    stubFetch({ [`GET ${SUPPLY_PATH}`]: withBuild(build) });
    renderMobile(<LiveBuildLine />);
    const line = await screen.findByText(text);
    expect(line).toHaveAttribute('data-tone', tone);
  });
  it('reads unknown when the Mac does not answer', async () => {
    stubFetch({ [`GET ${SUPPLY_PATH}`]: json({ error: 'no' }, 503) });
    renderMobile(<LiveBuildLine />);
    expect(await screen.findByText('Live build: unknown')).toBeInTheDocument();
  });
});
