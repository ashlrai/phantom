import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../data/client.js';
import type { SessionThread } from '../fleet-sessions/session-thread-model.js';
import { assistSessions, noSessions } from './composer-assist.test-support.js';
import { commandGate, liveComposerDeps, runComposerCommand } from './composer-command-run.js';
import { commandArgError, commandHints, completeCommand, helpLine, parseComposerDraft, sessionArg } from './composer-commands.js';
import { isSessionCommand, namedSession, runSessionCommand, summaryLine, SUMMARY_LINES, WHO_LIMIT, whoLine, type SessionCommandDeps } from './composer-session-commands.js';

function thread(over: Partial<SessionThread> = {}, session: Partial<SessionThread['session']> = {}): SessionThread {
  return {
    generatedAt: '2026-11-18T12:00:00Z',
    session: { id: 'RQ-A', kind: 'worker', lane: 'claude', model: 'fixture-model', repo: 'phantom', jobId: 'RQ-A', parentId: 'leader', state: 'running',
      lastMessageAgeSeconds: 120, prUrl: null, ...session },
    summary: ['Running for 30 minutes on claude.', 'It last said: Running the tests.'],
    messages: [],
    sources: { activity: 'available', bus: 'none', owner: 'none', replies: 'none', orders: 'none' },
    gaps: [],
    reply: { to: 'job', job: 'RQ-A', hint: '' },
    ...over,
  };
}

function deps(over: Partial<SessionCommandDeps> = {}) {
  return {
    sessions: vi.fn(async () => assistSessions()),
    thread: vi.fn(async (_id: string) => thread() as SessionThread | null),
    openConversation: vi.fn(),
    openLog: vi.fn(),
    ...over,
  };
}

describe('the session commands in the command list', () => {
  it('parses, hints and completes them', () => {
    expect(parseComposerDraft('/who')).toEqual({ kind: 'command', name: 'who', arg: '' });
    expect(parseComposerDraft('/thread @RQ-A ')).toEqual({ kind: 'command', name: 'thread', arg: '@RQ-A' });
    expect(commandHints('/w').map(hint => hint.usage)).toEqual(['/who']);
    expect(commandHints('/thread RQ').map(hint => hint.usage)).toEqual(['/thread <session>']);
    expect(completeCommand('/t')).toBe('/thread ');
    expect(completeCommand('/su')).toBe('/summary ');
    expect(completeCommand('/l')).toBe('/log ');
    // /s still completes to the command it always did.
    expect(completeCommand('/s')).toBe('/stop ');
    expect(helpLine()).toContain('/who · /thread <session> · /summary <session> · /log <job-id>');
  });

  it('reads the session a typed or picked name means', () => {
    expect(sessionArg('RQ-A')).toBe('RQ-A');
    expect(sessionArg('@RQ-A')).toBe('RQ-A');
    expect(sessionArg(' leader ')).toBe('leader');
    expect(sessionArg('RQ-A RQ-B')).toBeNull();
    expect(sessionArg('')).toBeNull();
    expect(sessionArg('x'.repeat(161))).toBeNull();
  });

  it('asks for a missing or malformed name', () => {
    expect(commandArgError({ name: 'thread', arg: '' })).toBe('/thread needs a session: /thread <session>');
    expect(commandArgError({ name: 'thread', arg: 'RQ-A and RQ-B' })).toBe('/thread takes one session id: /thread <session>');
    expect(commandArgError({ name: 'summary', arg: 'two words' })).toBe('/summary takes one session id: /summary <session>');
    expect(commandArgError({ name: 'log', arg: 'a b' })).toBe('/log takes one job id: /log <job-id>');
    expect(commandArgError({ name: 'log', arg: 'x' })).toBe('/log takes one job id: /log <job-id>');
    for (const command of [{ name: 'who', arg: '' }, { name: 'thread', arg: '@RQ-A' }, { name: 'summary', arg: 'helper-a' }, { name: 'log', arg: '@RQ-A' }] as const) {
      expect(commandArgError(command)).toBeNull();
    }
  });

  it('needs no token and no confirm: they only read', () => {
    for (const name of ['who', 'thread', 'summary', 'log'] as const) {
      expect(isSessionCommand(name)).toBe(true);
      expect(commandGate({ name, arg: 'RQ-A' })).toBeNull();
    }
    expect(isSessionCommand('stop')).toBe(false);
  });
});

