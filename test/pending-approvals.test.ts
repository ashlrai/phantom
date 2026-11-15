/**
 * test/pending-approvals.test.ts — GET /api/approvals + readPendingApprovals.
 *
 * Hermetic: every store lives under the fixture's tmp HOME (inbox proposals,
 * ~/.ashlr-runs drafts, $ASHLR_HOME teams). Asserts the value-blind contract —
 * diffs, draft bodies and secret-shaped strings never reach the response —
 * the per-source quality reporting, and the per-source `decide` descriptors.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebServerHandle } from '../src/core/types.js';
import { createProposal, inboxDir } from '../src/core/inbox/store.js';
import { readPendingApprovals, type PendingApprovalsResponse } from '../src/core/web/pending-approvals.js';
import { requestHandoff, type TeamActor } from '../src/core/teams/index.js';
import { draftDigest, draftsDir } from '../src/core/cos/drafts.js';
import { makeCfg, makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

const agent: TeamActor = { kind: 'agent', id: 'agent:codex/acct-1', provider: 'codex' };
const TEAM = 'pending-approvals-test';

let fx: H1Fixture;
let servers: WebServerHandle[];

beforeEach(() => {
  fx = makeFixture();
  servers = [];
});

afterEach(async () => {
  for (const server of servers) await server.close();
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

function writeDraft(overrides: Partial<{ id: string; to: string; subject: string; body: string; source: string; createdAt: string; status: string }> = {}) {
  const to = overrides.to ?? 'reviewer@example.test';
  const subject = overrides.subject ?? 'Quarterly numbers';
  const body = overrides.body ?? 'Body text that must never be listed.';
  const source = overrides.source ?? 'outbox-1.json';
  const createdAt = overrides.createdAt ?? new Date().toISOString();
  const digest = draftDigest({ to, subject, body });
  const id = overrides.id ?? `d-${digest.slice(0, 16)}`;
  const record = { id, status: overrides.status ?? 'pending', channel: 'email', to, subject, body, source, digest, createdAt };
  const dir = draftsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'drafts.jsonl'), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

function requestTeamApproval(title = 'Ship the release') {
  const handoff = requestHandoff(TEAM, agent, { title, action: 'release' }) as { approvalId: string };
  return handoff.approvalId;
}

async function get(handle: WebServerHandle, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port: handle.port, path, method: 'GET', headers: { Host: `127.0.0.1:${handle.port}`, ...readAuthHeaders(handle.port) } },
      (res) => {
        let result = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { result += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: result }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('readPendingApprovals', () => {
  it('reports every source missing on a fresh home and claims nothing pending', async () => {
    const res = await readPendingApprovals();
    expect(res.approvals).toEqual([]);
    expect(res.truncated).toBe(false);
    expect(res.dispatchEnabled).toBe(false);
    expect(res.sources.proposal.sourceState).toBe('missing');
    expect(res.sources.draft.sourceState).toBe('missing');
    expect(res.sources['team-approval'].sourceState).toBe('missing');
  });

  it('lists a pending proposal with a consent decide bound to its revision', async () => {
    const p = makeProposal({ title: 'Add retry to fetch wrapper' });
    const res = await readPendingApprovals({ allowDispatch: true });
    expect(res.dispatchEnabled).toBe(true);
    expect(res.sources.proposal).toMatchObject({ sourceState: 'healthy', complete: true });
    const item = res.approvals.find((a) => a.id === `proposal:${p.id}`);
    expect(item).toBeDefined();
    expect(item).toMatchObject({
      source: 'proposal',
      kind: 'note',
      title: 'Add retry to fetch wrapper',
      status: 'pending',
      reviewPath: `/inbox/${encodeURIComponent(p.id)}`,
    });
    expect(item!.decide).toMatchObject({ mode: 'consent', proposalId: p.id });
    expect((item!.decide as { revision: string }).revision).toMatch(/^approval-v1:[a-f0-9]{16}(?:\.[a-f0-9]{16}){3}$/);
    expect(item!.parameters).toMatchObject({ origin: 'manual', partial: false });
    expect(Date.parse(item!.createdAt)).not.toBeNaN();
  });

  it('marks a partial proposal approve-refused but still deniable', async () => {
    const p = makeProposal({ isPartial: true });
    const res = await readPendingApprovals();
    const item = res.approvals.find((a) => a.id === `proposal:${p.id}`)!;
    expect(item.decide).toMatchObject({ mode: 'consent', partial: true });
  });

  it('falls back to review-only when the proposal has no reviewable request', async () => {
    const p = makeProposal();
    // Corrupt the stored kind so approvalRequestForProposal returns null.
    const file = join(inboxDir(), `${p.id}.json`);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    stored['kind'] = 'invented-kind';
    writeFileSync(file, JSON.stringify(stored));
    const res = await readPendingApprovals();
    const item = res.approvals.find((a) => a.id === `proposal:${p.id}`);
    expect(item).toBeDefined();
    expect(item!.decide.mode).toBe('review-only');
    expect(item!.reviewPath).toBe(`/inbox/${encodeURIComponent(p.id)}`);
  });

  it('lists a pending draft as terminal-only metadata and never its body', async () => {
    const sentinel = 'DRAFT_BODY_SENTINEL_9f3e2d';
    const draft = writeDraft({ body: `Confidential body ${sentinel}` });
    const res = await readPendingApprovals();
    expect(res.sources.draft).toMatchObject({ sourceState: 'healthy', complete: true });
    const item = res.approvals.find((a) => a.id === `draft:${draft.id}`)!;
    expect(item).toMatchObject({ source: 'draft', kind: 'email-draft', status: 'pending' });
    expect(item.title).toBe('Quarterly numbers');
    expect(item.parameters).toMatchObject({ channel: 'email', to: 'reviewer@example.test', source: 'outbox-1.json' });
    expect((item.parameters['digest'] as string).length).toBe(12);
    expect(item.decide).toEqual({
      mode: 'terminal',
      approveCommand: `phm drafts approve ${draft.id}`,
      denyCommand: `phm drafts reject ${draft.id}`,
      showCommand: `phm drafts show ${draft.id}`,
    });
    expect(JSON.stringify(res)).not.toContain(sentinel);
    expect(JSON.stringify(res)).not.toContain('Confidential body');
  });

  it('lists a pending team approval as terminal-only with action metadata', async () => {
    const approvalId = requestTeamApproval('Ship the release candidate');
    const res = await readPendingApprovals();
    expect(res.sources['team-approval']).toMatchObject({ sourceState: 'healthy', complete: true });
    const item = res.approvals.find((a) => a.id === `team-approval:${TEAM}:${approvalId}`);
    expect(item).toBeDefined();
    expect(item).toMatchObject({
      source: 'team-approval',
      kind: 'team:release',
      title: 'Ship the release candidate',
      status: 'pending',
    });
    expect(item!.parameters).toMatchObject({ team: TEAM, action: 'release', requestedBy: agent.id });
    expect(Date.parse(item!.createdAt)).not.toBeNaN();
    expect(item!.decide).toEqual({
      mode: 'terminal',
      approveCommand: `phm team approve ${approvalId} --team ${TEAM}`,
      denyCommand: `phm team deny ${approvalId} --team ${TEAM}`,
      showCommand: `phm team view --team ${TEAM}`,
    });
  });

  it('sorts oldest-first across sources', async () => {
    makeProposal({ title: 'Newest proposal' });
    requestTeamApproval('Middle team approval');
    writeDraft({ createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), subject: 'Oldest draft' });
    const res = await readPendingApprovals();
    expect(res.approvals).toHaveLength(3);
    expect(res.approvals[0]!.source).toBe('draft');
    expect(res.approvals[0]!.title).toBe('Oldest draft');
    const times = res.approvals.map((a) => Date.parse(a.createdAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('never leaks diff or secret-shaped content into the response', async () => {
    const sentinel = 'DIFF_SENTINEL_7b1c0a';
    makeProposal({
      kind: 'patch',
      repo: join(fx.home, 'repo'),
      diff: `+line with ${sentinel}\n`,
      title: `Title ${sentinel}`,
    });
    writeDraft({ body: `body ${sentinel}` });
    const res = await readPendingApprovals();
    const json = JSON.stringify(res);
    // The title is legitimately listed (it is the request's name); the diff
    // body and draft body must not be.
    expect(json).not.toContain('line with');
    expect(json).not.toContain('body ');
    expect(json).not.toContain('diffPreview');
  });

  it('scrubs secret-shaped strings out of titles and parameters', async () => {
    // FAKE: generated only at runtime; never a real credential. `sk-…` is a
    // shape scrubSecrets recognises on its own (no key-name context needed).
    const fake = `sk-ant-api03-${randomBytes(16).toString('hex')}`;
    makeProposal({ title: `Rotate key ${fake}` });
    const res = await readPendingApprovals();
    expect(JSON.stringify(res)).not.toContain(fake);
    expect(JSON.stringify(res)).toContain('[REDACTED]');
  });

  it('degrades only the draft source when its store is unreadable', async () => {
    makeProposal();
    // A directory where drafts.jsonl should be a file: readFile throws EISDIR.
    mkdirSync(join(draftsDir(), 'drafts.jsonl'), { recursive: true });
    const res = await readPendingApprovals();
    expect(res.sources.draft.sourceState).toBe('degraded');
    expect(res.sources.draft.complete).toBe(false);
    expect(res.sources.proposal.sourceState).toBe('healthy');
    expect(res.approvals.some((a) => a.source === 'proposal')).toBe(true);
  });

  it('caps the merged list and reports truncation', async () => {
    for (let i = 0; i < 5; i += 1) makeProposal({ title: `Proposal ${i}` });
    const res = await readPendingApprovals({ maxItems: 3 });
    expect(res.approvals).toHaveLength(3);
    expect(res.truncated).toBe(true);
  });
});

describe('GET /api/approvals', () => {
  it('serves the read model with dispatchEnabled mirroring the server gate', async () => {
    makeProposal({ title: 'Served proposal' });
    const handle = await startServer(makeCfg(), { port: 0, open: false, allowDispatch: true });
    servers.push(handle);
    const res = await get(handle, '/api/approvals');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as PendingApprovalsResponse;
    expect(body.dispatchEnabled).toBe(true);
    expect(body.approvals.some((a) => a.title === 'Served proposal')).toBe(true);
    expect(body.sources.proposal.sourceState).toBe('healthy');
  });

  it('reports dispatchEnabled false on a read-only server', async () => {
    const handle = await startServer(makeCfg(), { port: 0, open: false, allowDispatch: false });
    servers.push(handle);
    const res = await get(handle, '/api/approvals');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as PendingApprovalsResponse;
    expect(body.dispatchEnabled).toBe(false);
  });
});
