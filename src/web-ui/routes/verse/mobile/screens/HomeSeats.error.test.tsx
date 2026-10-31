import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../../../data/client.js';
import { capacity, nativeSeat, seatWindow } from '../../seat-fixtures.test-support.js';
const fixture=vi.hoisted(()=>({bootstrap:{} as Record<string,unknown>,refetch:vi.fn()}));
vi.mock('../../../../data/hooks.js',()=>({useQuery:(query:{key:string})=>query.key==='verse-bootstrap'?fixture.bootstrap:{status:'loading'}}));
vi.mock('../../../../data/cache.js',async n=>({...await n<typeof import('../../../../data/cache.js')>(),refetchQuery:fixture.refetch}));
vi.mock('../../useSeatsRefresh.js',()=>({useSeatsRefresh:()=>{}}));
import { HomeSeats } from './HomeSeats.js';
afterEach(()=>{cleanup();fixture.refetch.mockClear();});
it('says why the seats read failed and retries it',async()=>{
  fixture.bootstrap={status:'error',error:new ApiError('GET /api/verse/bootstrap failed (HTTP 503).',503,'/api/verse/bootstrap','fake refusal')};
  render(<HomeSeats />);
  const alert=screen.getByRole('alert');
  expect(alert).toHaveTextContent('Couldn’t read seats');
  expect(alert).toHaveTextContent('fake refusal');
  await userEvent.click(screen.getByRole('button',{name:'Try again'}));
  expect(fixture.refetch).toHaveBeenCalledTimes(1);
  expect(fixture.refetch).toHaveBeenCalledWith('verse-bootstrap',expect.any(Function));
});
it('keeps the skeleton while the bootstrap read is still out',()=>{
  fixture.bootstrap={status:'loading'};
  render(<HomeSeats />);
  expect(screen.getByRole('status',{name:'Loading seats'})).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it('keeps seats on screen when a refresh fails over cached data',()=>{
  const window=seatWindow({id:'weekly',usedPercent:43,resetsAt:null});
  const seat=nativeSeat(capacity({windows:[window],binding:window,usability:'ready'}),{engine:'codex',label:'Synthetic native'});
  fixture.bootstrap={status:'error',error:new ApiError('fake refusal',503,'/api/verse/bootstrap'),data:{seats:[seat]}};
  render(<HomeSeats />);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByText(/Synthetic native/)).toBeInTheDocument();
});