describe('/who', () => {
  it('lists the working sessions, quiet ones first, and never the ended one', () => {
    const line = whoLine(assistSessions());
    expect(line).toBe('4 working now · 1 quiet: RQ-QUIET (claude, quiet 14m) · RQ-A (claude, spoke 2m ago) · helper-a (claude, last spoke unknown) · RQ-CODEX (codex-local, spoke 2m ago). /thread <session> opens one.');
    expect(line).not.toContain('RQ-FAILED');
  });

  it('says so when nobody is working', async () => {
    expect(whoLine(noSessions())).toBe('No agents are working right now.');
    expect(await runSessionCommand({ name: 'who', arg: '' }, deps({ sessions: vi.fn(async () => noSessions()) }))).toBe('No agents are working right now.');
  });

  it('counts the sessions past the limit instead of dropping them', () => {
    const list = assistSessions();
    const first = list.tree.roots.flatMap(root => [root, ...root.children]).find(node => node.jobId === 'RQ-A')!;
    const parent = list.tree.roots.find(root => root.children.includes(first)) ?? null;
    const extra = Array.from({ length: WHO_LIMIT }, (_, index) => ({ ...first, id: `RQ-EXTRA-${index}`, jobId: `RQ-EXTRA-${index}`, children: [] }));
    if (parent) parent.children.push(...extra); else list.tree.roots.push(...extra);
    const line = whoLine(list);
    expect(line).toMatch(/^12 working now · 1 quiet: RQ-QUIET /);
    expect(line).toMatch(/ · and 4 more in Conversations\. \/thread <session> opens one\.$/);
    expect(line.match(/ \((?:claude|codex-local), /g)).toHaveLength(WHO_LIMIT);
  });

  it('reads unknown, with the reason, when the list does not answer', async () => {
    expect(await runSessionCommand({ name: 'who', arg: '' }, deps({ sessions: vi.fn(async () => null) })))
      .toBe('Working sessions are unknown: this server did not return a session list.');
    expect(await runSessionCommand({ name: 'who', arg: '' }, deps({ sessions: vi.fn(async () => { throw new ApiError('GET failed', 503, '/x', 'The runs directory could not be read.'); }) })))
      .toBe('Working sessions are unknown. The runs directory could not be read.');
    expect(await runSessionCommand({ name: 'who', arg: '' }, deps({ sessions: vi.fn(async () => { throw new TypeError('fetch failed'); }) })))
      .toBe('Working sessions are unknown. The server did not answer.');
  });
});

describe('/thread', () => {
  it('opens the named session as a conversation and says what it is', async () => {
    const d = deps();
    expect(await runSessionCommand({ name: 'thread', arg: '@RQ-A' }, d)).toBe('Opened the conversation with RQ-A (running, claude).');
    expect(d.openConversation).toHaveBeenCalledExactlyOnceWith(namedSession(assistSessions(), 'RQ-A')!.id);
    expect(d.thread).not.toHaveBeenCalled();
  });

  it('opens a helper and an ended session by their own ids', async () => {
    const d = deps();
    expect(await runSessionCommand({ name: 'thread', arg: 'helper-a' }, d)).toBe('Opened the conversation with helper-a (running, claude).');
    expect(await runSessionCommand({ name: 'thread', arg: 'RQ-FAILED' }, d)).toBe('Opened the conversation with RQ-FAILED (failed, claude).');
    expect(d.openConversation).toHaveBeenNthCalledWith(1, 'helper-a');
    expect(d.openConversation).toHaveBeenNthCalledWith(2, namedSession(assistSessions(), 'RQ-FAILED')!.id);
    expect(d.openConversation).toHaveBeenCalledTimes(2);
  });

  it('opens nothing for a name the list does not hold', async () => {
    const d = deps();
    expect(await runSessionCommand({ name: 'thread', arg: 'RQ-NOPE' }, d))
      .toBe('No session named RQ-NOPE is in the session list, so nothing was opened. /who lists the ones working now.');
    expect(d.openConversation).not.toHaveBeenCalled();
  });

  it('opens unchecked, and says so, when the list does not answer', async () => {
    for (const sessions of [vi.fn(async () => null), vi.fn(async () => { throw new TypeError('fetch failed'); })]) {
      const d = deps({ sessions });
      expect(await runSessionCommand({ name: 'thread', arg: 'RQ-A' }, d)).toBe('Opened RQ-A in Conversations. The session list did not answer, so the name is unchecked.');
      expect(d.openConversation).toHaveBeenCalledExactlyOnceWith('RQ-A');
    }
  });

  it('says so when the conversation opened in the Leader pane itself', async () => {
    const here = deps({ openConversation: vi.fn(() => 'leader' as const) });
    expect(await runSessionCommand({ name: 'thread', arg: 'RQ-A' }, here)).toBe('Opened the conversation with RQ-A (running, claude). Esc in it comes back here.');
    const unchecked = deps({ openConversation: vi.fn(() => 'leader' as const), sessions: vi.fn(async () => null) });
    expect(await runSessionCommand({ name: 'thread', arg: 'RQ-A' }, unchecked)).toBe('Opened RQ-A here. The session list did not answer, so the name is unchecked.');
  });
});

describe('/summary', () => {
  it('prints the state, lane, model, last spoke and the recorded summary', async () => {
    const d = deps();
    expect(await runSessionCommand({ name: 'summary', arg: '@RQ-A' }, d))
      .toBe('RQ-A: running, claude, fixture-model, last spoke 2m ago. Running for 30 minutes on claude. It last said: Running the tests.');
    expect(d.thread).toHaveBeenCalledExactlyOnceWith('RQ-A');
    expect(d.openConversation).not.toHaveBeenCalled();
  });

  it('keeps unknown readings as words and never invents a summary', () => {
    expect(summaryLine('RQ-B', thread({ summary: [] }, { state: 'unknown', lane: 'unknown', model: 'unknown', lastMessageAgeSeconds: null })))
      .toBe('RQ-B: state unknown, lane unknown, last spoke unknown. No summary is recorded for it.');
  });

  it('counts the lines it leaves out and points at the conversation', () => {
    const summary = Array.from({ length: SUMMARY_LINES + 2 }, (_, index) => `Line ${index + 1}.`);
    expect(summaryLine('RQ-A', thread({ summary }))).toMatch(/Line 6\. \(2 more lines: \/thread RQ-A\)$/);
    expect(summaryLine('RQ-A', thread({ summary: summary.slice(0, SUMMARY_LINES + 1) }))).toMatch(/\(1 more line: \/thread RQ-A\)$/);
  });

  it('gives the reason when the conversation cannot be read', async () => {
    const failing = (error: unknown) => deps({ thread: vi.fn(async () => { throw error; }) });
    expect(await runSessionCommand({ name: 'summary', arg: 'RQ-GONE' }, failing(new ApiError('GET failed', 404, '/x', 'No session RQ-GONE in the live list.'))))
      .toBe('No session RQ-GONE in the live list.');
    expect(await runSessionCommand({ name: 'summary', arg: 'RQ-A' }, failing(new ApiError('GET failed', 404, '/x'))))
      .toMatch(/^This Phantom server cannot read a session as a conversation yet\./);
    expect(await runSessionCommand({ name: 'summary', arg: 'RQ-A' }, failing(new ApiError('GET failed', 503, '/x'))))
      .toBe('What RQ-A is doing is unknown. The session list could not be read just now.');
    expect(await runSessionCommand({ name: 'summary', arg: 'RQ-A' }, failing(new TypeError('fetch failed'))))
      .toBe('What RQ-A is doing is unknown. The server did not answer.');
    expect(await runSessionCommand({ name: 'summary', arg: 'RQ-A' }, deps({ thread: vi.fn(async () => null) })))
      .toBe('What RQ-A is doing is unknown: this server did not return its conversation.');
  });
});

describe('/log and the composer runner', () => {
  it('opens the job log', async () => {
    const d = deps();
    expect(await runSessionCommand({ name: 'log', arg: '@RQ-A' }, d)).toBe('Opened the live log for RQ-A.');
    expect(d.openLog).toHaveBeenCalledExactlyOnceWith('RQ-A');
    expect(d.sessions).not.toHaveBeenCalled();
  });

  it('runs through the composer runner with no inbox note and no fleet action', async () => {
    const session = deps();
    const postNote = vi.fn(async () => {});
    const openPane = vi.fn();
    const all = { ...liveComposerDeps, postNote, openPane, session };
    expect(await runComposerCommand({ name: 'thread', arg: 'RQ-QUIET' }, all)).toBe('Opened the conversation with RQ-QUIET (running, claude).');
    expect(await runComposerCommand({ name: 'who', arg: '' }, all)).toContain('working now');
    expect(await runComposerCommand({ name: 'thread', arg: '' }, all)).toBe('/thread needs a session: /thread <session>');
    expect(await runComposerCommand({ name: 'log', arg: 'not a job' }, all)).toBe('/log takes one job id: /log <job-id>');
    expect(session.openConversation).toHaveBeenCalledTimes(1);
    expect(session.openLog).not.toHaveBeenCalled();
    expect(postNote).not.toHaveBeenCalled();
    expect(openPane).not.toHaveBeenCalled();
  });
});
