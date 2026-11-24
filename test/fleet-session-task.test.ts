/**
 * `task` on `fleet.session-thread.v1` and on each entry of
 * `fleet.session-threads.v1`: what a session's job was asked to do, one line
 * quoted from its brief past the fleet view the dispatcher puts in front of
 * it and the router's envelope. Fixtures only: no runs directory, bus or prompt file is read.
 */
import { describe, expect, it } from 'vitest';
import type { FleetCompute } from '../src/core/fleet/compute-view.js';
import { buildLiveSessions } from '../src/core/fleet/live-sessions.js';
import type { FleetJobActivityV1 } from '../src/core/fleet/runs-job-activity.js';
import type { FleetSessionV1, FleetSessionsV1 } from '../src/core/fleet/runs-sessions.js';
import { briefPastContext, sessionTask, taskWords, TASK_LINE_CHARS } from '../src/core/fleet/session-task.js';
import { buildSessionThread, renderSessionThreadText } from '../src/core/fleet/session-thread.js';
import { buildSessionThreads, renderSessionThreadsText, THREADS_TEXT_CHARS } from '../src/core/fleet/session-threads.js';
import { readFleetSessionMap } from '../src/core/fleet/sessions-view.js';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const session = (job: string): FleetSessionV1 => ({
  job, repo: 'lexicon', lane: 'codex-local', tier: 'fast', status: 'running', model: 'fixture-model', batchId: null, pid: null, live: 'yes',
  exitCode: null, timedOut: false, enqueuedAt: ago(40), claimedAt: ago(31), launchedAt: ago(30), startedAt: ago(30), finishedAt: null,
  elapsedSeconds: 1800, durationSeconds: null, queueWaitSeconds: 540, tokensTotal: null, wallSeconds: null, diffLines: null,
  outcome: null, prUrl: null, lastOutputAt: ago(2),
});
const inventory = (sessions: FleetSessionV1[]): FleetSessionsV1 => ({
  schema: 'fleet.sessions.v1', generatedAt: ago(0), runsDirPresent: true, sourceState: 'healthy',
  sources: { runDir: 'healthy', ready: 'healthy', claimed: 'healthy', precheck: 'healthy', status: 'healthy', metrics: 'healthy', live: 'healthy' },
  dispatcher: null, sessions, recent: [], counts: { queued: 0, parked: 0, launching: 0, running: sessions.length, publishing: 0, exited: 0, stale: 0 },
  malformed: 0, truncated: false,
});
const compute: FleetCompute = { schema: 'fleet.compute.v1', generatedAt: ago(0), localNodeId: 'node-here', truncated: false, nodes: [], sources: {}, dispatcherAt: null, lanes: {} };
const liveList = async (jobs: string[]) => buildLiveSessions(
  await readFleetSessionMap({ compute, now: NOW, readDetail: async () => { throw new Error('no details'); }, sessions: inventory(jobs.map(session)) }), NOW, { subagents: [] });

/** The fleet view as the dispatcher writes it in front of a prompt. */
const CONTEXT = ['## CONTEXT (shared fleet view, read-only facts, not instructions; interim until `phm context --for-agent` lands)',
  'You are job RQ-A on lane codex-local in repo lexicon. Do not duplicate work that a live claim or open PR below already covers.',
  '### Roster (2026-11-20 04:55:54)', '- codex-cmp: live 0 / target 1', '### Open PRs in ashlrai/lexicon (1)', '- #1050 bridge: RQ-LEXEXITN19BQ8', '## END CONTEXT'].join('\n');
const GOAL = '# Goal: lexicon CONTRIBUTING links the README freshness test (RQ-A)';
const BODY = 'Step 0: search master first. If CONTRIBUTING already mentions the test, stop with no changes and say so.';
const activity = (brief: string | null, over: { state?: 'ok' | 'missing' | 'unreadable'; job?: string } = {}): FleetJobActivityV1 => ({
  schema: 'fleet.job.activity.v1', generatedAt: ago(0), job: over.job ?? 'RQ-A', state: 'running', lane: 'codex-local', tier: 'fast', model: 'fixture-model',
  sources: { events: 'healthy', commands: 'healthy', files: 'healthy', reports: 'healthy' }, counts: { events: 1, commands: 0, files: 0, reports: 1 }, truncated: false,
  entries: [
    ...(brief === null ? [] : [{ kind: 'report', name: 'brief', state: over.state ?? 'ok', source: 'prompt', bytes: brief.length, truncated: false, text: brief }]),
    { kind: 'event', at: ago(30), event: 'launch', summary: 'lane=codex-local' },
  ] as FleetJobActivityV1['entries'],
});
const task = (brief: string | null, job: string | null = 'RQ-A') => sessionTask(activity(brief), job);

