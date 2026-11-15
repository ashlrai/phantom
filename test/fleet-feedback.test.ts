import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { triageFeedback, type FeedbackSignal } from '../src/core/fleet/feedback-triage.js';
import { feedbackIngestDeps, ingestFeedback, type FeedbackSnapshot } from '../src/core/fleet/feedback-ingest.js';
import { feedbackDigest, runFeedback } from '../src/core/fleet/feedback-cycle.js';
import { cmdFleetFeedback } from '../src/cli/fleet-feedback.js';

const signal = (text = 'Bug: export crashes', refs: string[] = []): FeedbackSignal => ({ source: 'self-report', text, refs });
const now = Date.now(), at = new Date(now - 1000).toISOString(), url = 'https://github.com/ashlrai/phantom';
const snapshot = (signals = [signal()]): FeedbackSnapshot => ({ signals, open: [], shipped: [], sources: { 'open-prs': 'ok' }, coverageComplete: true });
let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'feedback-'))); });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe('feedback triage', () => {
  it.each([['Bug: export crashes', 'bug'], ['regression: export stopped working', 'regression'],
    ['intermittent test timeout', 'flake'], ['Please add export', 'feature'], ['How does export work?', 'question'],
    ['thanks!', 'ignore']])('classifies %s as %s', (text, kind) => expect(triageFeedback(signal(text)).kind).toBe(kind));
  it.each(['Fix .github/workflows/ci.yml', 'Fix src/core/authority/resident.ts', 'Fix src\\core\\sandbox\\policy.ts',
    'Fix %2egithub%2fworkflows%2fci.yml', 'Fix ../private/file.ts', 'Fix publish.sh', 'Fix CODEOWNERS',
    'Fix sandbox profiles', 'Fix auth.json', 'Fix src/core/fleet/host-merge.ts', 'Fix \u200bsrc/core/authority/resident.ts'])('refuses protected scope %s', text => {
    expect(triageFeedback(signal(`Bug: ${text}`))).toMatchObject({ kind: 'ignore', reason: text.includes('\u200b') ? 'control-characters' : 'protected-scope' });
  });
  it('refuses secrets and invalid refs without returning the original text', () => {
    const secret = 'xai-' + 'aB12'.repeat(12);
    expect(triageFeedback(signal(`Bug ${secret}`))).toEqual({ kind: 'ignore', reason: 'secret-shaped' });
    expect(triageFeedback(signal('Bug export', ['https://evil.invalid/']))).toEqual({ kind: 'ignore', reason: 'invalid-signal' });
    const result = triageFeedback(signal('Bug export uses phm_example reference'));
    expect(result.kind).toBe('bug');
  });
  it('dedupes normalized titles, refs, and queue IDs; prompts confer no merge authority', () => {
    const s = signal('Bug: Export crashes!', [`${url}/issues/1`]), result = triageFeedback(s);
    expect(result.kind).toBe('bug'); if (result.kind === 'ignore') return;
    for (const coverage of [{ text: 'fix: export CRASHES' }, { text: '', refs: [`${url}/issues/1#comment-2`] },
      { text: `- READY RQ-PHX-FB${result.dedupeKey}` }]) expect(triageFeedback(s, [coverage])).toEqual({ kind: 'ignore', reason: 'duplicate' });
    expect(result.promptSeed).toContain('Never merge, push, publish');
    expect(triageFeedback(signal('Bug at https://github.com/ashlrai/phantom/issues/1')).kind).toBe('bug');
    expect(triageFeedback(signal('Bug: unrelated new problem', [`${url}/issues/1`]), [{ text: `Fix ${url}/issues/10` }]).kind).toBe('bug');
    expect(triageFeedback(signal('Bug: 100% export failure')).kind).toBe('bug');
    expect(triageFeedback(signal('Bug at https://github.com/ashlrai/phantom/blob/master/src/core/authority/resident.ts'))).toMatchObject({ reason: 'protected-scope' });
    expect(triageFeedback(signal('Bug in %252egithub%252fci.yml'))).toMatchObject({ reason: 'encoded-content' });
  });
});

