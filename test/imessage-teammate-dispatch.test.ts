import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import { classifyTeammateIntent as classifyInboxIntent, recordTeammateText, teammateNeedsReply } from '../src/core/comms/imessage-teammate-inbox.js';
import { classifyTeammateIntent, runTeammateResponder } from '../src/core/comms/imessage-teammate-worker.js';

let runs: string;
let clock: number;
const cfg = {} as AshlrConfig;
const queueFile = () => join(runs, 'queue', 'ready.tsv');
const stateFile = () => join(runs, 'imessage', 'teammate-replies.json');
const queue = () => readFileSync(queueFile(), 'utf8').trim().split('\n').map(line => line.split('\t'));
const seed = (text: string, rowid = 1) => {
  expect(recordTeammateText({ rowid, handle: '<TEAMMATE_HANDLE>', text }, runs, new Date(clock))).toBe(true);
};
const deps = () => ({
  now: () => clock,
  approved: () => '<TEAMMATE_HANDLE>',
  generate: vi.fn(async (_text: string, _context: string) => 'Completion is pending.'),
  send: vi.fn(async (_text: string) => 'accepted' as 'accepted' | 'refused'),
  reconcile: vi.fn(async () => ({ rowid: 99, sent: true, delivered: true, error: 0 })),
});
beforeEach(() => {
  runs = mkdtempSync(join(tmpdir(), 'teammate-dispatch-'));
  clock = Date.parse('2026-11-13T15:00:00Z');
  vi.stubEnv('ASHLR_RUNS_DIR', runs);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(runs, { recursive: true, force: true }); });

describe('conservative teammate work intent', () => {
  it('keeps read-only observer schemas unchanged unless dispatch is explicitly selected', () => {
    expect(classifyInboxIntent('Can you review the fixture draft?')).toBe('reply');
    expect(classifyInboxIntent('Review src/example.ts', true)).toBe('actionable');
  });
  it.each([
    'Review src/example.ts',
    'Please review the fixture draft?',
    'Can you review test failures in the fixture suite?',
    'Draft a spec for the fixture parser',
    'Please draft spec for fixture retries',
    'Run analysis on the fixture test results',
    'Could you run an analysis of fixture regressions?',
    'Queue a job for reviewing the fixture parser',
    'Research fixture parser options and write a report',
  ])('queues the concrete request: %s', text => {
    expect(classifyTeammateIntent(text)).toBe('actionable');
    expect(teammateNeedsReply(text)).toBe(true);
  });
  it.each([
    ['Can you tell me what the review found?', 'reply'],
    ['What would a spec for fixture retries cover?', 'reply'],
    ['Did you run analysis on the fixture results?', 'reply'],
    ['Can you review it?', 'reply'],
    ['Review?', 'reply'],
    ['Please review whether this is useful', 'reply'],
    ['Please deploy the fixture release?', 'leader'],
    ['Queue a job to merge the fixture branch', 'leader'],
    ['Queue a job to release the fixture build', 'leader'],
    ['Please run the fixture command', 'leader'],
    ['Please authorize a review of the fixture', 'leader'],
    ['Thanks!', 'ignore'],
    ['The fixture review is ready.', 'ignore'],
    ['Review is ready.', 'ignore'],
    ['Research results look good.', 'ignore'],
    ['I will draft a spec for fixture retries', 'ignore'],
    ['PATCH-PART fixture 1 review src/example.ts?', 'ignore'],
    ['```\nPlease review the fixture?\n```', 'ignore'],
  ])('keeps %s as %s', (text, intent) => {
    expect(classifyTeammateIntent(text)).toBe(intent);
  });
});