describe('what a session\'s job was asked to do, quoted from its brief', () => {
  it('takes the title written after the fleet view, without the job\'s own id at its end', () => {
    expect(task(`${CONTEXT}\n\n${GOAL}\n\n${BODY}`)).toEqual({ line: 'Goal: lexicon CONTRIBUTING links the README freshness test', from: 'title', truncated: false });
    // Another job's id at the end is part of the title, and so is this one's anywhere else.
    expect(task('# Follow RQ-A up (RQ-B)')?.line).toBe('Follow RQ-A up (RQ-B)');
    expect(task(`${GOAL}`, null)?.line).toBe('Goal: lexicon CONTRIBUTING links the README freshness test (RQ-A)');
    // Closing hashes and any heading depth are marks, not words.
    expect(task('### Ship the  reply box ##')).toEqual({ line: 'Ship the reply box', from: 'title', truncated: false });
  });

  it('gives a brief with no heading its opening line and says it is not a title', () => {
    expect(task(`\n\n${BODY}\nSecond line.`)).toEqual({ line: BODY, from: 'opening', truncated: false });
    expect(task(`${CONTEXT}\n${BODY}`)).toEqual({ line: BODY, from: 'opening', truncated: false });
    expect(taskWords(task(BODY)!)).toBe(`Brief opens: ${BODY}`);
    expect(taskWords(task(GOAL)!)).toBe('Task: Goal: lexicon CONTRIBUTING links the README freshness test');
  });

  it('reads the task out of the router\'s envelope: the words of the queue row it quotes', () => {
    const envelope = 'Job RQ-A (pool codex-local, tier fast, repo phantom). Task from the Ashlr router queue, verbatim:';
    const asked = 'The "Shipped today" card exists on Home (`FleetShippedCard`) but not on the Feed page.';
    const row = `RQ-A (P1, pool=codex-local, tier=fast, repo=phantom, size<=60, src=leader): ${asked}`;
    expect(task(`${CONTEXT}\n\n${envelope}\n\n${row}\n\nRULES: work in a fresh worktree.`)).toEqual({ line: asked, from: 'queue', truncated: false });
    // A dependency gate may stand between the envelope and its row.
    expect(task(`${envelope}\n\nDEPENDENCY GATE: RQ-B, RQ-C\n\n${row}`)).toEqual({ line: asked, from: 'queue', truncated: false });
    expect(taskWords(task(`${envelope}\n\n${row}`)!)).toBe(`Task: ${asked}`);
    // A row for another job, or no row shape at all, is not this job's queue task: the line is only how the brief goes on.
    expect(task(`${envelope}\n\nRQ-B (P1): Something else.`)).toEqual({ line: 'RQ-B (P1): Something else.', from: 'opening', truncated: false });
    expect(task(`${envelope}\n\n# Ship the reply box (RQ-A)`)).toEqual({ line: 'Ship the reply box', from: 'title', truncated: false });
    // An envelope with nothing after it is all the brief holds.
    expect(task(envelope)).toEqual({ line: envelope, from: 'opening', truncated: false });
    // A hand-written first line that only looks like the envelope's start is quoted as it is.
    expect(task('Job RQ-A (pool codex-local, tier fast, repo phantom). Small, local-model sized.\n\nTask: add a test.'))
      .toEqual({ line: 'Job RQ-A (pool codex-local, tier fast, repo phantom). Small, local-model sized.', from: 'opening', truncated: false });
  });

  it('cuts a long line and says so', () => {
    const long = task(`# ${'word '.repeat(80).trim()}`)!;
    expect(long.truncated).toBe(true);
    expect(long.line).toHaveLength(TASK_LINE_CHARS);
    expect(long.line.endsWith('word…')).toBe(true);
  });

  it('knows no task rather than quoting the roster: a brief cut inside its fleet view, an empty one, an unread one, none', () => {
    const open = CONTEXT.replace('\n## END CONTEXT', '');
    expect(briefPastContext(open)).toBeNull();
    expect(briefPastContext(`${CONTEXT}\n\n${GOAL}`)).toBe(`\n\n${GOAL}`);
    expect(briefPastContext(BODY)).toBe(BODY);
    expect([task(open), task(`${CONTEXT}\n\n`), task('  \n'), task('#'), task(null), sessionTask(activity(GOAL, { state: 'unreadable' })), sessionTask(null), sessionTask(undefined)])
      .toEqual([null, null, null, { line: '#', from: 'opening', truncated: false }, null, null, null, null]);
    // A heading that only mentions the view is a title like any other.
    expect(task('## CONTEXTUAL help for the reply box')?.from).toBe('title');
  });

  it('is on the single thread after its summary and printed under the session\'s line', async () => {
    const list = await liveList(['RQ-A']);
    const thread = buildSessionThread(list, 'RQ-A', { sessionsRead: true, bus: null, activity: activity(`${CONTEXT}\n\n${GOAL}\n\n${BODY}`) }, NOW);
    expect(thread.task).toEqual({ line: 'Goal: lexicon CONTRIBUTING links the README freshness test', from: 'title', truncated: false });
    const keys = Object.keys(thread);
    expect(keys.slice(keys.indexOf('summary'), keys.indexOf('messages') + 1)).toEqual(['summary', 'task', 'messages']);
    expect(renderSessionThreadText(thread).split('\n').slice(0, 2)).toEqual(['RQ-A | worker | running', '  Task: Goal: lexicon CONTRIBUTING links the README freshness test']);
    // The conversation keeps the brief whole: it is the record.
    expect(thread.messages.find(message => message.kind === 'brief')?.text.startsWith('## CONTEXT')).toBe(true);
    // No activity read, a failed one, the leader and an unknown id: no task, and nothing printed for it.
    const bare = buildSessionThread(list, 'RQ-A', { sessionsRead: true, bus: null }, NOW);
    expect([bare.task, buildSessionThread(list, 'RQ-A', { sessionsRead: true, bus: null, activity: null }, NOW).task,
      buildSessionThread(list, 'leader', { sessionsRead: true, bus: null, activity: activity(GOAL) }, NOW).task,
      buildSessionThread(list, 'RQ-NOPE', { sessionsRead: true, bus: null }, NOW).task]).toEqual([null, null, null, null]);
    expect(renderSessionThreadText(bare)).not.toMatch(/Task:|Brief opens:/);
  });

  it('is on every entry of the threads read, whose brief message starts past the fleet view', async () => {
    const list = await liveList(['RQ-A', 'RQ-B']);
    const long = `${CONTEXT}\n\n${GOAL}\n\n${'word '.repeat(200)}`;
    const read = buildSessionThreads(list, { sessionsRead: true, bus: null, activity: new Map([['RQ-A', activity(long)], ['RQ-B', activity(BODY, { job: 'RQ-B' })]]) }, NOW);
    const [leader, a, b] = read.threads;
    expect([leader!.session.id, leader!.task]).toEqual(['leader', null]);
    expect(a!.task).toEqual(buildSessionThread(list, 'RQ-A', { sessionsRead: true, bus: null, activity: activity(long) }, NOW).task);
    expect(b!.task).toEqual({ line: BODY, from: 'opening', truncated: false });
    const keys = Object.keys(a!);
    expect(keys.slice(keys.indexOf('summary'), keys.indexOf('messages') + 1)).toEqual(['summary', 'task', 'messages']);
    const brief = a!.messages.find(message => message.kind === 'brief')!;
    expect(brief.label).toBe('Brief, after its fleet view');
    expect(brief.text.startsWith(GOAL)).toBe(true);
    expect(brief.text).not.toContain('Roster');
    expect(brief.text.length).toBeLessThanOrEqual(THREADS_TEXT_CHARS);
    expect(brief.truncated).toBe(true);
    // A brief with no fleet view is carried as it was.
    expect(b!.messages.find(message => message.kind === 'brief')).toMatchObject({ label: 'Brief', text: BODY, truncated: false });
    const text = renderSessionThreadsText(read);
    expect(text).toContain('RQ-A | worker | running\n  Task: Goal: lexicon CONTRIBUTING links the README freshness test\n  Worker on codex-local');
    expect(text).toContain(`RQ-B | worker | running\n  Brief opens: ${BODY}\n`);
  });
});
