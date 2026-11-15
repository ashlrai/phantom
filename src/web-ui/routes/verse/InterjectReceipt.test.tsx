import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { buildInterjectReceipt, type InterjectSend } from './interject-receipt.js';
import { InterjectReceipt } from './InterjectReceipt.js';
import { agentBusPageQuery } from './fleet-bus/agent-bus-queries.js';
import type { AgentBusReceipt } from './fleet-bus/agent-bus-queries.js';

const T0 = Date.UTC(2026, 10, 12, 22, 31);
const sent: InterjectSend = { phase: 'sent', text: 'ship it', sentAtMs: T0 };
const busId = 'mason-desktop-0123456789abcdef';
const row = (cursor: number, id: string, from: string, body: unknown, receivedAt = T0 + cursor * 1000): AgentBusReceipt =>
  ({ cursor, receivedAt, envelope: { id, from, to: 'leaders', priority: 'P0', ttl: 1000, body } });
const mirror = row(1, busId, 'mason', { kind: 'interjection', channel: 'desktop', text: 'ship it' });

afterEach(() => vi.unstubAllGlobals());

it('is received after a successful send, with the bus id once mirrored', () => {
  const early = buildInterjectReceipt(sent, [], T0);
  expect(early).toMatchObject({ state: 'received', inboxWritten: true });
  expect(early.busEventId).toBeUndefined();
  expect(early.text).toMatch(/^received \d\d:\d\d · inbox line written · awaiting bus event$/);
  const r = buildInterjectReceipt(sent, [mirror], T0);
  expect(r).toMatchObject({ state: 'received', busEventId: busId });
  expect(r.text).toMatch(/^received \d\d:\d\d · inbox line written · bus event 89abcdef$/);
});

it('is acknowledged when a correlated bus event arrives', () => {
  const reply = row(2, 'codex-reply-1', 'codex-local', { inReplyTo: busId, text: 'on it' });
  const r = buildInterjectReceipt(sent, [mirror, reply], T0);
  expect(r).toMatchObject({ state: 'acknowledged', ackBy: 'codex-local', busEventId: busId });
  expect(r.text).toMatch(/ · acknowledged by codex-local \d\d:\d\d$/);
  expect(buildInterjectReceipt(sent, [mirror, row(2, 'c2', 'claude', { in_reply_to: busId })], T0).state).toBe('acknowledged');
});

it('does not acknowledge from an uncorrelated event', () => {
  const other = row(2, 'x', 'codex-local', { inReplyTo: 'mason-desktop-other', text: 'hi' });
  const plain = row(3, 'y', 'claude', { text: 'ship it' });
  expect(buildInterjectReceipt(sent, [mirror, other, plain], T0).state).toBe('received');
});

it('a failed send stays failed, never received', () => {
  const r = buildInterjectReceipt({ phase: 'failed', text: 'ship it', sentAtMs: T0 }, [mirror], T0);
  expect(r).toMatchObject({ state: 'failed', inboxWritten: false });
  expect(r.text).not.toMatch(/received/);
  expect(buildInterjectReceipt({ phase: 'sending', text: 'ship it', sentAtMs: T0 }, [mirror], T0).state).toBe('sending');
});

it('ignores a mirror of the same text from before the send', () => {
  const old = row(1, 'old', 'mason', { kind: 'interjection', text: 'ship it' }, T0 - 3_600_000);
  expect(buildInterjectReceipt(sent, [old], T0).busEventId).toBeUndefined();
});

it('renders and updates from the shared bus page without its own polling', async () => {
  const page = (messages: AgentBusReceipt[]) => ({ v: 1, status: 'ok', messages, nextCursor: messages.length });
  const now = Date.now();
  const s: InterjectSend = { phase: 'sent', text: 'ship it', sentAtMs: now };
  const rows = [row(1, busId, 'mason', { kind: 'interjection', text: 'ship it' }, now)];
  let body = page(rows);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)));
  render(<InterjectReceipt send={s} />);
  expect(screen.getByTestId('interject-receipt')).toHaveAttribute('data-state', 'received');
  await act(async () => { await agentBusPageQuery(0).fetch(); });
  expect(screen.getByTestId('interject-receipt')).toHaveTextContent('bus event 89abcdef');
  body = page([...rows, row(2, 'r', 'codex-local', { inReplyTo: busId }, now + 1000)]);
  await act(async () => { await agentBusPageQuery(1).fetch(); });
  expect(screen.getByTestId('interject-receipt')).toHaveAttribute('data-state', 'acknowledged');
});
