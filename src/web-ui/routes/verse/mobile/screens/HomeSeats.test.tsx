import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { capacity, nativeSeat, seatWindow } from '../../seat-fixtures.test-support.js';
const fixture=vi.hoisted(()=>({seats:[] as unknown[]}));
vi.mock('../../../../data/hooks.js',()=>({useQuery:(query:{key:string})=>({data:query.key==='verse-bootstrap'?{seats:fixture.seats}:undefined})}));
vi.mock('../../useSeatsRefresh.js',()=>({useSeatsRefresh:()=>{}}));
import { HomeSeats } from './HomeSeats.js';
import { Meter } from '../ui-parts.js';
afterEach(()=>{cleanup();vi.useRealTimers();});
it('keeps mobile native quota as gray recorded values at original expiry',()=>{
  vi.useFakeTimers();const t=Date.parse('2026-10-12T12:00:00.000Z');vi.setSystemTime(t+10_000);
  const window=seatWindow({id:'weekly',usedPercent:43,resetsAt:null});
  fixture.seats=[nativeSeat(capacity({windows:[window],binding:window,usability:'ready',observedAt:new Date(t).toISOString(),quotaExpiresAt:new Date(t+60_000).toISOString()}),{engine:'codex',label:'Synthetic native'})];
  render(<HomeSeats />);
  expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow','43');
  act(()=>{vi.advanceTimersByTime(50_000);});
  expect(screen.getByRole('meter')).not.toHaveAttribute('aria-valuenow');
  expect(screen.getByText('43% used · last')).toBeInTheDocument();
  expect(screen.getByText(/current usage unconfirmed/)).toBeInTheDocument();
});
it('prints the binding window by the one percent rule, never a rounded 100% or 0%',()=>{
  vi.useFakeTimers();const t=Date.parse('2026-10-12T12:00:00.000Z');vi.setSystemTime(t+10_000);
  for(const [used,text] of [[99.6,'99% used'],[0.3,'<1% used']] as const){
    const window=seatWindow({id:'weekly',usedPercent:used,resetsAt:null});
    fixture.seats=[nativeSeat(capacity({windows:[window],binding:window,usability:'ready',observedAt:new Date(t).toISOString(),quotaExpiresAt:new Date(t+60_000).toISOString()}),{engine:'codex',label:'Synthetic native'})];
    render(<HomeSeats />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext',text);
    cleanup();
  }
});
it('the shared phone Meter applies the same rule to its default text',()=>{
  render(<Meter label="Window" percent={99.6} />);
  expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext','99% used');
  cleanup();
  render(<Meter label="Window" percent={0.3} />);
  expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext','<1% used');
});
