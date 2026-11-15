import { describe, expect, it } from 'vitest';
import { peerEnvelopeSummary } from '../src/web-ui/routes/verse/fleet-bus/peer-envelope.js';
import { envelopeRows } from '../src/web-ui/routes/verse/fleet-bus/agent-bus-model.js';
import type { AgentBusReceipt } from '../src/web-ui/routes/verse/fleet-bus/agent-bus-queries.js';
import { busFeedItems } from '../src/web-ui/routes/verse/fleet-events/bus-feed-items.js';

const peer = { fromAgent: 'agent0', toAgent: 'agent1', kind: 'review', text: 'Please review the patch.', hopCount: 2 };
const message = { kind: 'peer.message', peer };
const label = 'agent0 → agent1 · review · hop 2/8';
const receipt = (body: unknown): AgentBusReceipt => ({ cursor: 1, receivedAt: 1000,
  envelope: { id: 'fake-peer', from: 'agent0', to: 'agent1', priority: 'P2', ttl: 5000, body } });
const feed = (body: unknown) => busFeedItems({ v: 1, status: 'ok', messages: [receipt(body)], nextCursor: 1 });

describe('peer envelope display', () => {
  it('summarizes directed and channel messages', () => {
    expect(peerEnvelopeSummary(message)).toEqual({ label, text: peer.text });
    const { toAgent: _toAgent, ...channelPeer } = peer;
    expect(peerEnvelopeSummary({ kind: 'peer.message', peer: { ...channelPeer, channel: 'CMESH' } }))
      .toEqual({ label: 'agent0 → #CMESH · review · hop 2/8', text: peer.text });
  });

  it('summarizes escalations and provisioning drafts', () => {
    expect(peerEnvelopeSummary({ kind: 'peer.escalation', origin: 'fake-origin', reason: 'loop-or-hop-cap' }))
      .toEqual({ label: 'peer loop/hop cap', text: 'origin fake-origin: loop-or-hop-cap' });
    expect(peerEnvelopeSummary({ kind: 'peer.draft', action: 'register', name: 'fake-agent' }))
      .toEqual({ label: 'agentnet draft', text: 'register: fake-agent (needs reviewed provisioning)' });
  });

  it.each([
    null, [], 'peer.message', { kind: 'other', text: 'ordinary' }, { kind: 'peer.message' },
    ...[
      { channel: 'CMESH' }, { hopCount: 9 }, { hopCount: 0 }, { hopCount: 1.5 }, { hopCount: '2' },
      { kind: 'exec' }, { text: 42 }, { fromAgent: 42 }, { toAgent: 42 },
    ].map(patch => ({ kind: 'peer.message', peer: { ...peer, ...patch } })),
    { kind: 'peer.escalation', origin: 42, reason: 'loop' },
    { kind: 'peer.escalation', origin: 'fake', reason: null },
    { kind: 'peer.draft', action: 42, name: 'fake' },
    { kind: 'peer.draft', action: 'register', name: false },
  ])('preserves fallback behavior for malformed or unrelated body %#', body => {
    expect(peerEnvelopeSummary(body)).toBeNull();
    const raw = body && typeof body === 'object' && 'text' in body && typeof body.text === 'string'
      ? body.text : JSON.stringify(body);
    expect(envelopeRows([receipt(body)], 1000)[0].excerpt).toBe(raw.slice(0, 200));
  });

  it('strips C0/C1 controls and bounds callsigns, channels and text', () => {
    const summary = peerEnvelopeSummary({ kind: 'peer.message', peer: { ...peer,
      fromAgent: `\u0000${'a'.repeat(80)}\u009f`, toAgent: `\u007f${'b'.repeat(80)}`,
      text: `\u001f${'x'.repeat(2000)}\u0080` } });
    expect(summary).toEqual({ label: `${'a'.repeat(64)} → ${'b'.repeat(64)} · review · hop 2/8`, text: 'x'.repeat(500) });
    expect(peerEnvelopeSummary({ kind: 'peer.message', peer: {
      fromAgent: 'agent0', channel: `\u0000${'C'.repeat(80)}`, kind: 'task', text: 'hi', hopCount: 8,
    } })?.label).toBe(`agent0 → #${'C'.repeat(64)} · task · hop 8/8`);
    expect(peerEnvelopeSummary({ kind: 'peer.escalation', origin: '\u0000fake', reason: '\u0080loop' })?.text)
      .toBe('origin fake: loop');
    expect(peerEnvelopeSummary({ kind: 'peer.draft', action: '\u0000register', name: '\u009ffake' })?.text)
      .toBe('register: fake (needs reviewed provisioning)');
  });

  it('renders readable receipts in both views and retains the feed transport prefix', () => {
    expect(envelopeRows([receipt(message)], 1000)[0]).toMatchObject({ kind: 'peer.message', excerpt: `${label} — ${peer.text}` });
    expect(feed(message)[0].text).toBe(`agent0 -> agent1 [P2] ${label} — ${peer.text}`);
    const long = { ...message, peer: { ...peer, text: 'x'.repeat(2000) } };
    expect(envelopeRows([receipt(long)], 1000)[0].excerpt).toBe(`${label} — ${'x'.repeat(500)}`.slice(0, 200));
    expect(feed(long)[0].text).toBe(`agent0 -> agent1 [P2] ${label} — ${'x'.repeat(500)}`);
  });
});
