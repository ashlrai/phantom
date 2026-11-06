import { describe, expect, it } from 'vitest';
import { matchSlashCommands, parsePaneCommand } from './composer-text.js';

const panes = [
  { id: 'fleet-inbox', title: 'Inbox' },
  { id: 'fleet-lanes', title: 'Lanes' },
  { id: 'fleet-merges', title: 'Merges' },
  { id: 'insights', title: 'Insights' },
];

describe('pane command parsing', () => {
  it('gives an exact id priority over ambiguous prefixes', () => {
    const withInbox = [...panes, { id: 'inbox', title: 'Other inbox' }];
    expect(parsePaneCommand('/pane INBOX', withInbox)).toEqual({ id: 'inbox', title: 'Other inbox' });
    expect(parsePaneCommand('/pane fleet-inbox', panes)).toEqual(panes[0]);
  });

  it('matches case-insensitive id and title prefixes, ignoring fleet-', () => {
    expect(parsePaneCommand('/pane INB', panes)).toEqual(panes[0]);
    expect(parsePaneCommand('/pane fleet-LAN', panes)).toEqual(panes[1]);
    expect(parsePaneCommand('/pane mer', panes)).toEqual(panes[2]);
    expect(parsePaneCommand('/pane change', [{ id: 'diff', title: 'Changes' }])).toEqual({ id: 'diff', title: 'Changes' });
  });

  it('lists at most eight ambiguous matches', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: `fleet-item-${i}`, title: `Item ${i}` }));
    expect(parsePaneCommand('/pane i', panes)).toEqual({ error: 'Ambiguous pane: Inbox, Insights' });
    expect(parsePaneCommand('/pane item', many)).toEqual({ error: `Ambiguous pane: ${many.slice(0, 8).map(pane => pane.title).join(', ')}` });
  });

  it('reports missing and unknown names without consuming other commands', () => {
    expect(parsePaneCommand('/pane', panes)).toEqual({ error: 'Use /pane <name> to open a dock pane.' });
    expect(parsePaneCommand('/pane nowhere', panes)).toEqual({ error: 'No pane named nowhere' });
    expect(parsePaneCommand('/pane fleet-', panes)).toEqual({ error: 'No pane named fleet-' });
    expect(parsePaneCommand('/panes inbox', panes)).toBeNull();
    expect(parsePaneCommand('hello /pane inbox', panes)).toBeNull();
  });

  it('offers pane in autocomplete', () => {
    expect(matchSlashCommands('pa').map(command => command.id)).toContain('pane');
  });
});
