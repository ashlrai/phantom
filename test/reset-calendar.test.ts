import { describe, expect, it } from 'vitest';
import { recurringResetWindow, resetCalendarPoolForSeat, resetLaneOrder, resetPace, RESET_TARGET_USED_PERCENT,
  validResetCalendarPool, type ResetCalendarPool } from '../src/core/routing/reset-pressure.js';
import { nextResetCalendarWake, projectResetCalendar } from '../src/core/routing/reset-spending.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';

const now = Date.parse('2026-10-26T17:15:00.000Z'); // Mon Oct 26 13:15 ET
const at = (delta:number) => new Date(now + delta).toISOString();
// Grok Ultra weekly reset: Sunday Nov 1, 8:21 PM ET (2026-11-02T01:21Z), then every 7 days.
const GROK_RESET = '2026-11-02T01:21:00.000Z';
const oct26 = (): ResetCalendarPool[] => [
  { pool: 'grok-ultra-weekly', resetAt: GROK_RESET, remainingPercent: 63 },
  { pool: 'codex-cmp', resetAt: '2026-10-30T12:00:00.000Z', remainingPercent: null, creditBalance: 6000 },
  { pool: 'codex-personal', resetAt: '2026-10-31T00:00:00.000Z', remainingPercent: 96 },
];

describe('reset calendar pace',()=>{
  it.each([
    ['grok-ultra-weekly',152.1,61/152.1],
    ['codex-personal',102.75,94/102.75],
    ['codex-cmp',90.75,null],
  ] as const)('computes the Oct 26 target burn rate for %s',(pool,hours,pace)=>{
    const status=resetPace(oct26().find((row)=>row.pool===pool)!,now);
    expect(status.hoursToReset).toBeCloseTo(hours,6);
    if(pace===null)expect(status.pacePerHour).toBeNull();
    else expect(status.pacePerHour).toBeCloseTo(pace,6);
  });
  it.each([
    ['already at target',{resetAt:at(3600000),remainingPercent:2},0],
    ['past the target',{resetAt:at(3600000),remainingPercent:1},0],
    ['full window',{resetAt:at(352800000),remainingPercent:100},1],
    ['unknown remainder',{resetAt:at(3600000),remainingPercent:null},null],
    ['unknown reset',{resetAt:null,remainingPercent:63},null],
    ['stale reset',{resetAt:at(-1),remainingPercent:63},null],
  ] as const)('pace stays honest for %s',(_case,pool,pace)=>{
    const status=resetPace({pool:'p',...pool},now);
    if(pace===null)expect(status.pacePerHour).toBeNull();
    else expect(status.pacePerHour).toBeCloseTo(pace,6);
  });
  it('honors a non-default landing target',()=>{
    expect(resetPace({pool:'p',resetAt:at(10*3600000),remainingPercent:63},now,90).pacePerHour).toBeCloseTo(5.3,6);
    expect(RESET_TARGET_USED_PERCENT).toBe(98);
  });
});

