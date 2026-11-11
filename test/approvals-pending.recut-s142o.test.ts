/**
 * test/approvals-pending.recut-s142o.test.ts — RQ-SWE-APPROVALS-1 recut
 * (source PR #3943): the inbox-proposal and outbound-draft sections added to
 * buildApprovalsProjection in src/core/approvals/surface.ts.
 *
 * Hermetic: proposals and drafts live only under the fixture's tmp HOME.
 * Proves, through the real module, that a pending proposal carries the exact
 * `approval-v1:` revision POST /api/inbox/:id/decision accepts (consent only,
 * never apply), that a proposal without a reviewable request degrades to
 * review-only, that drafts expose terminal commands but never their body, and
 * that every source reports honest state instead of a fake all-clear.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildApprovalsProjection,
  readPendingDrafts,
  readPendingProposals,
} from '../src/core/approvals/surface.js';
import { createProposal, inboxDir } from '../src/core/inbox/store.js';
import { approvalRequestForProposal } from '../src/core/inbox/pending-authority.js';
import { approveDraft, createDraft } from '../src/core/cos/drafts.js';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

const REVISION = /^approval-v1:[a-f0-9]{16}(?:\.[a-f0-9]{16}){3}$/;

let fx: H1Fixture;

beforeEach(() => {
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

function makeProposal(overrides: Parameters<typeof createProposal>[0] = {}) {
  return createProposal({
    repo: null,
    origin: 'manual',
    kind: 'note',
    title: 'Review this note',
    summary: 'Operator-facing summary',
    ...overrides,
  });
}

/** createProposal stamps createdAt itself; rewrite the stored row to control order. */
function backdate(id: string, createdAt: string) {
  const path = join(inboxDir(), `${id}.json`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { createdAt?: string };
  raw.createdAt = createdAt;
  writeFileSync(path, JSON.stringify(raw), { mode: 0o600 });
}

describe('readPendingProposals', () => {
  it('is an honest empty list on a fresh home', () => {
    expect(readPendingProposals()).toMatchObject({ state: 'ok', items: [], truncated: false });
  });

  it('binds each proposal to the exact approval-v1 revision the decision route accepts', () => {
    const p = makeProposal({ title: 'Add retry to the fetch wrapper' });
    const section = readPendingProposals();
    expect(section.state).toBe('ok');
    expect(section.items).toHaveLength(1);
    const item = section.items[0]!;
    expect(item).toMatchObject({
      id: p.id,
      kind: 'note',
      title: 'Add retry to the fetch wrapper',
      partial: false,
      reviewPath: `/inbox/${encodeURIComponent(p.id)}`,
    });
    expect(item.revision).toMatch(REVISION);
    // Not just well-formed — the SAME revision the approval card would use.
    expect(item.revision).toBe(approvalRequestForProposal(p)?.revision);
  });

  it('falls back to review-only (revision null) when no reviewable request exists', () => {
    // A complete proposal whose action exceeds the 32 KiB preview cap:
    // approvalRequestForProposal refuses to bind a clipped review, so the row
    // must degrade honestly instead of guessing a revision. (Varied prose —
    // a homogeneous megastring is itself secret-shaped and gets redacted.)
    makeProposal({ kind: 'browser-action', action: { type: 'browser-task', instructions: 'lorem ipsum dolor sit amet '.repeat(2000) } });
    const item = readPendingProposals().items[0];
    expect(item).toBeDefined();
    expect(item!.revision).toBeNull();
    expect(item!.reviewPath).toMatch(/^\/inbox\//);
  });

  it('flags partial captures so approve stays disabled', () => {
    makeProposal({ isPartial: true });
    expect(readPendingProposals().items[0]).toMatchObject({ partial: true });
  });

  it('sorts oldest-first and reports truncation at the cap', () => {
    const older = makeProposal({ title: 'older' });
    const newer = makeProposal({ title: 'newer' });
    backdate(newer.id, '2026-11-10T00:00:00Z');
    backdate(older.id, '2026-11-01T00:00:00Z');
    expect(readPendingProposals().items.map((i) => i.id)).toEqual([older.id, newer.id]);
    const capped = readPendingProposals(1);
    expect(capped.items).toHaveLength(1);
    expect(capped.truncated).toBe(true);
  });

  it('reports a degraded store as unavailable while still listing what parsed', () => {
    const good = makeProposal({ title: 'survives' });
    writeFileSync(join(inboxDir(), 'corrupt.json'), '{not json');
    const section = readPendingProposals();
    expect(section.state).toBe('unavailable');
    expect(section.reason).toContain('invalid-file');
    expect(section.items.map((i) => i.id)).toEqual([good.id]);
  });

  it('scrubs secret-shaped strings out of every free-text field', () => {
    makeProposal({ title: 'rotate {"api_key":"12345678secret"} now', summary: 'see {"api_key":"12345678secret"}' });
    const section = readPendingProposals();
    const wire = JSON.stringify(section);
    expect(wire).not.toContain('12345678secret');
    expect(section.items[0]!.title).toContain('[REDACTED]');
  });
});

describe('readPendingDrafts', () => {
  it('is an honest empty list when the store is absent', async () => {
    await expect(readPendingDrafts()).resolves.toMatchObject({ state: 'ok', items: [], truncated: false });
  });

  it('lists pending drafts with terminal commands, a digest prefix and never the body', async () => {
    const body = 'Body text that must never be listed.';
    const draft = await createDraft({ to: 'reviewer@example.test', subject: 'Quarterly numbers', body, source: 'outbox-1.json' });
    const section = await readPendingDrafts();
    expect(section.state).toBe('ok');
    expect(section.items).toHaveLength(1);
    const item = section.items[0]!;
    expect(item).toMatchObject({
      id: draft.id,
      subject: 'Quarterly numbers',
      to: 'reviewer@example.test',
      digestPrefix: draft.digest.slice(0, 12),
      approveCommand: `phm drafts approve ${draft.id}`,
      rejectCommand: `phm drafts reject ${draft.id}`,
      showCommand: `phm drafts show ${draft.id}`,
    });
    expect(JSON.stringify(section)).not.toContain(body);
  });

  it('drops decided drafts and sorts pending ones oldest-first', async () => {
    const old = await createDraft(
      { to: 'a@example.test', subject: 'old', body: 'b', source: 'o1.json' },
      undefined,
      () => new Date('2026-11-01T00:00:00Z'),
    );
    const newer = await createDraft(
      { to: 'b@example.test', subject: 'new', body: 'b', source: 'o2.json' },
      undefined,
      () => new Date('2026-11-10T00:00:00Z'),
    );
    await approveDraft(newer.id);
    const section = await readPendingDrafts();
    expect(section.items.map((i) => i.id)).toEqual([old.id]);
    const capped = await readPendingDrafts(undefined, 0);
    expect(capped.items).toEqual([]);
    expect(capped.truncated).toBe(true);
  });

  it('reports an unreadable store as unavailable, never as empty', async () => {
    // A directory at the store path makes readFile throw EISDIR — a broken
    // store must degrade loudly, not silently read as "nothing pending".
    const dir = join(fx.home, '.ashlr-runs', 'drafts');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'drafts.jsonl'));
    expect(await readPendingDrafts()).toMatchObject({ state: 'unavailable', items: [] });
  });
});

describe('buildApprovalsProjection', () => {
  it('composes all five sections with independent honest states', async () => {
    const p = await buildApprovalsProjection();
    expect(Object.keys(p)).toEqual(
      expect.arrayContaining(['generatedAt', 'team', 'teamApprovals', 'proposals', 'drafts', 'pins', 'holds']),
    );
    expect(p.proposals).toMatchObject({ state: 'ok', items: [], truncated: false });
    expect(p.drafts).toMatchObject({ state: 'ok', items: [], truncated: false });
    const created = await createDraft({ to: 'c@example.test', subject: 'hi', body: 'b', source: 'o.json' });
    makeProposal({ title: 'needs consent' });
    const next = await buildApprovalsProjection();
    expect(next.proposals.items).toHaveLength(1);
    expect(next.drafts.items.map((d) => d.id)).toEqual([created.id]);
  });
});
