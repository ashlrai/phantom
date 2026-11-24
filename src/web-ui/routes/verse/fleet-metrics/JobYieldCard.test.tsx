import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { jobYield, unknownJobYield } from '../../../../core/fleet/slot-yield.js';
import { expiresIn, JOB_YIELD_ROWS, JobYieldCard } from './JobYieldCard.js';

const now = Date.parse('2026-11-18T00:00:00Z');
const row = (fields: Record<string, unknown>) => JSON.stringify({ ts: new Date(now - 3_600_000).toISOString(), ...fields });
/** One job: a launch, a finish and, when merged, a PR and its outcome. */
const job = (id: string, merged: boolean, repo = 'phantom') => [row({ event: 'launch', job: id, repo }), row({ event: 'finish', job: id, empty: !merged }),
  ...(merged ? [row({ event: 'publish', job: id, class: 'pr', url: `https://example.invalid/pr/${id}` }), row({ event: 'outcome', job: id, state: 'MERGED' })] : [])];

it('shows the plain top line and one table with the kinds to stop first', () => {
  const lines = [
    ...Array.from({ length: 6 }, (_, i) => job(`RQ-PHX-RECUTCOREC${560 + i}`, false)).flat(),
    ...Array.from({ length: 6 }, (_, i) => job(`RQ-MD${i}A11180${i}Q8`, false, 'md')).flat(),
    row({ event: 'precheck_skip', job: 'RQ-MD9A111809Q8', repo: 'md', code: 13 }),
    ...job('RQ-GOODWORK-1', true), ...job('RQ-GOODWORK-2', true), ...job('RQ-GOODWORK-3', false),
  ];
  render(<JobYieldCard report={jobYield(lines, now, 24)} />);
  expect(screen.getByRole('heading', { name: 'Job yield' })).toBeTruthy();
  expect(screen.getByText('12 of 15 launches went to 2 job kinds that merged nothing')).toBeTruthy();
  const names = screen.getAllByRole('rowheader').map(cell => cell.textContent);
  expect(names).toEqual(['one-test filler md', 'RQ-PHX-RECUTCORE', 'RQ-GOODWORK']);
  expect(within(screen.getByRole('row', { name: /^one-test filler md/ })).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['stop', '6', '6', '1', '0', '0.00']);
  expect(within(screen.getByRole('row', { name: /^RQ-GOODWORK/ })).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['keep', '3', '1', '0', '2', '0.67']);
  expect(screen.getByRole('row', { name: /^RQ-PHX-RECUTCORE/ }).getAttribute('data-verdict')).toBe('stop');
});

it('says so in words when nothing launched, with no table', () => {
  render(<JobYieldCard report={jobYield([], now, 24)} />);
  expect(screen.getByText('No launches in the last 24 hours')).toBeTruthy();
  expect(screen.queryByRole('table')).toBeNull();
});

it('reads unknown for an unreadable file, a missing report and a wrong shape', () => {
  const { rerender } = render(<JobYieldCard report={unknownJobYield(24)} />);
  expect(screen.getByText('Job yield: unknown (job metrics file unreadable)')).toBeTruthy();
  for (const report of [undefined, { schema: 'other' }]) {
    rerender(<JobYieldCard report={report as never} />);
    expect(screen.getByText('Job yield: unknown')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  }
});

it('sums up the kinds past the row limit instead of dropping them', () => {
  const lines = Array.from({ length: JOB_YIELD_ROWS + 2 }, (_, i) => job(`RQ-KIND${String.fromCharCode(65 + i)}-1`, true)).flat();
  render(<JobYieldCard report={jobYield(lines, now, 24)} />);
  expect(screen.getAllByRole('rowheader')).toHaveLength(JOB_YIELD_ROWS);
  expect(screen.getByText('2 more job kinds with 2 launches not shown.')).toBeTruthy();
});

it('lists stopped families with why and time left, and says unknown or none in words', () => {
  const stopped = [{ family: 'RQ-PHX-RECUTCORE', why: '0 merged from 6 launches', until: 2, expires_in_s: 5 * 3600 + 60, auto: true },
    { family: '^RQ-HAND', why: 'by_hand', until: 1, expires_in_s: 20, auto: false }];
  const { rerender } = render(<JobYieldCard report={jobYield([], now, 24)} stopped={stopped} />);
  expect(screen.getByRole('heading', { name: 'Stopped families' })).toBeTruthy();
  expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual([
    'RQ-PHX-RECUTCORE 0 merged from 6 launches · expires in 5 hours', '^RQ-HAND by_hand · expires in 1 minute']);
  rerender(<JobYieldCard report={jobYield([], now, 24)} stopped={[]} />);
  expect(screen.getByText('No family is stopped.')).toBeTruthy();
  for (const unknown of [null, undefined]) {
    rerender(<JobYieldCard report={jobYield([], now, 24)} stopped={unknown} />);
    expect(screen.getByText('Stopped families: unknown')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  }
  expect([59, 3600, 7199, 172_800].map(expiresIn)).toEqual(['1 minute', '1 hour', '1 hour', '2 days']);
});

it('shows ranked empty reasons and partial token measurements from the typed report', () => {
  render(<JobYieldCard report={{ ...jobYield([], now, 24), empty_why: { schema: 'jobs.empty-why.v1', version: 1, window_hours: 24, known: true, total: 2, jobs: [], lane: null, last: null, sampled: 2, verdict: 'all lanes: 2 of 2 empty', generators: [],
    families: [{ family: 'RQ-REPAIR', empty: 2, wasted_tokens: 42, tokens_unknown_jobs: 1, reasons: { 'pool-cap': 0, 'no-diff': 0, 'already-on-main': 1, 'precheck-catchable': 0, 'tool-error': 0, unknown: 1 } }] } }} />);
  expect(screen.getByRole('region', { name: 'Why jobs ended empty' }).textContent).toContain('RQ-REPAIR: 42 wasted tokens (1 job with unknown tokens); 1 already on main, 1 unknown');
});


it('keeps stopped families visible beside empty-reason evidence after integration', () => {
  render(<JobYieldCard stopped={[{family:'fixture-stop',why:'manual',until:1,expires_in_s:60,auto:false}]} report={{...jobYield([],now,24),empty_why:{schema:'jobs.empty-why.v1',version:1,window_hours:24,known:true,total:0,jobs:[],families:[],lane:null,last:null,sampled:0,verdict:'all lanes: 0 of 0 empty',generators:[]}}} />);
  expect(screen.getByRole('heading',{name:'Stopped families'})).toBeTruthy();
  expect(screen.getByRole('region',{name:'Why jobs ended empty'})).toBeTruthy();
  expect(screen.getByText('fixture-stop')).toBeTruthy();
});