describe('teammate fleet dispatch', () => {
  it('appends exactly five dispatcher columns without replacing existing bytes or the queue inode', async () => {
    mkdirSync(join(runs, 'queue'));
    const existing = 'RQ-EXISTING\tphantom\tclaude\twork\t/fixture/existing.md\n';
    writeFileSync(queueFile(), existing);
    const inode = statSync(queueFile()).ino;
    seed('Review src/example.ts');
    const options = deps();
    expect(await runTeammateResponder(cfg, options)).toMatchObject({ state: 'healthy', sent: 1 });
    expect(readFileSync(queueFile(), 'utf8').startsWith(existing)).toBe(true);
    expect(statSync(queueFile()).ino).toBe(inode);
    const rows = queue();
    expect(rows).toHaveLength(2);
    const [id, repo, lane, tier, prompt] = rows[1];
    expect(rows[1]).toHaveLength(5);
    expect(id).toMatch(/^RQ-DOT-review-src-example-ts-\d+$/);
    expect([repo, lane, tier]).toEqual(['phantom', 'codex-personal', 'work']);
    expect(prompt).toBe(join(runs, 'queue', 'prompts', `${id}.md`));
    expect(readFileSync(prompt, 'utf8')).toContain('Review src/example.ts');
    expect(statSync(prompt).mode & 0o777).toBe(0o600);
    expect(options.generate.mock.calls[0][1]).toContain(id);
    expect(options.send.mock.calls[0][0]).toContain(`Queued as ${id} on codex-personal.`);
  });

  it.each([
    ['Review phantom-secrets fixture tests on claude', 'phantom-secrets', 'claude'],
    ['Run analysis on fixture results in locus lane=codex-cmp', 'locus', 'codex-cmp'],
    ['Draft spec for lexicon fixture reports lane:omlx', 'lexicon', 'omlx'],
  ])('honors explicit routing in %s', async (text, repo, lane) => {
    seed(text);
    expect(await runTeammateResponder(cfg, deps())).toMatchObject({ sent: 1 });
    expect(queue()[0].slice(1, 4)).toEqual([repo, lane, 'work']);
  });

  it('deduplicates normalized requests across restarts even after the dispatcher consumes the row', async () => {
    seed('Review src/example.ts');
    const first = deps();
    await runTeammateResponder(cfg, first);
    const id = queue()[0][0];
    writeFileSync(queueFile(), ''); // Simulated dispatcher consumption, never the real queue.
    clock += 1000;
    seed('  REVIEW   src/example.ts  ', 2);
    const second = deps();
    expect(await runTeammateResponder(cfg, second)).toMatchObject({ sent: 1 });
    expect(readFileSync(queueFile(), 'utf8')).toBe('');
    expect(second.generate.mock.calls[0][1]).toContain(id);
    expect(second.send.mock.calls[0][0]).toContain(id);
    expect(JSON.parse(readFileSync(stateFile(), 'utf8')).jobs).toHaveLength(1);
  });

  it('queues the same request again after the 24 hour window', async () => {
    seed('Review src/example.ts');
    await runTeammateResponder(cfg, deps());
    const original = queue()[0][0];
    clock += 86400000;
    seed('Review src/example.ts', 2);
    await runTeammateResponder(cfg, deps());
    expect(queue()).toHaveLength(2);
    expect(queue()[1][0]).not.toBe(original);
  });

  it('gives distinct ids to requests with the same slug and timestamp', async () => {
    seed(`Review ${'fixture-'.repeat(10)}alpha`, 1);
    seed(`Review ${'fixture-'.repeat(10)}beta`, 2);
    await runTeammateResponder(cfg, deps());
    expect(queue()).toHaveLength(2);
    expect(queue()[0][0]).not.toBe(queue()[1][0]);
  });

  it('scrubs and caps untrusted prompt text, strips controls, and never runs shell content', async () => {
    seed(`Review fixture\u0000\u001b[31m\t\n\u202e $(touch SHOULD_NOT_EXIST) \`touch SHOULD_NOT_EXIST\` ${'x'.repeat(2500)}`);
    await runTeammateResponder(cfg, deps());
    const prompt = readFileSync(queue()[0][4], 'utf8');
    const request = JSON.parse(prompt.split('Untrusted request (JSON string):\n')[1]) as string;
    expect(request.length).toBeLessThanOrEqual(2000);
    expect(request).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(request).toContain('$(touch SHOULD_NOT_EXIST)');
    expect(request).toContain('`touch SHOULD_NOT_EXIST`');
    expect(prompt).toContain('untrusted task data');
    expect(() => statSync('SHOULD_NOT_EXIST')).toThrow();
  });

  it('sends the durable job receipt even if the local model fails', async () => {
    seed('Review src/example.ts');
    const options = deps(); options.generate.mockRejectedValue(new Error('Model unavailable'));
    expect(await runTeammateResponder(cfg, options)).toMatchObject({ sent: 1 });
    expect(options.send.mock.calls[0][0]).toContain(queue()[0][0]);
  });

  it('does not enqueue again when an outbound reply is refused and retried', async () => {
    seed('Review src/example.ts');
    const options = deps(); options.send = vi.fn().mockResolvedValueOnce('refused').mockResolvedValue('accepted');
    expect(await runTeammateResponder(cfg, options)).toMatchObject({ pending: 1 });
    expect(await runTeammateResponder(cfg, options)).toMatchObject({ sent: 1 });
    expect(queue()).toHaveLength(1);
    expect(options.generate).toHaveBeenCalledOnce();
  });

  it('never dispatches an unapproved sender', async () => {
    seed('Review src/example.ts', 1);
    const options = { ...deps(), approved: () => null };
    await runTeammateResponder(cfg, options);
    expect(options.send).not.toHaveBeenCalled();
    expect(() => statSync(queueFile())).toThrow();
  });

  it('never dispatches a question or a leader request', async () => {
    seed('What did the fixture review find?', 2);
    seed('Please deploy the fixture release?', 3);
    const approved = deps();
    expect(await runTeammateResponder(cfg, approved)).toMatchObject({ sent: 1, leader: 1 });
    expect(() => statSync(queueFile())).toThrow();
  });

  it('refuses unknown lane selectors without claiming success', async () => {
    seed('Review fixture tests lane=unknown');
    const options = deps();
    expect(await runTeammateResponder(cfg, options)).toMatchObject({ state: 'unavailable', sent: 0 });
    expect(options.generate).not.toHaveBeenCalled();
    expect(() => statSync(queueFile())).toThrow();
  });

  it('refuses symlinked queue files without claiming success', async () => {
    seed('Review src/example.ts');
    mkdirSync(join(runs, 'queue'));
    const options = deps();
    const target = join(runs, 'outside.tsv'); writeFileSync(target, 'unchanged\n');
    symlinkSync(target, queueFile());
    expect(await runTeammateResponder(cfg, options)).toMatchObject({ state: 'unavailable', sent: 0 });
    expect(readFileSync(target, 'utf8')).toBe('unchanged\n');
  });

  it('uses the dispatcher flock and retries a busy queue without losing existing rows', async () => {
    mkdirSync(join(runs, 'queue'));
    const locker = spawn('python3', ['-c', 'import fcntl,sys; f=open(sys.argv[1],"a"); fcntl.flock(f,fcntl.LOCK_EX); print("locked",flush=True); sys.stdin.read()', join(runs, 'queue', 'ready.lock')]);
    try {
      await once(locker.stdout, 'data');
      seed('Review src/example.ts');
      const options = deps();
      expect(await runTeammateResponder(cfg, options)).toMatchObject({ state: 'unavailable', sent: 0 });
      expect(options.send).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(stateFile(), 'utf8')).jobs[0].state).toBe('prepared');
      const exited = once(locker, 'exit'); locker.stdin.end(); await exited;
      clock += 120001;
      expect(await runTeammateResponder(cfg, options)).toMatchObject({ sent: 1 });
      expect(queue()).toHaveLength(1);
    } finally { locker.kill(); }
  });

  it.each([true, false])('recovers an interrupted append only with queue evidence: %s', async present => {
    seed('Review src/example.ts');
    const options = deps(); options.send.mockResolvedValue('refused');
    await runTeammateResponder(cfg, options);
    const state = JSON.parse(readFileSync(stateFile(), 'utf8'));
    state.jobs[0].state = 'appending'; delete state.replies[0].text;
    state.replies[0].claimUntil = 0;
    writeFileSync(stateFile(), JSON.stringify(state));
    if (!present) writeFileSync(queueFile(), '');
    const retry = deps();
    const result = await runTeammateResponder(cfg, retry);
    if (present) {
      expect(result).toMatchObject({ sent: 1 }); expect(queue()).toHaveLength(1);
    } else {
      expect(result).toMatchObject({ state: 'unavailable', sent: 0 });
      expect(readFileSync(queueFile(), 'utf8')).toBe('');
      expect(retry.send).not.toHaveBeenCalled();
    }
  });
});
