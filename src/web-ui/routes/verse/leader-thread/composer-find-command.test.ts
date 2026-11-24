import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../data/client.js';
import type { FoundSession, SessionFindRead } from '../session-wall/wall-find.js';
import { commandArgError, commandHints, parseComposerDraft } from './composer-commands.js';
import { liveComposerDeps, runComposerCommand } from './composer-command-run.js';
import { FIND_QUOTE_CHARS, FIND_ROWS, findAnswer, foundRow, quoteAround, runFindCommand } from './composer-find-command.js';

const result = (id: string, over: Partial<FoundSession> = {}): FoundSession => ({
  id, kind: 'worker', lane: 'claude', repo: 'phantom', state: 'running', summary: `${id} is a worker on claude.`, hits: [], hitCount: 0, messageCount: 9, ...over,
});
const read = (results: FoundSession[], over: Partial<SessionFindRead> = {}): SessionFindRead => ({
  generatedAt: '2026-11-20T12:00:00.000Z', words: ['suite'], searched: 41, sessions: 41, results, gaps: [], ...over,
});
const said = (id: string, text: string) => ({ key: `latest:${id}`, side: 'session' as const, label: id, at: null, text });

describe('/find in the command list', () => {
  it('is a command with its words as the argument, hinted while typing', () => {
    expect(parseComposerDraft('/find merge  queue')).toEqual({ kind: 'command', name: 'find', arg: 'merge  queue' });
    expect(commandHints('/fi').map(hint => hint.usage)).toEqual(['/find <words>']);
  });

  it('asks for words, and for words of two letters or more', () => {
    expect(commandArgError({ name: 'find', arg: '' })).toBe('/find needs a word or two: /find <words>');
    expect(commandArgError({ name: 'find', arg: 'a b' })).toBe('/find looks for words of two letters or more: /find <words>');
    expect(commandArgError({ name: 'find', arg: 'a suite' })).toBeNull();
  });
});

describe('quoteAround', () => {
  it('keeps a short line whole and flattens its line breaks', () => {
    expect(quoteAround('Running the\n  web suite now.', ['suite'])).toBe('Running the web suite now.');
  });

  it('cuts a long line around the first word found, marking each cut', () => {
    const long = `${'before '.repeat(40)}the suite failed ${'after '.repeat(40)}`;
    const quote = quoteAround(long, ['suite']);
    expect(quote).toMatch(/^….*the suite failed.*…$/);
    expect(quote.length).toBeLessThanOrEqual(FIND_QUOTE_CHARS + 2);
    // A word at the very start is not cut before.
    expect(quoteAround(`suite ${'after '.repeat(40)}`, ['suite'])).toMatch(/^suite after.*…$/);
    // A line the words are not in (found in a part the excerpt lost) starts from its beginning.
    expect(quoteAround('x'.repeat(300), ['suite'])).toBe(`${'x'.repeat(FIND_QUOTE_CHARS)}…`);
  });
});

describe('the answer', () => {
  it('quotes the newest line that holds a word, and says who wrote it when it was not the session', () => {
    const both = result('RQ-A', { hitCount: 7, hits: [
      { key: 'owner:1', side: 'other', label: 'Mason', at: null, text: '@RQ-A run the web Suite before you push' }, said('RQ-A', 'Running the web suite now.')] });
    expect(foundRow(both, ['suite'])).toBe('RQ-A (running · 7 of 9 messages) said: “Running the web suite now.”');
    const told = result('RQ-B', { hitCount: 1, hits: [{ key: 'owner:2', side: 'other', label: 'Mason', at: '2026-11-20T12:00:00.000Z', text: 'run the suite' }] });
    expect(foundRow(told, ['suite'])).toMatch(/^RQ-B \(running · 1 of 9 messages\) Mason at \d{1,2}:\d{2}.*: “run the suite”$/);
  });

  it('falls back to the summary when the words are only in the facts, and to the bare row when there is none', () => {
    expect(foundRow(result('RQ-Z', { state: 'failed', summary: 'RQ-Z failed in the suite step.' }), ['suite'])).toBe('RQ-Z (failed · in its facts or summary) RQ-Z failed in the suite step.');
    expect(foundRow(result('RQ-Z', { summary: '' }), ['suite'])).toBe('RQ-Z (running · in its facts or summary)');
  });

  it('is a headline and a row a session; the ones past the limit are counted, and what was not searched is said', () => {
    const many = Array.from({ length: FIND_ROWS + 2 }, (_, at) => result(`RQ-${at}`, { hitCount: 1, hits: [said(`RQ-${at}`, 'the suite')] }));
    const lines = findAnswer(read(many, { gaps: ['The owner thread could not be read.', 'Orders unreadable.'] })).split('\n');
    expect(lines[0]).toBe(`${FIND_ROWS + 2} of 41 searched sessions hold “suite” somewhere in the whole conversation:`);
    expect(lines.slice(1, FIND_ROWS + 1).map(line => line.split(' ')[0])).toEqual(many.slice(0, FIND_ROWS).map(one => one.id));
    expect(lines.slice(FIND_ROWS + 1)).toEqual([
      'And 2 more sessions: the find box in Conversations lists them all.',
      'Not searched: The owner thread could not be read. (and 1 more)',
    ]);
  });

  it('says so in one line when nothing holds the words, and how to open a session that is not a job', () => {
    expect(findAnswer(read([]))).toBe('No whole conversation holds “suite”: 41 searched.');
    expect(findAnswer(read([result('leader', { kind: 'leader' })])).split('\n').at(-1)).toBe('/thread <session> opens one that is not a job.');
  });
});

describe('running /find', () => {
  it('searches for the words the server accepts and posts nothing', async () => {
    const find = vi.fn(async () => read([result('RQ-A', { hitCount: 1, hits: [said('RQ-A', 'the suite')] })]));
    const postNote = vi.fn(async () => {});
    const line = await runComposerCommand({ name: 'find', arg: 'Suite a  SUITE' }, { ...liveComposerDeps, postNote, find: { find } });
    expect(find).toHaveBeenCalledWith('suite');
    expect(line.split('\n')).toEqual(['1 of 41 searched sessions holds “suite” somewhere in the whole conversation:', 'RQ-A (running · 1 of 9 messages) said: “the suite”']);
    expect(postNote).not.toHaveBeenCalled();
  });

  it('never throws: an answer of another shape, a server without the read and a failed read each say unknown', async () => {
    expect(await runFindCommand('suite', { find: async () => null })).toBe('Whether any conversation holds “suite” is unknown: the server answered with something that is not a search result.');
    expect(await runFindCommand('suite', { find: async () => { throw new ApiError('No such route.', 404, '/find'); } }))
      .toBe('Whether any conversation holds “suite” is unknown: this Phantom server cannot search whole conversations yet. Update Phantom.');
    expect(await runFindCommand('suite', { find: async () => { throw new ApiError('Unavailable.', 503, '/find'); } }))
      .toBe('Whole conversations could not be searched: the session list could not be read just now.');
  });
});
