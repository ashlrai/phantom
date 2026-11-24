import { describe, expect, it } from 'vitest';
import { buildLiveSessions } from '../../../../core/fleet/live-sessions.js';
import { clockTime } from '../leader/thread-model.js';
import type { LaneTargetRow, LaneTargetsV1 } from '../ops/lane-targets-model.js';
import { appOptions, ARG_LIMIT, argListName, argQuery, enterFills, HOLD_PRESETS, holdEnd, insertArg, laneOptions, minuteOptions, paneOptions, sessionOptions } from './command-arg-model.js';
import { appRow, macApps } from './composer-apps.test-support.js';
import { ASSIST_NOW, assistSessions, noSessions } from './composer-assist.test-support.js';

const UNTIL = '2026-11-20T14:05:00Z';
const lane = (name: string, over: Partial<LaneTargetRow> = {}): LaneTargetRow => ({ lane: name, target: 3, floor: 0, ceiling: 6, held: false,
  heldReason: null, heldUntil: null, lastChange: null, changedBy: null, ...over });
const targets = (over: Partial<LaneTargetsV1> = {}): LaneTargetsV1 => ({ v: 1, generatedAt: '2026-11-20T12:00:00Z', sourceState: 'healthy', lanes: [
  lane('codex-personal', { held: true, heldReason: 'quota reset pending', heldUntil: UNTIL }),
  lane('claude', { target: 4 }),
  lane('glm', { held: true }),
], ...over });

const values = (options: { shown: { value: string }[] }) => options.shown.map(option => option.value);

describe('argQuery', () => {
  it('finds the argument being typed after a command that takes one', () => {
    expect(argQuery('/release ', 9)).toEqual({ name: 'release', source: 'lanes', query: '', start: 9 });
    expect(argQuery('  /STOP RQ-', 11)).toEqual({ name: 'stop', source: 'sessions', query: 'RQ-', start: 8 });
    expect(argQuery('/open fleet', 11)).toMatchObject({ name: 'open', source: 'panes', query: 'fleet' });
    expect(argQuery('/app Google Ch', 14)).toMatchObject({ name: 'app', source: 'apps', query: 'Google Ch' });
    expect(argQuery('/lane cl', 8)).toEqual({ name: 'lane', source: 'lanes', query: 'cl', start: 6 });
  });

  it('moves on to the minutes once /hold has its lane', () => {
    expect(argQuery('/hold claude ', 13)).toEqual({ name: 'hold', source: 'minutes', query: '', start: 13 });
    expect(argQuery('/hold claude 30', 15)).toEqual({ name: 'hold', source: 'minutes', query: '30', start: 13 });
    expect(argQuery('/hold cla', 9)).toMatchObject({ source: 'lanes', query: 'cla' });
  });

  it('is null before the space, past the first argument, away from the end, and for other drafts', () => {
    expect(argQuery('/release', 8)).toBeNull();
    expect(argQuery('/hold claude 30 ', 16)).toBeNull();
    expect(argQuery('/hold claude soon', 17)).toBeNull();
    expect(argQuery('/lane claude ', 13)).toBeNull();
    expect(argQuery('/release codex', 9)).toBeNull();
    expect(argQuery('/who ', 5)).toBeNull();
    expect(argQuery('/drop fix the build', 19)).toBeNull();
    expect(argQuery('/tmp/file is missing', 20)).toBeNull();
    expect(argQuery('Please /release claude', 22)).toBeNull();
    expect(argQuery('/release claude\nnow', 19)).toBeNull();
  });
});

