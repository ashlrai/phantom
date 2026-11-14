/** `ashlr fleet work-result` posts exactly one evidence-shaped reply body
 * through postBusReply — verified {pr,head}, verified {tests}, verified
 * {artifact} or blocked {dependency} — which the work board reads as
 * VERIFIED or BLOCKED. Real bus inbox in a tmp root; plainly fake ids and
 * text only. */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { cmdFleetWorkResult } from '../src/cli/fleet-work-result.js';

let root: string, now: number;
const ID = 'RQ-PHX-FAKE-333';
const post = (id = ID) => {
  expect(appendBusInbox({ id, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl: 10_000_000,
    body: { kind: 'work' } }, { root, now: () => now }).status).toBe('posted');
};
const invoke = async (replyId: string, extra: string[], requestId = ID) => {
  const output: string[] = [];
  const code = await cmdFleetWorkResult(
    ['--request-id', requestId, '--reply-id', replyId, '--root', root, ...extra],
    { now: () => now }, { output: text => output.push(text) });
  return { code, text: output.join(''),
    result: output.length ? JSON.parse(output[0]!) as { outcome: string } : null };
};
const ids = () => {
  const page = listBusInboxAfter(0, 100, { root, now: () => now });
  return page.status === 'ok' ? page.messages.map(m => m.envelope.id) : [];
};
const replyBody = (replyId: string) => {
  const page = listBusInboxAfter(0, 100, { root, now: () => now });
  return page.status === 'ok' ? page.messages.find(m => m.envelope.id === replyId)?.envelope.body : undefined;
};
const boardItem = (id = ID) => listWorkBoard({ root, now }).items.find(i => i.id === id);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'work-result-333-'));
  chmodSync(root, 0o700);
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('cmdFleetWorkResult', { timeout: 60_000 }, () => {
  it("registry resolves 'work-result' to cmdFleetWorkResult", async () => {
    expect(resolveFleetSubcommand('work-result'))
      .toEqual({ module: './fleet-work-result.js', exportName: 'cmdFleetWorkResult' });
    const loader = FLEET_SUBCOMMAND_LOADERS['work-result'];
    expect(loader).toBeTypeOf('function');
    expect((await loader!()).cmdFleetWorkResult).toBe(cmdFleetWorkResult);
  });

  it('--pr --head posts verified {pr,head} and the board shows VERIFIED', async () => {
    post();
    const run = await invoke('fake-reply-333-pr', ['--pr', '42', '--head', 'fakehead333']);
    expect(run.code).toBe(0);
    expect(run.result!.outcome).toBe('posted');
    expect(replyBody('fake-reply-333-pr'))
      .toEqual({ verified: { pr: 42, head: 'fakehead333' }, inReplyTo: ID });
    const { evidence } = collectBusWorkItemEvidence(ID, { root, now });
    expect(evidence.verified).toMatchObject({ pr: 42, head: 'fakehead333', source: 'bus-reply:fake-reply-333-pr' });
    expect(boardItem()!.state).toBe('VERIFIED');
  });

  it.each([['--tests', 'fake tests green'], ['--artifact', 'fake-artifact.txt']] as const)(
    '%s posts verified evidence and the board shows VERIFIED', async (flag, value) => {
      post();
      const replyId = `fake-reply-333-${flag.slice(2)}`;
      const run = await invoke(replyId, [flag, value]);
      expect(run.code).toBe(0);
      expect(run.result!.outcome).toBe('posted');
      expect(replyBody(replyId)).toEqual({ verified: { [flag.slice(2)]: value }, inReplyTo: ID });
      const { evidence } = collectBusWorkItemEvidence(ID, { root, now });
      expect(evidence.verified).toMatchObject({ source: `bus-reply:${replyId}` });
      expect(boardItem()!.state).toBe('VERIFIED');
    });

  it('--blocked posts blocked {dependency} and the board shows BLOCKED', async () => {
    post();
    const run = await invoke('fake-reply-333-blocked', ['--blocked', 'waiting on fake review']);
    expect(run.code).toBe(0);
    expect(run.result!.outcome).toBe('posted');
    expect(replyBody('fake-reply-333-blocked'))
      .toEqual({ blocked: { dependency: 'waiting on fake review' }, inReplyTo: ID });
    const { evidence } = collectBusWorkItemEvidence(ID, { root, now });
    expect(evidence.blocker).toMatchObject({ dependency: 'waiting on fake review', source: 'bus-reply:fake-reply-333-blocked' });
    expect(boardItem()!.state).toBe('BLOCKED');
    expect(boardItem()!.source).toBe('bus-reply:fake-reply-333-blocked');
  });

  it.each([
    ['pr-without-head', ['--pr', '42']],
    ['head-without-pr', ['--head', 'fakehead333']],
    ['pr-zero', ['--pr', '0', '--head', 'fakehead333']],
    ['pr-noninteger', ['--pr', '4.2', '--head', 'fakehead333']],
    ['blocked-unknown', ['--blocked', 'unknown']],
    ['blocked-201-chars', ['--blocked', 'x'.repeat(201)]],
    ['mixed-forms', ['--tests', 'fake tests green', '--blocked', 'waiting on fake review']],
    ['unknown-flag', ['--pr', '42', '--head', 'fakehead333', '--bogus']],
    ['repeated-flag', ['--tests', 'fake a', '--tests', 'fake b']],
    ['no-form', []],
  ] as const)('%s exits 2 and writes no reply', async (name, extra) => {
    post();
    const replyId = `fake-bad-333-${name}`;
    const run = await invoke(replyId, [...extra]);
    expect(run.code).toBe(2);
    expect(run.result!.outcome).toBe('invalid-input');
    expect(ids()).toEqual([ID]);
    expect(boardItem()!.state).toBe('RECEIVED');
  });

  it('a missing request exits 3 and writes nothing', async () => {
    post();
    const run = await invoke('fake-reply-333-nope', ['--pr', '42', '--head', 'fakehead333'], 'RQ-PHX-NOPE-333');
    expect(run.code).toBe(3);
    expect(run.result!.outcome).toBe('request-not-found');
    expect(ids()).toEqual([ID]);
  });

  it('a same-id same-body retry reports duplicate and exits 0', async () => {
    post();
    const first = await invoke('fake-reply-333-dup', ['--tests', 'fake tests green']);
    expect(first.code).toBe(0);
    expect(first.result!.outcome).toBe('posted');
    const second = await invoke('fake-reply-333-dup', ['--tests', 'fake tests green']);
    expect(second.code).toBe(0);
    expect(second.result!.outcome).toBe('duplicate');
    expect(ids()).toEqual([ID, 'fake-reply-333-dup']);
  });

  it('--help prints usage and exits 0 without writing', async () => {
    post();
    const output: string[] = [];
    expect(await cmdFleetWorkResult(['--help'], {}, { output: text => output.push(text) })).toBe(0);
    expect(output[0]).toContain('evidence, not authority');
    expect(output[0]).toContain('does not complete or release a claim');
    expect(ids()).toEqual([ID]);
  });
});
