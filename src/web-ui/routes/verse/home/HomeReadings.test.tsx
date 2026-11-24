import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MainRepos, RunningLanes } from './HomeReadings.js';
import { laneTiles, lanesSummary, mainSummary, PIP_LIMIT, repoMarks, type HomeLane, type HomeRepo } from './home-readings-model.js';

const LANES: HomeLane[] = [
  { lane: 'claude', running: 3, target: 8 }, { lane: 'grok', running: 1, target: null },
  { lane: 'codex', running: 0, target: 4 }, { lane: 'devin', running: 6, target: 4 },
];
const REPOS: HomeRepo[] = [{ repo: 'phantom', state: 'green' }, { repo: 'stack', state: 'unknown' }, { repo: 'locus', state: 'red' }, { repo: 'lexicon', state: 'green' }];
afterEach(cleanup);

describe('lane tiles', () => {
  it('a square per target slot, filled for each running job; no target means no share and no squares', () => {
    const [claude, grok, codex, devin] = laneTiles(LANES);
    expect([claude!.percent, claude!.pips, claude!.over, claude!.words]).toEqual([38, [true, true, true, false, false, false, false, false], 0, 'claude: 3 of 8']);
    expect([grok!.percent, grok!.pips, grok!.words]).toEqual([null, null, 'grok: 1']);
    expect([codex!.percent, codex!.pips]).toEqual([0, [false, false, false, false]]);
    // More running than asked for fills every slot and says how many are beyond it; the share never passes 100.
    expect([devin!.percent, devin!.pips, devin!.over]).toEqual([100, [true, true, true, true], 2]);
  });
  it('a target of zero is not a share, and a large target is one bar instead of squares', () => {
    const [none, big] = laneTiles([{ lane: 'held', running: 0, target: 0 }, { lane: 'wide', running: 10, target: PIP_LIMIT + 1 }]);
    expect([none!.percent, none!.pips, none!.words]).toEqual([null, null, 'held: 0 of 0']);
    expect([big!.percent, big!.pips]).toEqual([40, null]);
  });
  it('sums only what the lanes hold', () => {
    // Filled slots stop at each lane's own target: devin's two extra jobs do not fill codex's open slots.
    expect(lanesSummary(LANES)).toBe('10 jobs running on 3 of 4 lanes. 7 of 16 target slots filled. 1 lane has no target.');
    expect(lanesSummary([{ lane: 'claude', running: 1, target: 1 }])).toBe('1 job running on 1 of 1 lane. 1 of 1 target slot filled.');
    expect(lanesSummary([{ lane: 'claude', running: 0, target: 2 }, { lane: 'grok', running: 0, target: null }])).toBe('No job is running on any of the 2 lanes. 0 of 2 target slots filled. 1 lane has no target.');
    expect(lanesSummary([{ lane: 'grok', running: 2, target: null }, { lane: 'local', running: 0, target: null }])).toBe('2 jobs running on 1 of 2 lanes. 2 lanes have no target.');
  });
});

describe('repository marks', () => {
  it('red first, then unknown, then green, in the order the summary gave within each', () => {
    expect(repoMarks(REPOS).map(repo => repo.repo)).toEqual(['locus', 'stack', 'phantom', 'lexicon']);
  });
  it('says green only when every default branch is green', () => {
    expect(mainSummary(REPOS)).toEqual({ tone: 'red', text: '1 of 4 default branches red: locus. Not known for stack.' });
    expect(mainSummary(REPOS.filter(repo => repo.state !== 'red'))).toEqual({ tone: 'unknown', text: '2 of 3 default branches green. Not known for stack.' });
    expect(mainSummary(REPOS.filter(repo => repo.state === 'green'))).toEqual({ tone: 'green', text: 'All 2 default branches are green.' });
    expect(mainSummary([REPOS[0]!])).toEqual({ tone: 'green', text: 'The one default branch is green.' });
    expect(mainSummary([{ repo: 'stack', state: 'unknown' }])).toEqual({ tone: 'unknown', text: '0 of 1 default branch green. Not known for stack.' });
  });
});

