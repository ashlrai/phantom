import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApprovalRequest, AuditEntry, Proposal, WebServerHandle } from '../src/core/types.js';
import { approvalRequestForProposal } from '../src/core/inbox/pending-authority.js';
import { createProposal, decideApprovalRequest, inboxDir, loadProposal } from '../src/core/inbox/store.js';
import { acquireProposalMutationLock, releaseProposalMutationLock } from '../src/core/inbox/proposal-mutation-lock.js';
import { makeCfg, makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

const storageFailure = vi.hoisted(() => ({ destination: '' }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const renameSync: typeof actual.renameSync = (source, destination) => {
    if (storageFailure.destination && String(destination) === storageFailure.destination) {
      throw Object.assign(new Error('FAKE storage failure'), { code: 'EIO' });
    }
    return actual.renameSync(source, destination);
  };
  return { ...actual, default: { ...actual, renameSync }, renameSync };
});

let fx: H1Fixture;
let servers: WebServerHandle[];

beforeEach(() => {
  fx = makeFixture();
  servers = [];
});

afterEach(async () => {
  storageFailure.destination = '';
  for (const server of servers) await server.close();
  fx.cleanup();
});

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return createProposal({ repo: null, origin: 'manual', kind: 'note', title: 'Review this action',
    summary: 'Operator approval', ...overrides });
}

function card(p: Proposal): ApprovalRequest {
  const request = approvalRequestForProposal(p);
  expect(request).not.toBeNull();
  return request!;
}

function decisionAudits(id: string) {
  // Assert the inbox's emitted artifact; audit's reader has its own suite.
  const directory = join(fx.ashlrDir, 'audit');
  return readdirSync(directory).filter((file) => file.endsWith('.jsonl')).flatMap((file) =>
    readFileSync(join(directory, file), 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEntry))
    .filter((entry) => entry.action.startsWith('inbox:approval-') && entry.summary.includes(id));
}

async function server(allowDispatch = true) {
  const handle = await startServer(makeCfg(), { port: 0, open: false, allowDispatch });
  servers.push(handle);
  return handle;
}

