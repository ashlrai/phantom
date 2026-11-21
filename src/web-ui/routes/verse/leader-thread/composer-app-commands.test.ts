import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../data/client.js';
import { appsLogLine, appsStateLine, appWords, namedApp, narrowMacApps, runAppCommand, runAppsCommand, type AppCommandDeps } from './composer-app-commands.js';
import { commandGate, runComposerCommand, type ComposerCommandDeps } from './composer-command-run.js';
import { commandArgError, commandHints, completeCommand, helpLine, parseComposerDraft } from './composer-commands.js';
import { APPS_NOW, appAction, appActions, appDone, appRow, macApps } from './composer-apps.test-support.js';

const TAIL = ' /app <name> opens one or brings it to the front; /open fleet-host has the whole log.';
const STATE = 'Apps on this Mac: Claude in front, 1.5 GB · Phantom running, 300 MB · Safari running, 800 MB · Cursor not running. Not installed: Codex.';
const LOG = 'Last action: Opened Claude, 3m ago. 2 of 14 on record did not go through, newest: Refused to quit Cursor, 1h ago.';

function appDeps(over: Partial<AppCommandDeps> = {}) {
  return {
    apps: vi.fn(async () => macApps() as ReturnType<typeof macApps> | null),
    actions: vi.fn(async () => appActions() as ReturnType<typeof appActions> | null),
    act: vi.fn(async (_app: string, _action: 'open' | 'focus') => appDone()),
    ...over,
  };
}

function composerDeps(apps: AppCommandDeps, over: Partial<ComposerCommandDeps> = {}): Omit<ComposerCommandDeps, 'openPane'> {
  const never = vi.fn(async () => { throw new Error('not this command'); });
  return { pauseFleet: never, resumeFleet: never, releaseHold: never, holdLane: never, stopJob: never, openDropSheet: vi.fn(() => 'kept' as const),
    statusNow: never, postNote: vi.fn(async () => {}), now: () => APPS_NOW, apps, ...over };
}

const refusal = (status: number, body: unknown) => new ApiError(`POST failed (HTTP ${status})`, status, '/api/verse/apps/control', null, null, body);

describe('the app commands in the command list', () => {
  it('parses, hints and completes them', () => {
    expect(parseComposerDraft('/apps')).toEqual({ kind: 'command', name: 'apps', arg: '' });
    expect(parseComposerDraft('/app Visual Studio ')).toEqual({ kind: 'command', name: 'app', arg: 'Visual Studio' });
    expect(commandHints('/a').map(hint => hint.usage)).toEqual(['/apps', '/app <name>']);
    expect(commandHints('/app cur').map(hint => hint.usage)).toEqual(['/app <name>']);
    expect(completeCommand('/a')).toBe('/apps');
    expect(helpLine()).toContain('/apps · /app <name> · /help');
  });

  it('asks for a name, and takes one of any reasonable length', () => {
    expect(commandArgError({ name: 'app', arg: '' })).toBe('/app needs a name: /app <name>');
    expect(commandArgError({ name: 'app', arg: 'x'.repeat(81) })).toBe('/app takes one app name: /app <name>');
    expect(commandArgError({ name: 'app', arg: 'cursor' })).toBeNull();
    expect(commandArgError({ name: 'apps', arg: '' })).toBeNull();
    // The pane the /apps answer points at is one /open knows.
    expect(commandArgError({ name: 'open', arg: 'fleet-host' })).toBeNull();
  });

  it('/apps only reads; /app needs the token and no confirm, like the card button', () => {
    expect(commandGate({ name: 'apps', arg: '' })).toBeNull();
    expect(commandGate({ name: 'app', arg: 'cursor' })).toEqual({ reason: 'Opening an app requires the mutation token.', confirm: null });
    // A missing name is answered locally, so it must not ask for the token first.
    expect(commandGate({ name: 'app', arg: '' })).toBeNull();
  });
});

