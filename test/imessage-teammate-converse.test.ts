import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import { classifyTeammateIntent as classifyInboxIntent, readTeammateTexts, recordTeammateText } from '../src/core/comms/imessage-teammate-inbox.js';
import { classifyTeammateIntent, runTeammateResponder } from '../src/core/comms/imessage-teammate-worker.js';

const HANDLE = 'agent@example.test';
const NOW = 1793933400000;
const HANDOFF = 'Handoff: RQ-DOCS-7 is published as PR #6123 and the review lane is released back to you.';
const QUESTION = 'What is blocking RQ-DOCS-7?';
const cfg = {} as AshlrConfig;
let runsDir: string;
let clock = NOW;
const seed = (rowid: number, text: string) => recordTeammateText({ rowid, handle: HANDLE, text }, runsDir, new Date(NOW));
const options = () => ({
  runsDir, now: () => clock, approved: () => HANDLE,
  generate: vi.fn(async (_text: string, _context: string) => 'Understood, RQ-DOCS-7 is published.'),
  send: vi.fn(async (_text: string) => 'accepted' as const),
  reconcile: vi.fn(async () => ({ rowid: 99, sent: true, delivered: true, error: 0 })),
});
const down = () => { const deps = options(); deps.generate.mockRejectedValue(new Error('Model unavailable')); return deps; };
beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'imessage-converse-')); clock = NOW; });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

describe('teammate suppression matrix', () => {
  it.each([
    [HANDOFF, 'acknowledge'],
    ['Authorization recorded: Instinct is authorized to continue the docs lane until the review lands.', 'acknowledge'],
    ['Receipt: I received all three artifacts for RQ-DOCS-7 and stored them locally.', 'acknowledge'],
    ['Blocker: RQ-DOCS-7 is blocked on a missing fixture, so the lane is idle for now.', 'acknowledge'],
    ['I have claimed RQ-DOCS-7 on the personal lane and will report when it publishes.', 'acknowledge'],
    ['Coordinating with Instinct: I take the tests while they finish the doc section.', 'acknowledge'],
    ['Acknowledged.', 'ignore'],
    ['Thanks!', 'ignore'],
    ['Lane idle, queue empty.', 'ignore'],
    ['Claimed RQ-DOCS-7.', 'ignore'],
    ['PATCH-BEGIN demo 1 2 for the blocked handoff that was claimed and received here', 'ignore'],
    ['RESULT RQ-DOCS-7 abc DONE received and delivered the artifact for the blocked handoff claim', 'ignore'],
    [QUESTION, 'reply'],
    ['Please deploy the release?', 'leader'],
  ])('%s -> %s', (text, intent) => {
    expect(classifyTeammateIntent(text)).toBe(intent);
    // Read-only observers never see the worker-only intent.
    expect(classifyInboxIntent(text)).toBe(intent === 'acknowledge' ? 'ignore' : intent);
  });
});

describe('conversational teammate replies', () => {
  it('answers a handoff with the model reply, the matching record in the prompt and the signature', async () => {
    mkdirSync(join(runsDir, 'metrics'));
    writeFileSync(join(runsDir, 'metrics/jobs.jsonl'), '{"id":"RQ-DOCS-7","status":"published"}\n', { mode: 0o600 });
    seed(10, HANDOFF); const deps = options();
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ sent: 1, suppressed: 0 });
    expect(deps.generate.mock.calls[0]?.[1]).toContain('metrics/jobs.jsonl: {"id":"RQ-DOCS-7","status":"published"}');
    expect(deps.send.mock.calls[0]?.[0]).toBe('Understood, RQ-DOCS-7 is published.\n— Phantom · ref [10]');
  });
  it('sends the marked template for an acknowledgement when the model fails', async () => {
    seed(10, HANDOFF); const deps = down();
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ sent: 1 });
    expect(deps.send.mock.calls[0]?.[0]).toMatch(/^Automatic template reply .*RQ-DOCS-7, #6123 .*status is unknown\.\n— Phantom · ref \[10\]$/);
  });
  it('gives a question three model attempts before the template goes out', async () => {
    seed(10, QUESTION); const deps = down();
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ pending: 1, sent: 0 });
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ pending: 1, sent: 0 });
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ sent: 1 });
    expect(deps.generate).toHaveBeenCalledTimes(3);
    expect(deps.send.mock.calls[0]?.[0]).toContain('Automatic template reply');
  });
  it('sends the template for a question after fifteen minutes without a model reply', async () => {
    seed(10, QUESTION); const deps = down();
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ pending: 1, sent: 0 });
    clock += 15 * 60 * 1000;
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ sent: 1 });
    expect(deps.generate).toHaveBeenCalledTimes(2);
  });
  it('caps acknowledgements at four per teammate per hour; the fifth stays pending, never suppressed', async () => {
    for (let rowid = 1; rowid <= 5; rowid++) seed(rowid, HANDOFF);
    const deps = options();
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ sent: 3 });
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ sent: 1, pending: 1, suppressed: 0 });
    expect(readTeammateTexts({ runsDir }).texts.map(text => text.rowid)).toEqual([5]);
    // A question from the same teammate is not an acknowledgement and still gets through.
    seed(6, QUESTION);
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ sent: 1, pending: 1 });
    clock += 61 * 60 * 1000;
    expect(await runTeammateResponder(cfg, deps)).toMatchObject({ sent: 1, pending: 0 });
    expect(deps.send).toHaveBeenCalledTimes(6);
  });
});