describe('reset lane order',()=>{
  it('produces the expected Oct 26 lane order: weekly quota by required burn, credits last',()=>{
    expect(projectResetCalendar(oct26(),now).lanes).toEqual([
      {pool:'codex-personal',kind:'weekly',pacePerHour:expect.closeTo(94/102.75,6),resetAt:'2026-10-31T00:00:00.000Z',remainingPercent:96,creditBalance:null},
      {pool:'grok-ultra-weekly',kind:'weekly',pacePerHour:expect.closeTo(61/152.1,6),resetAt:GROK_RESET,remainingPercent:63,creditBalance:null},
      {pool:'codex-cmp',kind:'credits',pacePerHour:null,resetAt:null,remainingPercent:null,creditBalance:6000},
    ]);
  });
  it('spends a weekly lane before the same pool credits even when the window is nearly spent',()=>{
    const cmp:ResetCalendarPool={pool:'codex-cmp',resetAt:at(86400000),remainingPercent:10,creditBalance:6000};
    const lanes=projectResetCalendar([cmp],now).lanes;
    expect(lanes.map((lane)=>lane.kind)).toEqual(['weekly','credits']);
    expect(lanes[0]!.pacePerHour).toBeCloseTo(8/24,6);
  });
  it('drops stale and empty weekly evidence but keeps spendable credits',()=>{
    const stale:ResetCalendarPool={pool:'stale',resetAt:at(-1),remainingPercent:50,creditBalance:10};
    const empty:ResetCalendarPool={pool:'empty',resetAt:at(3600000),remainingPercent:0,creditBalance:5};
    const lanes=resetLaneOrder([stale,empty],now);
    expect(lanes).toEqual([
      {pool:'stale',kind:'credits',pacePerHour:null,resetAt:null,remainingPercent:null,creditBalance:10},
      {pool:'empty',kind:'credits',pacePerHour:null,resetAt:null,remainingPercent:null,creditBalance:5},
    ]);
  });
  it.each([
    ['paced before at-target',[{pool:'a',resetAt:at(3600000),remainingPercent:50},{pool:'b',resetAt:at(7200000),remainingPercent:1}],['a','b']],
    ['at-target before unknown-reset',[{pool:'b',resetAt:null,remainingPercent:50},{pool:'a',resetAt:at(3600000),remainingPercent:1}],['a','b']],
    ['earlier reset breaks a pace tie',[{pool:'late',resetAt:at(7200000),remainingPercent:26},{pool:'early',resetAt:at(3600000),remainingPercent:14}],['early','late']],
    ['pool id settles a full tie',[{pool:'zeta',resetAt:at(3600000),remainingPercent:50},{pool:'alpha',resetAt:at(3600000),remainingPercent:50}],['alpha','zeta']],
    ['balance orders credit lanes',[{pool:'thin',remainingPercent:null,creditBalance:5},{pool:'rich',remainingPercent:null,creditBalance:500}],['rich','thin']],
  ] as const)('orders %s',(_case,pools,order)=>{
    expect(resetLaneOrder(pools.map((pool)=>({resetAt:null,creditBalance:null,...pool})),now).map((lane)=>lane.pool)).toEqual([...order]);
  });
});

describe('reset calendar pools',()=>{
  it.each([
    ['not an object',42],
    ['array',[]],
    ['empty pool',{pool:' ',resetAt:null,remainingPercent:null}],
    ['bad reset',{pool:'p',resetAt:'not a date',remainingPercent:50}],
    ['negative remainder',{pool:'p',resetAt:null,remainingPercent:-1}],
    ['remainder above 100',{pool:'p',resetAt:null,remainingPercent:101}],
    ['negative balance',{pool:'p',resetAt:null,remainingPercent:10,creditBalance:-3}],
    ['non-numeric balance',{pool:'p',resetAt:null,remainingPercent:10,creditBalance:'6000'}],
  ] as const)('rejects %s',(_case,value)=>{
    expect(validResetCalendarPool(value)).toBe(false);
    expect(resetLaneOrder([value as ResetCalendarPool],now)).toEqual([]);
    expect(projectResetCalendar([value as ResetCalendarPool],now).pools).toEqual({});
  });
  it('accepts the Oct 26 readings verbatim',()=>{
    for(const pool of oct26())expect(validResetCalendarPool(pool)).toBe(true);
    expect(validResetCalendarPool({pool:'p',resetAt:null,remainingPercent:0})).toBe(true);
    expect(validResetCalendarPool({pool:'p',resetAt:null,remainingPercent:100,creditBalance:0})).toBe(true);
  });
});