describe('what /apps says', () => {
  it('names each app with its state, open ones first, and never fills in an unknown', () => {
    expect(appWords(appRow({ frontmost: true, memoryMb: 1536 }))).toBe('Claude in front, 1.5 GB');
    expect(appWords(appRow({ memoryMb: null }))).toBe('Claude running');
    expect(appWords(appRow({ running: false }))).toBe('Claude not running');
    expect(appWords(appRow({ running: null }))).toBe('Claude installed, running unknown');
    expect(appWords(appRow({ installed: null, running: null }))).toBe('Claude state unknown');
    expect(appWords(appRow({ installed: false }))).toBe('Claude not installed');
    expect(appsStateLine(macApps())).toBe(STATE);
    expect(appsStateLine(macApps({ apps: [] }))).toBe('No app is listed for this Mac.');
    expect(appsStateLine(macApps({ apps: [appRow({ installed: false })] }))).toBe('None of the known apps is installed on this Mac.');
    expect(appsStateLine(macApps({ probe: 'partial', reason: 'ps did not answer', apps: [appRow({ running: null })] })))
      .toBe('Apps on this Mac: Claude installed, running unknown. Some state is unknown: ps did not answer.');
  });

  it('gives the newest action and how many did not go through', () => {
    expect(appsLogLine(appActions(), APPS_NOW)).toBe(LOG);
    // The newest one is itself the one to look at: its reason is given once and it is not named twice.
    expect(appsLogLine(appActions({ actions: [appAction({ action: 'quit', app: 'Safari', outcome: 'refused', detail: 'Safari is in front.' })], total: 3, counts: { done: 2, refused: 1 } }), APPS_NOW))
      .toBe('Last action: Refused to quit Safari (Safari is in front), 3m ago. 1 of 3 on record did not go through.');
    expect(appsLogLine(appActions({ actions: [appAction()], total: 1, counts: { done: 1 } }), APPS_NOW)).toBe('Last action: Opened Claude, 3m ago.');
    expect(appsLogLine(appActions({ actions: [], total: 0, counts: {} }), APPS_NOW)).toBe('Phantom has not acted on an app in the last 7 days.');
    expect(appsLogLine(appActions({ source: 'missing', actions: [], total: 0, counts: {} }), APPS_NOW)).toBe('Phantom has not acted on an app yet.');
    expect(appsLogLine(appActions({ source: 'unavailable', actions: [], total: null, counts: {}, lookups: null }), APPS_NOW))
      .toBe('What Phantom did to them is unknown: the action log could not be read.');
  });

  it('answers with both halves in one line', async () => {
    const deps = appDeps();
    expect(await runAppsCommand(deps, APPS_NOW)).toBe(`${STATE} ${LOG}${TAIL}`);
    expect(deps.act).not.toHaveBeenCalled();
  });

  it('says which half is unknown, and why, when a read does not answer', async () => {
    expect(await runAppsCommand(appDeps({ actions: vi.fn(async () => { throw new TypeError('fetch failed'); }) }), APPS_NOW))
      .toBe(`${STATE} What Phantom did to them is unknown. The server did not answer.${TAIL}`);
    expect(await runAppsCommand(appDeps({ apps: vi.fn(async () => null) }), APPS_NOW))
      .toBe(`App state is unknown: this server did not return the app list. ${LOG}`);
    const local = vi.fn(async () => { throw refusal(403, { error: 'local request required' }); });
    expect(await runAppsCommand(appDeps({ apps: local, actions: local }), APPS_NOW))
      .toBe('App state can be read only on the Mac Phantom runs on. What Phantom did to them can be read only on the Mac Phantom runs on.');
    const absent = vi.fn(async () => { throw refusal(404, { error: 'not found' }); });
    expect(await runAppsCommand(appDeps({ apps: absent }), APPS_NOW)).toBe(`App state is unknown: this server does not serve it yet. ${LOG}`);
  });

  it('runs through the composer with no token gate and no inbox note', async () => {
    const deps = composerDeps(appDeps());
    expect(await runComposerCommand({ name: 'apps', arg: '' }, deps)).toBe(`${STATE} ${LOG}${TAIL}`);
    expect(deps.postNote).not.toHaveBeenCalled();
  });

  it('accepts only the report it knows', () => {
    expect(narrowMacApps(macApps())).not.toBeNull();
    expect(narrowMacApps({ schema: 'phm.apps/1', apps: [] })).toBeNull();
    expect(narrowMacApps({ schema: 'phm.apps/2', apps: [{ id: 'claude' }] })).toBeNull();
    expect(narrowMacApps('<html>')).toBeNull();
  });
});

describe('the app a typed name means', () => {
  it('takes the id, the full name in any case, or the only app starting with it', () => {
    const report = macApps();
    expect(namedApp(report, 'cursor')).toMatchObject({ kind: 'one', row: { id: 'cursor' } });
    expect(namedApp(report, ' SAFARI ')).toMatchObject({ kind: 'one', row: { id: 'safari' } });
    expect(namedApp(report, 'cur')).toMatchObject({ kind: 'one', row: { id: 'cursor' } });
    expect(namedApp(report, 'c')).toEqual({ kind: 'several', names: ['Cursor', 'Claude', 'Codex'] });
    expect(namedApp(report, 'xcode')).toEqual({ kind: 'none' });
    expect(namedApp(report, '  ')).toEqual({ kind: 'none' });
  });
});