function request(handle: WebServerHandle, method: string, path: string, body?: string,
  headers?: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: handle.port, path, method,
      headers: { Host: `127.0.0.1:${handle.port}`, ...(method === 'GET' ? readAuthHeaders(handle.port) : {
        'Content-Type': 'application/json', 'x-ashlr-token': handle.token,
      }), ...headers } }, (res) => {
      let result = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { result += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: result }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('typed approval review', () => {
  it('projects the exact action, scope and diff without changing the proposal', () => {
    const repo = join(fx.home, 'project');
    mkdirSync(repo);
    const p = proposal({ repo, kind: 'patch', sandboxId: 'sandbox-review', diff: '+reviewable change\n' });
    const review = card(p);
    expect(review).toMatchObject({ schemaVersion: 1, proposalId: p.id,
      action: { kind: 'patch', description: 'Apply patch' }, scope: { repo, sandboxId: 'sandbox-review' },
      diffPreview: { text: '+reviewable change\n', truncated: false } });
    expect(review.revision).toMatch(/^approval-v1:[a-f0-9]{16}(?:\.[a-f0-9]{16}){3}$/);
    expect(loadProposal(p.id)?.status).toBe('pending');
  });

  it('bounds the preview but binds changes beyond it into the revision', () => {
    const p = proposal({ diff: '+line\n'.repeat(8000) });
    const first = card(p);
    const second = card({ ...p, diff: `${p.diff}+later change\n` });
    expect(first.diffPreview.truncated).toBe(true);
    expect(first.diffPreview.text.length).toBeLessThanOrEqual(32_768);
    expect(first.diffPreview).toEqual(second.diffPreview);
    expect(first.revision).not.toBe(second.revision);
  });

  it('redacts runtime FAKE credentials in action details and diff previews', () => {
    // FAKE: generated only at runtime; never a real credential.
    const fakeCredential = `FAKE_${randomBytes(24).toString('hex')}`;
    const raw = `password = "${fakeCredential}"`;
    const p = proposal({ kind: 'browser-action', diff: `+${raw}\n`, action: {
      type: 'browser-task', instructions: `Visit settings; ${raw}`, url: 'https://example.test',
    } });
    const review = card(p);
    expect(JSON.stringify(review)).not.toContain(fakeCredential);
    expect(review.diffPreview.text).toContain('[REDACTED]');
    expect(review.action.details).toContain('[REDACTED]');
  });

  it('refuses malformed or unknown operations', () => {
    const p = proposal();
    expect(approvalRequestForProposal({ ...p, kind: 'invented' } as unknown as Proposal)).toBeNull();
    expect(approvalRequestForProposal({ ...p, diff: {} } as unknown as Proposal)).toBeNull();
    expect(approvalRequestForProposal({ ...p, action: { bad: Number.NaN } } as unknown as Proposal)).toBeNull();
    expect(approvalRequestForProposal({ ...p, action: {
      type: 'browser-task', instructions: 'x'.repeat(40_000),
    } })).toBeNull();
  });
});

describe('durable approval decisions', () => {
  it('does not accept a pre-filled approval receipt from a proposal producer', () => {
    const original = proposal();
    const p = proposal({ approvalDecision: { revision: card(original).revision, decision: 'approve',
      decidedAt: new Date().toISOString() } });
    expect(p.approvalDecision).toBeUndefined();
    expect(loadProposal(p.id)?.approvalDecision).toBeUndefined();
    expect(loadProposal(p.id)?.status).toBe('pending');
  });

  it('approves a patch without writing its target file', () => {
    const repo = join(fx.home, 'patch-project');
    mkdirSync(repo);
    const file = join(repo, 'README.md');
    writeFileSync(file, 'Before review\n');
    const p = proposal({ repo, kind: 'patch', diff: [
      'diff --git a/README.md b/README.md', '--- a/README.md', '+++ b/README.md',
      '@@ -1 +1 @@', '-Before review', '+After execution', '',
    ].join('\n') });
    expect(decideApprovalRequest(p.id, card(p).revision, 'approve')).toMatchObject({ ok: true, status: 'approved' });
    expect(readFileSync(file, 'utf8')).toBe('Before review\n');
    expect(loadProposal(p.id)?.realizedMerge).toBeUndefined();
  });

  it.each([['approve', 'approved'], ['deny', 'rejected']] as const)('records %s once with a durable receipt and audit', (decision, status) => {
    const p = proposal();
    const review = card(p);
    expect(decideApprovalRequest(p.id, review.revision, decision)).toEqual({ ok: true, id: p.id, status });
    const saved = loadProposal(p.id)!;
    expect(saved.status).toBe(status);
    expect(saved.approvalDecision).toMatchObject({ decision, revision: review.revision });
    expect(Number.isFinite(Date.parse(saved.approvalDecision!.decidedAt))).toBe(true);
    expect(saved.realizedMerge).toBeUndefined();
    expect(decisionAudits(p.id)).toHaveLength(1);
    expect(decisionAudits(p.id)[0]?.action).toBe(`inbox:approval-${decision === 'approve' ? 'approved' : 'denied'}`);
    expect(decideApprovalRequest(p.id, review.revision, decision)).toEqual({ ok: false, code: 'conflict' });
    expect(decideApprovalRequest(p.id, review.revision, decision === 'approve' ? 'deny' : 'approve')).toEqual({ ok: false, code: 'conflict' });
    expect(loadProposal(p.id)?.approvalDecision).toEqual(saved.approvalDecision);
    expect(decisionAudits(p.id)).toHaveLength(1);
  });

  it('refuses a decision after the reviewed proposal changes', () => {
    const p = proposal();
    const old = card(p);
    const file = join(inboxDir(), `${p.id}.json`);
    writeFileSync(file, JSON.stringify({ ...p, summary: 'Changed scope after review' }));
    expect(decideApprovalRequest(p.id, old.revision, 'approve')).toEqual({ ok: false, code: 'conflict' });
    expect(loadProposal(p.id)?.status).toBe('pending');
    expect(decisionAudits(p.id)).toEqual([]);
  });

  it('allows denying partial evidence while refusing approval', () => {
    const p = proposal({ isPartial: true });
    const review = card(p);
    expect(decideApprovalRequest(p.id, review.revision, 'approve')).toEqual({ ok: false, code: 'conflict' });
    expect(loadProposal(p.id)?.status).toBe('pending');
    expect(decideApprovalRequest(p.id, review.revision, 'deny')).toMatchObject({ ok: true, status: 'rejected' });
  });

  it('fails closed while another writer holds the request lock', () => {
    const p = proposal();
    const review = card(p);
    const lock = acquireProposalMutationLock(p.id);
    expect(lock).not.toBeNull();
    try {
      expect(decideApprovalRequest(p.id, review.revision, 'approve')).toEqual({ ok: false, code: 'unavailable' });
      expect(loadProposal(p.id)?.status).toBe('pending');
      expect(decisionAudits(p.id)).toEqual([]);
    } finally { releaseProposalMutationLock(lock); }
    expect(decideApprovalRequest(p.id, review.revision, 'approve')).toMatchObject({ ok: true });
  });

  it('does not acknowledge or audit a decision when storage fails', () => {
    const p = proposal();
    const review = card(p);
    const file = join(inboxDir(), `${p.id}.json`);
    const before = readFileSync(file, 'utf8');
    storageFailure.destination = file;
    expect(decideApprovalRequest(p.id, review.revision, 'approve')).toEqual({ ok: false, code: 'unavailable' });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(decisionAudits(p.id)).toEqual([]);
    storageFailure.destination = '';
    expect(decideApprovalRequest(p.id, review.revision, 'deny')).toMatchObject({ ok: true });
  });
});

describe('authenticated inbox decision API', () => {
  it.each([['approve', 'approved'], ['deny', 'rejected']] as const)('GET review then %s records consent without applying', async (decision, status) => {
    const p = proposal();
    const handle = await server();
    const detail = await request(handle, 'GET', `/api/inbox/${p.id}`);
    expect(detail.status).toBe(200);
    const review = (JSON.parse(detail.body) as { approvalRequest: ApprovalRequest }).approvalRequest;
    expect(review).toEqual(card(p));
    const body = JSON.stringify({ revision: review.revision, decision });
    const result = await request(handle, 'POST', `/api/inbox/${p.id}/decision`, body);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true, id: p.id, status });
    expect(loadProposal(p.id)?.status).toBe(status);
    expect(loadProposal(p.id)?.approvalDecision?.decision).toBe(decision);
    expect(decisionAudits(p.id)).toHaveLength(1);
    expect((await request(handle, 'POST', `/api/inbox/${p.id}/decision`, body)).status).toBe(409);
    const decidedDetail = await request(handle, 'GET', `/api/inbox/${p.id}`);
    expect((JSON.parse(decidedDetail.body) as Proposal).approvalDecision).toEqual(loadProposal(p.id)?.approvalDecision);
  });

  it('has no decision route when dispatch is disabled', async () => {
    const p = proposal();
    const handle = await server(false);
    expect((await request(handle, 'POST', `/api/inbox/${p.id}/decision`, JSON.stringify({ revision: card(p).revision, decision: 'approve' }))).status).toBe(404);
    expect(loadProposal(p.id)?.status).toBe('pending');
  });

  it('requires a mutation token and JSON content type', async () => {
    const p = proposal();
    const handle = await server();
    const body = JSON.stringify({ revision: card(p).revision, decision: 'approve' });
    const path = `/api/inbox/${p.id}/decision`;
    expect((await request(handle, 'POST', path, body, { 'x-ashlr-token': '' })).status).toBe(401);
    expect((await request(handle, 'POST', path, body, { 'x-ashlr-token': 'FAKE-invalid' })).status).toBe(401);
    expect((await request(handle, 'POST', path, body, readAuthHeaders(handle.port))).status).toBe(401);
    expect((await request(handle, 'POST', path, body, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect(loadProposal(p.id)?.status).toBe('pending');
    expect(decisionAudits(p.id)).toEqual([]);
  });

  it('rejects malformed, oversized and unexpected request fields', async () => {
    const p = proposal();
    const handle = await server();
    const path = `/api/inbox/${p.id}/decision`;
    for (const body of ['{', 'null', '[]', '{}', JSON.stringify({ revision: card(p).revision, decision: 'execute' }),
      JSON.stringify({ revision: 'invalid', decision: 'approve' }),
      JSON.stringify({ revision: card(p).revision, decision: 'approve', extra: true }),
      JSON.stringify({ revision: card(p).revision, decision: 'approve', padding: 'x'.repeat(5000) })]) {
      expect((await request(handle, 'POST', path, body)).status).toBe(400);
    }
    expect(loadProposal(p.id)?.status).toBe('pending');
    expect(decisionAudits(p.id)).toEqual([]);
  });

  it('returns 404 for missing proposals and 409 for stale revisions', async () => {
    const p = proposal();
    const handle = await server();
    const body = JSON.stringify({ revision: card({ ...p, summary: 'A different review' }).revision, decision: 'deny' });
    expect((await request(handle, 'POST', '/api/inbox/missing/decision', body)).status).toBe(404);
    expect((await request(handle, 'POST', `/api/inbox/${p.id}/decision`, body)).status).toBe(409);
    expect(loadProposal(p.id)?.status).toBe('pending');
  });

  it('returns 503 on persistence failure without recording consent', async () => {
    const p = proposal();
    const handle = await server();
    storageFailure.destination = join(inboxDir(), `${p.id}.json`);
    const body = JSON.stringify({ revision: card(p).revision, decision: 'approve' });
    expect((await request(handle, 'POST', `/api/inbox/${p.id}/decision`, body)).status).toBe(503);
    expect(loadProposal(p.id)?.status).toBe('pending');
    expect(loadProposal(p.id)?.approvalDecision).toBeUndefined();
    expect(decisionAudits(p.id)).toEqual([]);
  });
});