describe('feedback collectors', () => {
  const gh = async (args: string[]) => {
    if (args[0] === 'issue') return JSON.stringify([{ number: 1, title: 'Bug export', body: '', updatedAt: at }]);
    if (args.includes('open')) return JSON.stringify([{ number: 2, title: 'fix export', body: '' }]);
    if (args.includes('merged')) return JSON.stringify([{ number: 3, mergeCommit: { oid: 'a'.repeat(40) }, mergedAt: at }]);
    if (args[1]?.includes('/commits?')) return JSON.stringify([{ sha: 'b'.repeat(40), commit: { message: `Revert\nThis reverts commit ${'a'.repeat(40)}.`, committer: { date: new Date(now).toISOString() } } }]);
    if (args[1]?.includes('comments?')) return JSON.stringify([{ id: 4, body: 'Bug in export', updated_at: at, issue_url: `${url}/issues/2`, pull_request_url: `${url}/pulls/2` }]);
    if (args[0] === 'run') return JSON.stringify([{ databaseId: 5, displayTitle: 'CI export', createdAt: at }]);
    return '[]';
  };
  it('collects bounded GitHub, CI, comms and a merge-bound revert', async () => {
    const call = vi.fn(gh), pause = vi.fn(async () => {});
    const out = await ingestFeedback(now, 7, { gh: call, pause, pollComms: async () => [{ ...signal(), source: 'comms' }] });
    expect(out.coverageComplete).toBe(true); expect(out.signals).toHaveLength(6);
    expect(out.signals.filter(s => s.source === 'revert')).toHaveLength(1);
    expect(out.shipped).toEqual([{ ref: `${url}/pull/3`, at: now - 1000 }]);
    expect(call).toHaveBeenCalledTimes(7); expect(pause).toHaveBeenCalledTimes(8);
    expect(call.mock.calls.flat(2).join(' ')).not.toMatch(/--log|merge |--auto|--paginate/);
  });
  it('does not guess coverage or leak errors when a page is saturated or malformed', async () => {
    const out = await ingestFeedback(now, 7, { gh: async () => JSON.stringify(Array(1000).fill({})), pause: async () => {}, pollComms: async () => { throw new Error('private text'); } });
    expect(out.coverageComplete).toBe(false); expect(out.signals).toEqual([]);
    expect(Object.values(out.sources).every(s => s === 'unavailable')).toBe(true);
    expect(JSON.stringify(out)).not.toContain('private text');
  });
  it('rejects revert evidence before its merge or with a different target', async () => {
    for (const message of [`This reverts commit ${'c'.repeat(40)}.`, `This reverts commit ${'a'.repeat(40)}.`]) {
      const out = await ingestFeedback(now, 7, { gh: args => args[1]?.includes('/commits?') ? Promise.resolve(JSON.stringify([{ sha: 'b'.repeat(40), commit: { message, committer: { date: new Date(now - 2000).toISOString() } } }])) : gh(args), pause: async () => {}, pollComms: async () => [] });
      expect(out.signals.some(s => s.source === 'revert')).toBe(false);
    }
  });
  it('keeps bounded observed records while explicitly reporting incomplete pages', async () => {
    const out = await ingestFeedback(now, 7, { gh: async args => args[0] === 'run' ? JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ databaseId: i + 1, displayTitle: 'CI export', createdAt: at }))) : gh(args), pause: async () => {}, pollComms: async () => [] });
    expect(out.sources.ci).toBe('truncated'); expect(out.signals.filter(s => s.source === 'ci-failure')).toHaveLength(100);
  });
  it('times out an injected collector and aborts it without late publication', async () => {
    vi.useFakeTimers(); let aborted: AbortSignal | undefined;
    const task = ingestFeedback(now, 7, { gh: async (args, abort) => { if (args[0] === 'pr' && args.includes('open')) { aborted = abort; return new Promise(() => {}); } return '[]'; }, pause: async () => {}, pollComms: async () => [] });
    await vi.advanceTimersByTimeAsync(9001);
    expect((await task).sources['open-prs']).toBe('unavailable'); expect(aborted?.aborted).toBe(true);
  });
  it('polls existing comms receipts without sending or exposing iMessage bodies', async () => {
    const envelopes = ['telegram', 'imessage'].map(channel => ({ id: `msg-${channel}`, from: 'mason', to: 'leaders', priority: 'P2', ttl: 60000, body: { kind: 'interjection', channel, text: `Bug from ${channel}` } }));
    envelopes.push(...['leader', 'mason'].map(to => ({ id: `owner-${to}`, from: to === 'leader' ? 'mason' : 'leader', to, priority: 'P2', ttl: 60000, body: { kind: 'owner-thread', channel: 'telegram', text: `Bug owner ${to}` } })));
    await mkdir(join(root, 'bus-inbox'), { mode: 0o700 });
    const file = join(root, 'bus-inbox/messages.json'), data = JSON.stringify({ version: 2, highWater: 4, rows: envelopes.map((envelope, i) => ({ cursor: i + 1, receivedAt: Date.now(), envelope })) });
    await writeFile(file, data, { mode: 0o600 });
    const out = await feedbackIngestDeps(root).pollComms(now - 60000, new AbortController().signal);
    expect(out.map(s => s.text)).toEqual(['Bug from telegram', 'Bug owner leader']);
    expect(await readFile(file, 'utf8')).toBe(data);
  });
});

