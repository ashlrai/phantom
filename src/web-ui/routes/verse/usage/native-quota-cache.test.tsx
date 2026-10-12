import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { evictAll, getQuerySnapshot, runQuery } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { verseBootstrapQuery } from '../verse-queries.js';
import { nativeSeat, capacity, seatWindow } from '../seat-fixtures.test-support.js';
import { useCapacityData } from './CapacityStrip.js';
import { useCapacityClock } from './use-capacity-clock.js';
import { buildCapacityRows, hasCurrentUsage } from './capacity-strip-model.js';

const T = Date.parse('2026-10-12T12:00:00.000Z');
const wrapper = ({children}: {children:ReactNode}) => <SectionVisibilityProvider visible>{children}</SectionVisibilityProvider>;
afterEach(()=>{cleanup();evictAll();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});

async function seed() {
  vi.useFakeTimers();vi.setSystemTime(T);evictAll();
  const window=seatWindow({id:'weekly',usedPercent:43,resetsAt:null});
  const seat=nativeSeat(capacity({windows:[window],binding:window,usability:'ready',observedAt:new Date(T).toISOString(),quotaExpiresAt:new Date(T+60_000).toISOString()}),{id:'inert',engine:'codex'});
  await runQuery(verseBootstrapQuery.key,async()=>({seats:[seat],projects:[],sessions:[],dispatchEnabled:false}));
  vi.setSystemTime(T+10_000);
  const fetch=vi.fn(async()=>{throw new Error('inert failed poll');});vi.stubGlobal('fetch',fetch);
  const hook=renderHook(()=>{
    const data=useCapacityData({withBudget:false,withHealth:false});
    const now=useCapacityClock(undefined,data.seats.map(seat=>seat.capacity));
    const rows=buildCapacityRows(data.seats,{now});
    return {data,current:rows.length>0&&hasCurrentUsage(rows[0]!),rows,now};
  },{wrapper});
  await act(async()=>{});
  return {hook,fetch};
}

describe('retained cache clock never renews original quota',()=>{
  it('expires at T+60 despite T+10 mount and failed polls, without fetching at the expiry wake-up',async()=>{
    const {hook,fetch}=await seed();
    expect(hook.result.current.current).toBe(true);
    const retained=hook.result.current.data.seats;
    await act(async()=>{await vi.advanceTimersByTimeAsync(49_999);});
    expect(getQuerySnapshot(verseBootstrapQuery.key).status).toBe('error');
    expect(hook.result.current.current).toBe(true);
    const reads=fetch.mock.calls.length;
    await act(async()=>{await vi.advanceTimersByTimeAsync(1);});
    expect(hook.result.current.current).toBe(false);
    expect(hook.result.current.now).toBe(T+60_000);
    expect(hook.result.current.data.seats).toBe(retained);
    expect(hook.result.current.rows[0]!.windows[0]!.usedPercent).toBe(43);
    expect(fetch.mock.calls.length).toBe(reads);
  });
  it('rechecks unchanged retained evidence immediately when the document becomes visible',async()=>{
    const {hook}=await seed();
    const visibility=vi.spyOn(document,'visibilityState','get');
    act(()=>{visibility.mockReturnValue('hidden');fireEvent(document,new Event('visibilitychange'));});
    await act(async()=>{await vi.advanceTimersByTimeAsync(60_000);});
    act(()=>{visibility.mockReturnValue('visible');fireEvent(document,new Event('visibilitychange'));});
    expect(hook.result.current.current).toBe(false);
    expect(hook.result.current.rows[0]!.windows[0]!.usedPercent).toBe(43);
  });
  it('uses actual render-time between periodic ticks instead of an older tick timestamp',async()=>{
    const {hook}=await seed();
    vi.setSystemTime(T+60_001);hook.rerender();
    expect(hook.result.current.current).toBe(false);
    expect(hook.result.current.now).toBe(T+60_001);
  });
});