describe('laneOptions', () => {
  it('/release offers only the held lanes, with the reason and the time the hold ends', () => {
    const options = laneOptions(targets(), 'release', '');
    expect(options.shown).toEqual([
      { value: 'codex-personal', label: 'codex-personal', lane: 'codex-personal', tone: 'warn', facts: `held until ${clockTime(UNTIL)}`, note: 'quota reset pending' },
      { value: 'glm', label: 'glm', lane: 'glm', tone: 'warn', facts: 'held', note: 'reason not recorded' },
    ]);
    expect(options).toMatchObject({ more: 0, empty: null, caveat: null });
  });

  it('/hold offers every lane, the ones not yet held first', () => {
    const options = laneOptions(targets(), 'hold', '');
    expect(values(options)).toEqual(['claude', 'codex-personal', 'glm']);
    expect(options.shown[0]).toMatchObject({ facts: 'not held · target 4', note: null, tone: 'none' });
    expect(options.shown[1]).toMatchObject({ facts: `already held until ${clockTime(UNTIL)}`, tone: 'warn' });
  });

  it('/lane offers every lane in the record’s order, a held one marked', () => {
    const options = laneOptions(targets(), 'lane', '');
    expect(values(options)).toEqual(['codex-personal', 'claude', 'glm']);
    expect(options.shown[0]).toMatchObject({ facts: `held until ${clockTime(UNTIL)}`, note: 'quota reset pending', tone: 'warn' });
    expect(options.shown[1]).toMatchObject({ facts: 'not held · target 4', tone: 'none' });
  });

  it('says so when no lane is held, none is listed, or none matches', () => {
    expect(laneOptions(targets({ lanes: [lane('claude')] }), 'release', '').empty).toBe('No lane is held right now.');
    expect(laneOptions(targets({ lanes: [] }), 'hold', '').empty).toBe('No lane is listed.');
    expect(laneOptions(targets(), 'release', 'zz').empty).toBe('No held lane matches “zz”.');
  });

  it('names a lane record that is not healthy and counts rows beyond the limit', () => {
    expect(laneOptions(targets({ sourceState: 'degraded' }), 'hold', '').caveat).toBe('The lane record is degraded; this list may be incomplete.');
    const many = laneOptions(targets({ lanes: Array.from({ length: ARG_LIMIT + 2 }, (_, index) => lane(`lane-${index}`)) }), 'hold', 'lane');
    expect(many.shown).toHaveLength(ARG_LIMIT);
    expect(many.more).toBe(2);
  });
});

describe('sessionOptions', () => {
  const list = assistSessions();

  it('/stop offers the running jobs only, a quiet one marked', () => {
    const options = sessionOptions(list, 'stop', '');
    expect([...values(options)].sort()).toEqual(['RQ-A', 'RQ-CODEX', 'RQ-QUIET']);
    const byValue = new Map(options.shown.map(option => [option.value, option]));
    expect(byValue.get('RQ-A')).toMatchObject({ tone: 'ok', lane: 'claude', note: 'Running the tests' });
    expect(byValue.get('RQ-A')!.facts).toMatch(/^running · claude · spoke \d+m ago$/);
    expect(byValue.get('RQ-QUIET')).toMatchObject({ tone: 'warn' });
    expect(byValue.get('RQ-QUIET')!.facts).toMatch(/^quiet · claude · /);
    expect(byValue.get('RQ-CODEX')).toMatchObject({ note: null, lane: 'codex-local' });
  });

  it('/log adds the finished jobs after the running ones; /thread adds helpers too', () => {
    const log = sessionOptions(list, 'log', '');
    expect(values(log).at(-1)).toBe('RQ-FAILED');
    expect(log.shown.at(-1)).toMatchObject({ tone: 'bad' });
    expect(values(log)).not.toContain('helper-a');
    const thread = sessionOptions(list, 'thread', 'helper');
    expect(values(thread)).toEqual(['helper-a']);
    expect(thread.shown[0]!.facts).toMatch(/^helper · running · claude · /);
  });

  it('narrows by id first, then by lane or last words, and drops the @ the other picker writes', () => {
    expect(values(sessionOptions(list, 'stop', 'codex'))).toEqual(['RQ-CODEX']);
    expect(values(sessionOptions(list, 'stop', '@rq-a'))).toEqual(['RQ-A']);
    expect(values(sessionOptions(list, 'stop', 'the tests'))).toEqual(['RQ-A']);
    expect(sessionOptions(list, 'stop', 'zzz').empty).toBe('No running job matches “zzz”.');
  });

  it('says nobody is running only when the list was read', () => {
    expect(sessionOptions(noSessions(), 'stop', '')).toMatchObject({ shown: [], empty: 'No job is running right now.', caveat: null });
    expect(sessionOptions(buildLiveSessions(null, ASSIST_NOW), 'summary', '').caveat).toBe('Sessions unknown: the session list could not be read.');
  });
});

