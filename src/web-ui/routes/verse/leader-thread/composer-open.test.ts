import { describe, expect, it, vi } from 'vitest';
import { commandHints, completeCommand, parseComposerDraft } from './composer-commands.js';
import { commandGate, liveComposerDeps, runComposerCommand } from './composer-command-run.js';

describe('/open', () => {
  it('parses, suggests and completes the command', () => {
    expect(parseComposerDraft('/open fleet-lanes')).toEqual({ kind: 'command', name: 'open', arg: 'fleet-lanes' });
    expect(commandHints('/op').map(item => item.name)).toContain('open');
    expect(completeCommand('/op')).toBe('/open ');
  });

  it('opens a normalized pane locally without an inbox note', async () => {
    const openPane = vi.fn();
    const postNote = vi.fn();
    const deps = { ...liveComposerDeps, openPane, postNote };
    expect(commandGate({ name: 'open', arg: 'fleet-lanes' })).toBeNull();
    expect(await runComposerCommand({ name: 'open', arg: 'fleet-lanes' }, deps)).toBe('Opened fleet-lanes.');
    expect(openPane).toHaveBeenCalledExactlyOnceWith('fleet-lanes');
    expect(postNote).not.toHaveBeenCalled();
    expect(await runComposerCommand({ name: 'open', arg: 'preview' }, deps)).toBe('Opened browser.');
    expect(openPane).toHaveBeenLastCalledWith('browser');
  });

  it('rejects missing and malformed pane IDs', async () => {
    const openPane = vi.fn();
    const postNote = vi.fn();
    const deps = { ...liveComposerDeps, openPane, postNote };
    expect(await runComposerCommand({ name: 'open', arg: 'not a pane' }, deps)).toBe('Unknown pane "not a pane". Try /open fleet-lanes.');
    expect(await runComposerCommand({ name: 'open', arg: '' }, deps)).toBe('/open needs a pane: /open <pane>');
    expect(openPane).not.toHaveBeenCalled();
    expect(postNote).not.toHaveBeenCalled();
  });
});
