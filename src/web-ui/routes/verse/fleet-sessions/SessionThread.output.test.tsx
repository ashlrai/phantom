/**
 * What a session wrote, in its conversation: the `output` message of
 * fleet.session-thread.v1 (the newest lines of the session's log) is drawn as
 * one block the stylesheet reads like a terminal, and the line under the
 * conversation says whether the log was read.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { SessionThreadView } from './SessionThread.js';
import { narrowSessionThread, sourcesLine } from './session-thread-model.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const OUTPUT = { key: 'output', kind: 'output', side: 'session', label: 'Output, last 3 lines of its log', at: null, text: 'npx vitest run\n  12 files passed\nwriting the summary', format: 'mono' };

function wire(over: Record<string, unknown> = {}, session: Record<string, unknown> = {}) {
  return {
    schema: 'fleet.session-thread.v1', generatedAt: ago(0), id: 'RQ-A',
    session: { id: 'RQ-A', kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom', jobId: 'RQ-A', parentId: 'leader',
      state: 'running', startedAt: ago(30), ageSeconds: 1800, lastMessageAt: ago(1), lastMessageAgeSeconds: 60, prUrl: null, computer: 'node-here',
      helpers: { below: 0, running: 0, failed: 0 }, ...session },
    summary: ['Worker on claude, fixture-model, in phantom.'],
    messages: [{ key: 'brief', kind: 'brief', side: 'other', label: 'Brief', at: null, text: 'Fix the flaky test.', format: 'markdown' }, OUTPUT],
    sources: { sessions: 'available', activity: 'available', bus: 'none', owner: 'none', replies: 'none', orders: 'none', output: 'available' },
    gaps: [], ...over,
  };
}
const thread = (over?: Record<string, unknown>, session?: Record<string, unknown>) => narrowSessionThread(wire(over, session))!;

afterEach(cleanup);

describe('what a session wrote, in its conversation', () => {
  it('draws the output as one block on the session side, lines kept as written', () => {
    render(<SessionThreadView thread={thread()} sent={[]} onSent={() => {}} />);
    const log = screen.getByRole('list', { name: 'Conversation with RQ-A' });
    const block = log.querySelector('li[data-kind="output"]')!;
    expect(block.getAttribute('data-side')).toBe('session');
    expect(within(block as HTMLElement).getByText('Output, last 3 lines of its log')).toBeTruthy();
    const pre = block.querySelector('pre')!;
    expect(pre.textContent).toBe('npx vitest run\n  12 files passed\nwriting the summary');
    // It is the last thing said, after the brief.
    expect([...log.querySelectorAll('li[data-kind]')].map(item => item.getAttribute('data-kind'))).toEqual(['brief', 'output']);
  });

  it('says under the conversation whether the log was read', () => {
    expect(sourcesLine(thread())).toBe('Activity shown · output shown · bus messages none recorded · your messages none recorded · routing none recorded');
    expect(sourcesLine(thread({ messages: [], sources: { activity: 'none', bus: 'none', owner: 'none', replies: 'none', orders: 'none', output: 'none' } })))
      .toBe('Activity none recorded · output none recorded · bus messages none recorded · your messages none recorded · routing none recorded');
    expect(sourcesLine(thread({ sources: { activity: 'available', bus: 'none', owner: 'none', replies: 'none', orders: 'none', output: 'unavailable' } }))).toContain('output unknown');
    expect(sourcesLine(thread({ sources: { activity: 'available', bus: 'none', owner: 'none', replies: 'none', orders: 'none', output: 'sideways' } }))).toContain('output unknown');
  });

  it('leaves the output out of that line for a server that does not read it, and for a session with no job', () => {
    const older = thread({ sources: { activity: 'available', bus: 'none', owner: 'none', replies: 'none', orders: 'none' } });
    expect(older.sources.output).toBeUndefined();
    expect(sourcesLine(older)).toBe('Activity shown · bus messages none recorded · your messages none recorded · routing none recorded');
    expect(sourcesLine(thread({}, { kind: 'subagent', jobId: null }))).toBe('Activity shown · bus messages none recorded · routing none recorded');
    expect(sourcesLine(thread({}, { kind: 'leader', jobId: null }))).not.toContain('output');
  });
});