describe('Running jobs drawing', () => {
  it('draws a tile per lane with its provider mark, count and slots, and keeps the sentence for a screen reader', () => {
    const view = render(<RunningLanes lanes={LANES} />);
    expect(screen.getByText('10 jobs running on 3 of 4 lanes. 7 of 16 target slots filled. 1 lane has no target.')).toBeTruthy();
    const tiles = within(screen.getByRole('list', { name: 'Running jobs by lane' })).getAllByRole('listitem');
    expect(tiles).toHaveLength(4);
    for (const words of ['claude: 3 of 8', 'grok: 1', 'codex: 0 of 4', 'devin: 6 of 4']) expect(screen.getByText(words).className).toBe('visually-hidden');
    expect(tiles.map(tile => tile.querySelector('[data-provider-badge]')?.getAttribute('data-provider-badge'))).not.toContain(undefined);
    // grok has no recorded target: the words say so and there is no meter, rather than an empty one.
    expect(within(tiles[1]!).getByText('no target').hasAttribute('data-unknown')).toBe(true);
    expect(within(tiles[1]!).queryByRole('meter')).toBeNull();
    const meters = screen.getAllByRole('meter');
    expect(meters.map(meter => [meter.getAttribute('aria-label'), meter.getAttribute('aria-valuenow'), meter.getAttribute('aria-valuetext')])).toEqual([
      ['claude running of target', '38', '3 of 8 running'], ['codex running of target', '0', '0 of 4 running'], ['devin running of target', '100', '6 of 4 running'],
    ]);
    expect(meters.map(meter => [meter.querySelectorAll('i').length, meter.querySelectorAll('i[data-filled]').length])).toEqual([[8, 3], [4, 0], [4, 4]]);
    expect(within(tiles[3]!).getByText('2 over target')).toBeTruthy();
    expect(tiles.map(tile => tile.hasAttribute('data-idle'))).toEqual([false, false, true, false]);
    expect(view.container.querySelectorAll('button')).toHaveLength(0);
  });
  it('draws one bar of the same share when a lane has more slots than squares can show', () => {
    render(<RunningLanes lanes={[{ lane: 'wide', running: 10, target: PIP_LIMIT + 1 }]} />);
    const meter = screen.getByRole('meter', { name: 'wide running of target' });
    expect(meter.getAttribute('aria-valuenow')).toBe('40');
    expect([...meter.querySelectorAll('i')].map(fill => fill.style.width)).toEqual(['40%']);
  });
});

describe('Main drawing', () => {
  it('lists a mark per repository beside its words, red first, under one line that names what is red', () => {
    render(<MainRepos repos={REPOS} />);
    expect(screen.getByText('1 of 4 default branches red: locus. Not known for stack.').getAttribute('data-tone')).toBe('red');
    const marks = within(screen.getByRole('list', { name: 'Default branch by repository' })).getAllByRole('listitem');
    expect(marks.map(mark => [mark.textContent, mark.getAttribute('data-state')])).toEqual([['locus: red', 'red'], ['stack: unknown', 'unknown'], ['phantom: green', 'green'], ['lexicon: green', 'green']]);
  });
});

it('every color and size the drawings name is a real design token, and unknown is never drawn green', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), 'src/web-ui', path), 'utf8');
  const defined = new Set((read('design/tokens.css') + read('design/global.css')).match(/--[\w-]+(?=\s*:)/g));
  const css = read('routes/verse/home/home-readings.module.css');
  expect([...new Set(css.match(/(?<=var\()--[\w-]+/g))].filter(name => !defined.has(name))).toEqual([]);
  expect(css).toMatch(/\.repos li::before \{[^}]*--status-unknown-solid/);
  expect(css).toMatch(/prefers-reduced-motion/);
});