describe('feedback scan and digest', () => {
  const options = () => ({ command: 'scan' as const, apply: false, days: 7, runsDir: root });
  const deps = (s = snapshot()) => ({ ingest: async () => s, read: async () => '' });
  it('dry-run has no writes; apply caps, serializes concurrent cycles and suppresses replays', async () => {
    const d = deps(snapshot(Array.from({ length: 7 }, (_, i) => signal(`Bug: component ${i} crashes`))));
    expect((await runFeedback(options(), d)).queued).toEqual([]); expect(await readdir(root)).toEqual([]);
    const reports = await Promise.all([runFeedback({ ...options(), apply: true }, d), runFeedback({ ...options(), apply: true }, d)]);
    expect(reports.reduce((n, r) => n + r.queued.length, 0)).toBe(5);
    expect(await readdir(join(root, 'leader/drop/claude'))).toHaveLength(5);
    const first = (await readdir(join(root, 'leader/drop/claude')))[0]!;
    expect(await readFile(join(root, 'leader/drop/claude', first), 'utf8')).toMatch(/^#job repo=phantom lane=codex-personal tier=work/);
    expect((await runFeedback({ ...options(), apply: true }, d)).errors).toContain('cycle-rate-limited');
    await utimes(join(root, 'feedback/cycle'), new Date(0), new Date(0));
    expect((await runFeedback({ ...options(), apply: true }, d)).queued).toHaveLength(2);
  });
  it('withholds apply for questions, protected content, unavailable coverage and full queues', async () => {
    const s = snapshot([signal('How does export work?'), signal('Bug in .github/workflows/a.yml'), signal()]);
    s.coverageComplete = false;
    expect((await runFeedback({ ...options(), apply: true }, deps(s))).queued).toEqual([]);
    await utimes(join(root, 'feedback/cycle'), new Date(0), new Date(0));
    await mkdir(join(root, 'queue/prompts'), { recursive: true });
    await Promise.all(Array.from({ length: 40 }, (_, i) => writeFile(join(root, `queue/prompts/RQ-PHX-JOB${i}.md`), '')));
    expect((await runFeedback({ ...options(), apply: true }, deps())).queued).toEqual([]);
    const unavailable = { ...deps(), read: async () => { throw new Error('private failure'); } };
    expect((await runFeedback({ ...options(), apply: true }, unavailable)).errors).toContain('coverage-incomplete');
  });
  it('refuses a symlinked feedback store and preserves its target', async () => {
    const target = join(root, 'target'); await mkdir(target); await symlink(target, join(root, 'feedback'));
    expect((await runFeedback({ ...options(), apply: true }, deps())).queued).toEqual([]);
    expect(await readdir(target)).toEqual([]);
  });
  it('uses real bounded queue reads, prioritizes regressions and marks missing job history unknown', async () => {
    await mkdir(join(root, 'queue')); await writeFile(join(root, 'queue/router-queue.md'), ''); await writeFile(join(root, 'queue/ready.tsv'), '');
    const s = snapshot([...Array.from({ length: 6 }, (_, i) => signal(`Bug component ${i} crashes`)), signal('Regression: login stopped working')]);
    const d = { ingest: async () => s };
    const out = await runFeedback({ ...options(), apply: true }, d);
    expect(out.sources.queue).toBe('ok'); expect(out.candidates[0]?.kind).toBe('regression'); expect(out.queued).toHaveLength(5);
    const digest = await runFeedback({ ...options(), command: 'digest' }, d);
    expect(digest.sources.jobs).toBe('unavailable');
    expect('digest' in digest && digest.digest).toMatchObject({ needsReview: null, failures: null, stillRunning: null });
  });
  it('folds unordered outcomes without calling a finished job shipped or alive', () => {
    const s = snapshot(); s.shipped = [{ ref: `${url}/pull/3`, at: now - 1000 }, { ref: `${url}/pull/4`, at: now - 86400000 }];
    const ledger = [
      { job: 'DONE', event: 'finish', ts: now, exit_code: 0 }, { job: 'DONE', event: 'launch', ts: now - 5000 },
      { job: 'FAIL', event: 'finish', ts: now, exit_code: 1 }, { job: 'LIVE', event: 'launch', ts: now - 86400000 },
      { job: 'MERGED', event: 'outcome', outcome: 'MERGED', ts: now },
    ].map(r => JSON.stringify({ ...r, repo: 'phantom' })).join('\n');
    expect(feedbackDigest(s, ledger + '\ninvalid', now)).toMatchObject({ shipped: [`${url}/pull/3`], needsReview: ['DONE'], failures: ['FAIL'], stillRunning: ['LIVE'], invalidRows: 1 });
    const partial = [
      { job: 'DONE', event: 'finish', ts: now, exit_code: 1 }, { job: 'DONE', event: 'launch', ts: now, repo: 'phantom' },
      { event: 'outcome', url: `${url}/pull/3`, state: 'MERGED', ts: now }, { job: 'DONE', event: 'publish', url: `${url}/pull/3`, ts: now - 1 },
    ].map(r => JSON.stringify(r)).join('\n');
    expect(feedbackDigest(s, partial, now)).toMatchObject({ needsReview: [], failures: [], stillRunning: [] });
  });
  it('CLI validates before calling dependencies and emits bounded operational errors', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = vi.fn(runFeedback);
    for (const args of [['digest', '--apply'], ['scan', '--days', '0'], ['scan', '--runs-dir', 'relative'], ['scan', '--json', '--json'], ['scan', '--merge']]) expect(await cmdFleetFeedback(args, { run })).toBe(2);
    expect(run).not.toHaveBeenCalled();
    run.mockImplementation(opts => runFeedback({ ...opts, runsDir: root }, deps()));
    expect(await cmdFleetFeedback(['scan', '--json'], { run })).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ schema: 'fleet.feedback.v1', applied: false });
    run.mockRejectedValue(new Error('private text')); expect(await cmdFleetFeedback(['scan'], { run })).toBe(1);
    expect(log.mock.calls.at(-1)![0]).not.toContain('private text');
  });
});
