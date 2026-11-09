import { describe, expect, it } from 'vitest';
import { commandArgError, commandHints, completeCommand, helpLine, parseComposerDraft } from './composer-commands.js';

describe('parseComposerDraft', () => {
  it('reads a known command and its argument', () => {
    expect(parseComposerDraft('/release codex-personal')).toEqual({ kind: 'command', name: 'release', arg: 'codex-personal' });
    expect(parseComposerDraft('/pause')).toEqual({ kind: 'command', name: 'pause', arg: '' });
    expect(parseComposerDraft('/drop fix the flaky\nhelp test ')).toEqual({ kind: 'command', name: 'drop', arg: 'fix the flaky\nhelp test' });
  });

  it('tolerates leading spaces and any case in the name', () => {
    expect(parseComposerDraft('   /PAUSE')).toEqual({ kind: 'command', name: 'pause', arg: '' });
    expect(parseComposerDraft(' /Stop RQ-PHX-ONE')).toEqual({ kind: 'command', name: 'stop', arg: 'RQ-PHX-ONE' });
  });

  it('leaves unknown commands and ordinary text as messages', () => {
    for (const draft of ['/unknown thing', 'hello /pause', '/pauses', '/', 'pause', '//pause', '/pause/now']) {
      expect(parseComposerDraft(draft)).toEqual({ kind: 'message' });
    }
  });
});

describe('commandArgError', () => {
  it('asks for a missing argument', () => {
    expect(commandArgError({ name: 'release', arg: '' })).toBe('/release needs a lane: /release <lane>');
    expect(commandArgError({ name: 'stop', arg: '' })).toBe('/stop needs a job-id: /stop <job-id>');
    expect(commandArgError({ name: 'drop', arg: '' })).toBe('/drop needs a text: /drop <text>');
  });

  it('rejects a malformed lane or job id and accepts good ones', () => {
    expect(commandArgError({ name: 'release', arg: 'Codex Personal' })).toMatch(/valid lane name/);
    expect(commandArgError({ name: 'stop', arg: 'RQ-ONE RQ-TWO' })).toMatch(/one job id/);
    expect(commandArgError({ name: 'release', arg: 'codex-personal' })).toBeNull();
    expect(commandArgError({ name: 'stop', arg: 'RQ-PHX-ONE' })).toBeNull();
    expect(commandArgError({ name: 'pause', arg: '' })).toBeNull();
  });
});

describe('hints and completion', () => {
  it('shows hints only while the draft starts with "/"', () => {
    expect(commandHints('hello')).toEqual([]);
    expect(commandHints('/').map(hint => hint.name)).toEqual(['pause', 'resume', 'release', 'stop', 'drop', 'help']);
    expect(commandHints('/re').map(hint => hint.name)).toEqual(['resume', 'release']);
    expect(commandHints(' /REL').map(hint => hint.name)).toEqual(['release']);
    expect(commandHints('/release cod').map(hint => hint.name)).toEqual(['release']);
    expect(commandHints('/zzz')).toEqual([]);
  });

  it('completes to the first match, with a space when an argument follows', () => {
    expect(completeCommand('/p')).toBe('/pause');
    expect(completeCommand('/rel')).toBe('/release ');
    expect(completeCommand('/pause')).toBeNull();
    expect(completeCommand('/release codex')).toBeNull();
    expect(completeCommand('/zzz')).toBeNull();
    expect(completeCommand('hi')).toBeNull();
  });

  it('lists every command in the help line', () => {
    expect(helpLine()).toContain('/release <lane>');
    expect(helpLine()).toContain('/stop <job-id>');
  });
});