describe('/app <name>', () => {
  it('opens a closed app and brings a running one to the front, the one action its row offers', async () => {
    const open = appDeps();
    expect(await runAppCommand('cur', open)).toEqual(['Cursor: asked macOS to open Cursor.', 'done']);
    expect(open.act).toHaveBeenCalledWith('cursor', 'open');
    const focus = appDeps({ act: vi.fn(async () => appDone({ action: 'focus', app: 'safari', detail: 'raised Safari.' })) });
    expect(await runAppCommand('Safari', focus)).toEqual(['Safari: raised Safari.', 'done']);
    expect(focus.act).toHaveBeenCalledWith('safari', 'focus');
  });

  it('says so when the request went to needs-you instead', async () => {
    const deps = appDeps({ act: vi.fn(async () => appDone({ ok: false, outcome: 'needs-you', detail: 'Cursor is a request-mode app. Sent to needs-you.' })) });
    expect(await runAppCommand('cursor', deps)).toEqual(['Cursor was not opened yet: Cursor is a request-mode app. Sent to needs-you.', 'sent to needs-you']);
  });

  it('runs nothing for a name that fits no app, several apps, or an app with nothing to do', async () => {
    const deps = appDeps();
    await expect(runAppCommand('xcode', deps)).rejects.toThrow('No app Phantom knows is named "xcode". It can open Cursor, Safari.');
    await expect(runAppCommand('c', deps)).rejects.toThrow('"c" fits Cursor, Claude, Codex. Type more of the name.');
    await expect(runAppCommand('codex', deps)).rejects.toThrow('Codex is not installed on this Mac.');
    await expect(runAppCommand('phantom', deps)).rejects.toThrow('Phantom offers no open or bring-to-front for Phantom (Phantom running, 300 MB).');
    await expect(runAppCommand('claude', deps)).rejects.toThrow('Phantom offers no open or bring-to-front for Claude (Claude in front, 1.5 GB).');
    expect(deps.act).not.toHaveBeenCalled();
  });

  it('does not act on a list it could not read', async () => {
    const deps = appDeps({ apps: vi.fn(async () => { throw new TypeError('fetch failed'); }) });
    await expect(runAppCommand('cursor', deps)).rejects.toThrow('App state is unknown. The server did not answer. Nothing was opened.');
    const wrong = appDeps({ apps: vi.fn(async () => null) });
    await expect(runAppCommand('cursor', wrong)).rejects.toThrow('App state is unknown: this server did not return the app list. Nothing was opened.');
    expect(deps.act).not.toHaveBeenCalled();
    expect(wrong.act).not.toHaveBeenCalled();
  });

  it('gives the server’s reason for a refusal', async () => {
    const refused = appDeps({ act: vi.fn(async () => { throw refusal(422, appDone({ ok: false, outcome: 'refused', detail: 'not in apps-allow.json.' })); }) });
    await expect(runAppCommand('cursor', refused)).rejects.toThrow('Phantom refused: not in apps-allow.json.');
    const failed = appDeps({ act: vi.fn(async () => { throw refusal(422, appDone({ ok: false, outcome: 'failed', detail: 'the launcher exited 1' })); }) });
    await expect(runAppCommand('cursor', failed)).rejects.toThrow('The launcher exited 1.');
    const remote = appDeps({ act: vi.fn(async () => { throw refusal(403, { error: 'local request required' }); }) });
    await expect(runAppCommand('cursor', remote)).rejects.toThrow('Apps can be opened only on the Mac Phantom runs on.');
    const noDispatch = appDeps({ act: vi.fn(async () => { throw refusal(404, { error: 'not found' }); }) });
    await expect(runAppCommand('cursor', noDispatch)).rejects.toThrow('This server cannot open apps (it runs without dispatch).');
  });

  it('through the composer: a done action is noted to the leaders, a refusal is not', async () => {
    const done = composerDeps(appDeps());
    expect(await runComposerCommand({ name: 'app', arg: 'cursor' }, done)).toBe('Cursor: asked macOS to open Cursor.');
    expect(done.postNote).toHaveBeenCalledWith('[composer] /app cursor: done');
    const refused = composerDeps(appDeps({ act: vi.fn(async () => { throw refusal(422, appDone({ ok: false, outcome: 'refused', detail: 'app writes are stopped by KILL or comms pause.' })); }) }));
    expect(await runComposerCommand({ name: 'app', arg: 'cursor' }, refused)).toBe('/app cursor failed: Phantom refused: app writes are stopped by KILL or comms pause.');
    expect(refused.postNote).not.toHaveBeenCalled();
  });
});
