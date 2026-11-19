import { describe, expect, it } from 'vitest';
import { parseDeepLink } from '../../routes/verse/shell/deep-link.js';
import type { AgentBusPage, AgentBusReceipt } from '../../routes/verse/fleet-bus/agent-bus-queries.js';
import { deriveBusReplyNotifications as derive } from './deriveBusReplyNotifications.js';

const now = Date.parse('2026-11-18T12:00:00Z');
const feed = (id: string, body: Record<string, unknown>): AgentBusReceipt => ({ cursor: 1, receivedAt: now - 1000,
  envelope: { id, from: 'apps-control', to: 'mason', priority: 'P3', ttl: 604_800_000, body: { kind: 'apps-control', ...body } } });
const page = (...messages: AgentBusReceipt[]): AgentBusPage => ({ v: 1, status: 'ok', messages, nextCursor: 1 });

describe('app actions in bus notifications', () => {
  it('stays silent for a start, a clean result and a list', () => {
    expect(derive(page(
      feed('a', { phase: 'start', action: 'quit', app: 'Safari' }),
      feed('b', { phase: 'result', action: 'quit', app: 'Safari', outcome: 'done', detail: 'quit.' }),
      feed('c', { phase: 'result', action: 'list', app: '*', outcome: 'done', detail: '3 allowed' }),
    ), now)).toEqual([]);
  });

  it('says in plain words what did not happen, and opens the Leader thread', () => {
    const [waiting, refused, unknown] = derive(page(
      feed('w', { phase: 'result', action: 'open', app: 'Figma', outcome: 'needs-you', detail: 'App-level action requested for review. Sent to needs-you.' }),
      feed('r', { phase: 'result', action: 'quit', app: 'Slack', outcome: 'refused', detail: 'that app is never available to agents.' }),
      feed('u', { phase: 'result', action: 'restart', app: 'Cursor', outcome: 'unknown', detail: 'x'.repeat(200) }),
    ), now);
    expect(waiting).toMatchObject({ id: 'app-action:w', severity: 'high', title: 'Open Figma: waiting for you',
      detail: 'App-level action requested for review. Sent to needs-you.', actionLabel: 'Open Leader' });
    expect(refused).toMatchObject({ id: 'app-action:r', severity: 'low', title: 'Quit Slack: refused', detail: 'that app is never available to agents.' });
    expect(unknown).toMatchObject({ title: 'Restart Cursor: result unknown', severity: 'low' });
    expect(unknown!.detail).toHaveLength(140);
    expect(parseDeepLink(new URL(waiting!.actionHref!).search)).toEqual({ paneId: 'leader-thread', sessionId: null });
    expect(JSON.stringify([waiting, refused, unknown])).not.toContain('apps-control');
  });

  it('leaves another sender using the same kind as an ordinary bus reply', () => {
    const other = feed('o', { phase: 'result', action: 'quit', app: 'Slack', outcome: 'refused' });
    const [row] = derive(page({ ...other, envelope: { ...other.envelope, from: 'codex-worker' } }), now);
    expect(row).toMatchObject({ id: 'bus-reply:o', title: 'codex-worker replied on the bus' });
  });
});