describe('recurring reset window',()=>{
  const anchor=GROK_RESET;
  it.each([
    [now,'2026-10-26T00:21:00.000Z',GROK_RESET],
    [Date.parse('2026-10-20T12:00:00.000Z'),'2026-10-19T00:21:00.000Z','2026-10-26T00:21:00.000Z'],
    [Date.parse('2026-11-05T12:00:00.000Z'),GROK_RESET,'2026-11-09T01:21:00.000Z'],
    [Date.parse('2026-11-02T01:21:00.000Z'),GROK_RESET,'2026-11-09T01:21:00.000Z'],
  ] as const)('brackets %s inside a wall-clock weekly window',(atMs,start,reset)=>{
    expect(recurringResetWindow(anchor,7,'America/New_York',atMs)).toEqual({startsAt:start,resetAt:reset});
  });
  it('keeps the Sunday 8:21 PM wall clock across the DST change',()=>{
    const window=recurringResetWindow(anchor,7,'America/New_York',now)!;
    expect(Date.parse(window.resetAt)-Date.parse(window.startsAt)).toBe(169*3600000);
    expect(recurringResetWindow(anchor,7,null,now)).toEqual({startsAt:'2026-10-26T01:21:00.000Z',resetAt:GROK_RESET});
  });
  it.each([
    ['bad anchor','never',7,'America/New_York'],
    ['zero period',anchor,0,'America/New_York'],
    ['negative period',anchor,-1,'America/New_York'],
    ['period over a year',anchor,400,'America/New_York'],
    ['bad zone',anchor,7,'Not/AZone'],
  ] as const)('refuses %s',(_case,value,days,zone)=>{
    expect(recurringResetWindow(value,days,zone,now)).toBeNull();
  });
});

describe('seat bridge and projection',()=>{
  const seat=(over:Partial<SeatCapacity>={}):SeatCapacity=>({seatId:'grok',engine:'grok',label:'Grok',free:false,signedOut:false,
    reachable:true,contextWindow:256000,observedAt:at(0),spentTodayUsd:null,
    windows:[{id:'grok_weekly',usedPercent:37,resetsAt:GROK_RESET,resetDescription:null,limitReached:false}],...over});
  it('derives remaining percent and reset from the account weekly window',()=>{
    expect(resetCalendarPoolForSeat(seat(),now)).toEqual({pool:'grok',resetAt:GROK_RESET,remainingPercent:63});
    const codex=seat({seatId:'codex-cmp',engine:'codex',windows:[
      {id:'codex_cmp_primary',usedPercent:90,resetsAt:at(3600000),resetDescription:null,limitReached:false},
      {id:'codex_cmp_secondary',usedPercent:60,resetsAt:at(4*86400000),resetDescription:null,limitReached:false}]});
    expect(resetCalendarPoolForSeat(codex,now)).toEqual({pool:'codex-cmp',resetAt:at(4*86400000),remainingPercent:40});
    const modelOnly=seat({seatId:'claude',engine:'claude',windows:[{id:'seven_day_fable',usedPercent:99,resetsAt:at(86400000),resetDescription:null,limitReached:false}]});
    expect(resetCalendarPoolForSeat(modelOnly,now)).toEqual({pool:'claude',resetAt:null,remainingPercent:null});
  });
  it('projects status, lanes and the next wake without moving a reading',()=>{
    const status=projectResetCalendar(oct26(),now);
    expect(status.checkedAt).toBe(at(0));
    expect(status.targetUsedPercent).toBe(98);
    expect(Object.keys(status.pools).sort()).toEqual(['codex-cmp','codex-personal','grok-ultra-weekly']);
    expect(status.pools['codex-cmp']).toMatchObject({remainingPercent:null,hoursToReset:90.75,pacePerHour:null});
    expect(nextResetCalendarWake(status,now)).toBe(Date.parse('2026-10-31T00:00:00.000Z'));
    const drained=projectResetCalendar([{pool:'p',resetAt:null,remainingPercent:null,creditBalance:9}],now);
    expect(drained.lanes).toEqual([{pool:'p',kind:'credits',pacePerHour:null,resetAt:null,remainingPercent:null,creditBalance:9}]);
    expect(nextResetCalendarWake(drained,now)).toBeNull();
  });
});
