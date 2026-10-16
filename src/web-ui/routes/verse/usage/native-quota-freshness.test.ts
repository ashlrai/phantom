import { describe, expect, it } from 'vitest';
import { nativeSeat, capacity, seatWindow, LOCAL_SEAT_V2 } from '../seat-fixtures.test-support.js';
import { projectAccountsSnapshot } from './usage-contract.js';
import { buildAccountCards } from './accounts-model.js';
import { buildCapacityOverview } from './capacity-model.js';
import { seatSubscription } from '../seat-subscription.js';
import { seatCapacity } from '../verse-model.js';
import { accountStatus, buildCapacityRows, hasCurrentUsage, scarcestSeat } from './capacity-strip-model.js';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const OBSERVED = new Date(NOW).toISOString();
const EXPIRES = new Date(NOW + 60_000).toISOString();
function native(over: Record<string, unknown> = {}) {
  const window = seatWindow({ id: 'weekly', usedPercent: 43, resetsAt: new Date(NOW + 86_400_000).toISOString() });
  return nativeSeat(capacity({ observedAt: OBSERVED, ...{ quotaExpiresAt: EXPIRES }, windows: [window], binding: window,
    usability: 'ready', creditsExpiresAt: null, ...over }), {
    engine: 'codex', id: 'inert-native', health: { state: 'ready', summary: null, windows: [{id:'weekly',usedPercent:43,resetsAt:window.resetsAt}], observedAt:OBSERVED },
  });
}

describe('original native quota expiry', () => {
  it.each([59_999, 60_000, 60_001])('rebuilds retained cache at original boundary %sms', age => {
    const seat = native();
    const [row] = buildCapacityRows([seat], { now: NOW + age });
    expect(hasCurrentUsage(row!)).toBe(age < 60_000);
    expect(row!.windows[0]!.usedPercent).toBe(43);
    if (age >= 60_000) {
      expect(accountStatus(row!, {healthRead:true,now:NOW+age}).label).not.toBe('Usable now');
      expect(scarcestSeat([row!])).toBeNull();
      expect(seatSubscription(seat,NOW+age).summary).toContain('unconfirmed');
    }
  });
  it.each([undefined,null,'invalid','2026-02-30T12:01:00.000Z'])('does not invent missing or malformed expiry %s', quotaExpiresAt => {
    expect(hasCurrentUsage(buildCapacityRows([native({quotaExpiresAt})], {now:NOW})[0]!)).toBe(false);
  });
  it.each([null,'invalid',new Date(NOW+1).toISOString()])('refuses missing, invalid or future source observation %s', observedAt => {
    expect(hasCurrentUsage(buildCapacityRows([native({observedAt})], {now:NOW})[0]!)).toBe(false);
  });
  it('does not use legacy native health percentages as an expiry witness', () => {
    const seat = native(); delete seat.capacity;
    expect(hasCurrentUsage(buildCapacityRows([seat],{now:NOW})[0]!)).toBe(false);
    expect(seatCapacity(seat).cls).toBe('unread');
  });
  it('preserves an actual zero reading and never substitutes zero for an expired unknown reading',()=>{
    const seat=native();seat.capacity!.windows[0]!.usedPercent=0;
    const [row]=buildCapacityRows([seat],{now:NOW+60_000});
    expect(row!.windows[0]!.usedPercent).toBe(0);expect(hasCurrentUsage(row!)).toBe(false);
    seat.capacity!.windows[0]!.usedPercent=null;
    expect(buildCapacityRows([seat],{now:NOW+60_000})[0]!.windows[0]!.usedPercent).toBeNull();
  });
  it('withholds current forecasts as soon as an original reset passes',()=>{
    const seat=native();seat.capacity!.windows[0]!.resetsAt=new Date(NOW+1000).toISOString();
    expect(hasCurrentUsage(buildCapacityRows([seat],{now:NOW+999})[0]!)).toBe(true);
    expect(hasCurrentUsage(buildCapacityRows([seat],{now:NOW+1000})[0]!)).toBe(false);
  });
  it('keeps separately current native credits after quota expiry', () => {
    const seat = native({credits:{hasCredits:true,unlimited:false,balance:'7',spendControlReached:false},creditsExpiresAt:new Date(NOW+120_000).toISOString()});
    const [row] = buildCapacityRows([seat], {now:NOW+60_000});
    expect(hasCurrentUsage(row!)).toBe(false);
    expect(row!.credits).not.toBeNull();
    expect(accountStatus(row!,{healthRead:true,now:NOW+60_000}).label).toBe('Credits available');
  });
  it('leaves non-native readiness independent of quota expiry', () => {
    expect(seatSubscription(LOCAL_SEAT_V2,NOW).kind).toBe('local');
    const seat = {...native(), engine:'devin' as const}; delete seat.capacity;
    expect(seatCapacity(seat).cls).toBe('ready');
  });
});

describe('original GET-account expiry',()=>{
  it.each([59_999,60_000,60_001])('preserves original expiry and withholds live forecasts at %sms', age=>{
    const window={id:'weekly',usedPercent:43,resetsAt:new Date(NOW+86_400_000).toISOString(),limitReached:false,measured:true};
    const snapshot=projectAccountsSnapshot({sampledAt:OBSERVED,accounts:[{id:'inert',label:'Inert',provider:'codex',state:'observed',authentication:'signed-in',observedAt:OBSERVED,expiresAt:EXPIRES,windows:[window],binding:window,credits:null,notes:[]}],notes:[]})!;
    expect(snapshot.accounts[0]!.expiresAt).toBe(EXPIRES);
    const cards=buildAccountCards(snapshot,NOW+age);
    const overview=buildCapacityOverview({cards,localCard:null,localView:null,nowMs:NOW+age});
    expect(overview.ready).toBe(age<60_000?1:0);
    expect(overview.resets).toHaveLength(age<60_000?1:0);
    expect(cards[0]!.allWindows[0]!.usedPct).toBe(43);
  });
});