describe('appOptions and paneOptions', () => {
  it('/app offers the apps the Apps card can open or bring forward, by id', () => {
    const options = appOptions(macApps(), '');
    expect(options.shown).toEqual([
      { value: 'cursor', label: 'Cursor', lane: null, tone: 'off', facts: 'not running', note: 'opens it' },
      { value: 'safari', label: 'Safari', lane: null, tone: 'ok', facts: 'running, 800 MB', note: 'brings it to the front' },
    ]);
    expect(values(appOptions(macApps(), 'saf'))).toEqual(['safari']);
  });

  it('keeps unknown app state unknown and says when nothing can be opened', () => {
    const unknown = appOptions(macApps({ reason: 'the process list could not be read.', apps: [appRow({ running: null, memoryMb: null, action: 'open' })] }), '');
    expect(unknown.shown[0]).toMatchObject({ facts: 'installed, running unknown', tone: 'off' });
    expect(unknown.caveat).toBe('Some app state is unknown: the process list could not be read.');
    expect(appOptions(macApps({ apps: [appRow({ action: null })] }), '').empty).toBe('No app on this Mac can be opened from here.');
  });

  it('/open offers panes by id with their titles, a start of the id first', () => {
    const panes = [{ id: 'browser', title: 'Browser' }, { id: 'fleet-queue', title: 'Queue' }, { id: 'queue-notes', title: 'Notes' }, { id: 'fleet-lanes', title: 'Lanes' }];
    expect(values(paneOptions(panes, 'queue'))).toEqual(['queue-notes', 'fleet-queue']);
    expect(paneOptions(panes, 'lan').shown).toEqual([{ value: 'fleet-lanes', label: 'fleet-lanes', facts: 'Lanes', note: null, tone: 'none', lane: null }]);
    expect(paneOptions([], '').empty).toBe('No pane is registered.');
  });
});

describe('minuteOptions', () => {
  // Local noon, so no listed length but the day-long one crosses midnight in any time zone.
  const noon = new Date(2026, 10, 20, 12, 0, 0).getTime();
  const at = (minutes: number) => clockTime(new Date(noon + minutes * 60_000).toISOString());

  it('offers the lengths of hold, each with the time it would end', () => {
    const options = minuteOptions('', noon);
    expect(values(options)).toEqual(HOLD_PRESETS.map(String));
    expect(options.shown[0]).toEqual({ value: '15', label: '15 min', facts: `until ${at(15)}`, note: null, tone: 'none', lane: null });
    expect(options.shown.map(option => option.label)).toEqual(['15 min', '30 min', '1 h', '2 h', '4 h', '24 h']);
    expect(options.shown[5]!.facts).toBe(`until ${at(1440)} tomorrow`);
    expect(holdEnd(60, noon)).toBe(at(60));
  });

  it('narrows to the lengths that start with the digits typed', () => {
    expect(values(minuteOptions('3', noon))).toEqual(['3', '30']);
    expect(values(minuteOptions('30', noon))).toEqual(['30']);
    expect(values(minuteOptions('030', noon))).toEqual(['30']);
  });

  it('lists a length typed by hand first with its own end time, and refuses what the command refuses', () => {
    const typed = minuteOptions('90', noon);
    expect(typed.shown).toEqual([{ value: '90', label: '1 h 30 min', facts: `until ${at(90)}`, note: null, tone: 'none', lane: null }]);
    expect(minuteOptions('0', noon)).toEqual({ shown: [], more: 0, empty: 'Minutes must be a whole number from 1 to 1440.', caveat: null });
    expect(minuteOptions('1441', noon).empty).toBe('Minutes must be a whole number from 1 to 1440.');
    expect(values(minuteOptions('1440', noon))).toEqual(['1440']);
  });

  it('names its list apart from the lane list', () => {
    expect(argListName(argQuery('/hold claude ', 13)!)).toBe('Minutes to hold');
    expect(argListName(argQuery('/hold ', 6)!)).toBe('Lanes');
    expect(argListName(argQuery('/release ', 9)!)).toBe('Held lanes');
  });
});

describe('insertArg and enterFills', () => {
  it('replaces what was typed of the argument; /hold keeps a space for the minutes', () => {
    expect(insertArg('/release co', argQuery('/release co', 11)!, 'codex-personal')).toBe('/release codex-personal');
    expect(insertArg('/hold ', argQuery('/hold ', 6)!, 'claude')).toBe('/hold claude ');
    expect(insertArg('/app saf', argQuery('/app saf', 8)!, 'safari')).toBe('/app safari');
    expect(insertArg('/hold claude 3', argQuery('/hold claude 3', 14)!, '30')).toBe('/hold claude 30');
    expect(insertArg('/lane cl', argQuery('/lane cl', 8)!, 'claude')).toBe('/lane claude');
  });

  it('lets Enter fill in only while nothing is typed or after the arrows moved', () => {
    expect(enterFills(argQuery('/stop ', 6)!, false)).toBe(true);
    expect(enterFills(argQuery('/stop RQ-A', 10)!, false)).toBe(false);
    expect(enterFills(argQuery('/stop RQ-A', 10)!, true)).toBe(true);
  });
});
