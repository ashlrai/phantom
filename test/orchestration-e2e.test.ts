/** Real queue/bus/proof/learning stores; model and Slack are fake transports.
 * The explicit supervisor section models the still-absent execution/publication handoff.
 * This proves component compatibility, not unattended production closure. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPeerInbox, type PeerBusOptions } from '../src/core/agentnet/peer-bus.js';
import { consumePeerWork } from '../src/core/agentnet/work-dispatch.js';
import { workPostBodySchema, workResultBodySchema } from '../src/core/agents/bus-v2-schema.js';
import { readBusWorkFeed } from '../src/core/agents/bus-work-feed-read.js';
import { cosStatus, queueCosEnvelope } from '../src/core/cos/intake.js';
import { runCosLoop } from '../src/core/cos/loop.js';
import { emitCosPeerPlanOnce, type CosPeerPlan } from '../src/core/cos/peer-plan.js';
import { runCosWorkOnce } from '../src/core/cos/worker.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { buildFleetEvalReport } from '../src/core/fleet/eval-report.js';
import { journalSchema } from '../src/core/fleet/orchestration-journal.js';
import type { SpawnedPlannerProcess, SpawnLike } from '../src/core/fleet/planner-run.js';
import { capturePublishProof } from '../src/core/fleet/proof-capture.js';
import { verifyProofResult } from '../src/core/fleet/proof-envelope.js';
import { buildProofOutcomeReport } from '../src/core/fleet/proof-outcome-join.js';
import { listSkills } from '../src/core/fleet/skill-list.js';
import { nudgeSkillsFromJobs } from '../src/core/fleet/skill-nudge.js';
import { QueueStore } from '../src/core/queue/store.js';

let root: string, now: number, store: QueueStore, options: PeerBusOptions;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const session = (n: number) => ({ lane: `lane-${n}`, sessionId: `session-${n}`, token: `synthetic-session-${n}-` + 'a'.repeat(32) });
const write = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value), { mode: 0o600 });
const work = () => workPostBodySchema.parse({ kind: 'work.post', jobId: 'RQ-ORCH-FIX', title: 'Fix spelling',
  repo: 'ashlrai/phantom', claimKeys: ['queue:RQ-ORCH-FIX', 'path:ashlrai/phantom:docs/AGENT-BUS.md'],
  dispatch: { tier: 'fast', scope: 'Correct the spelling in docs/AGENT-BUS.md.', acceptance: 'The spelling check passes.' } });
const plan = (): CosPeerPlan => ({ reply: 'Proposing the spelling fix to agent1.',
  peers: [{ toAgent: 'agent1', kind: 'task', text: 'Check the bus guide spelling.', refs: [], work: work() }] });
const journal = () => journalSchema.parse(JSON.parse(readFileSync(join(root, 'specialists/orchestration.json'), 'utf8')));
const results = () => {
  const page = listBusInboxAfter(0, 100, { root, now: () => now });
  if (page.status !== 'ok') throw new Error('Fixture bus unavailable');
  return page.messages.flatMap(m => {
    const parsed = workResultBodySchema.safeParse(m.envelope.body);
    return parsed.success ? [parsed.data] : [];
  });
};
function runner(reply: CosPeerPlan, prompts: string[]): SpawnLike {
  return () => {
    const events = new EventEmitter(), stdin = new PassThrough(), stdout = new PassThrough();
    let prompt = '';
    stdin.on('data', chunk => { prompt += String(chunk); });
    const child = { stdin, stdout, stderr: new PassThrough(), kill: () => true,
      on: (event: string, listener: (...args: never[]) => void) => { events.on(event, listener); return child; },
      once: (event: string, listener: (...args: never[]) => void) => { events.once(event, listener); return child; },
    } as unknown as SpawnedPlannerProcess;
    stdin.on('finish', () => {
      prompts.push(prompt);
      stdout.end(JSON.stringify(reply));
      stdout.once('end', () => setImmediate(() => events.emit('close', 0, null)));
    });
    return child;
  };
}
async function intake(reply = plan(), apply = true) {
  const id = await queueCosEnvelope({ channel: 'cli', verifiedSenderId: 'local-owner', body: 'Correct the bus guide spelling.',
    receivedAt: new Date(now).toISOString(), dedupeKey: 'b'.repeat(64) }, root);
  const prompts: string[] = [];
  const summary = await runCosLoop({ durationMs: 60_000, maxPasses: 2, runsDir: root, now: () => now,
    peerPlan: { session: session(0), options, apply, directory: join(root, 'specialists') },
    work: opts => runCosWorkOnce({ ...opts, home: root, fleetFacts: async () => null,
      candidates: [{ provider: 'fixture', argv: ['fixture-runner'] }], spawn: runner(reply, prompts) }),
    sleep: async () => {},
  });
  expect(summary).toMatchObject({ drafted: 1, idle: 1, blocked: 0, errors: 0 });
  expect(await cosStatus(id, root)).toMatchObject({ job: { status: 'DONE' }, draft: { text: reply.reply }, needsYou: true });
  return { id, prompts };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orch-e2e-'))); now = Date.now();
  vi.stubEnv('HOME', root); vi.stubEnv('ASHLR_HOME', join(root, '.ashlr')); vi.stubEnv('ASHLR_RUNS_DIR', root);
  mkdirSync(join(root, '.ashlr'), { mode: 0o700 });
  write('bindings.json', { version: 1, peers: [0, 1].map(n => ({ callsign: `agent${n}`,
    lane: session(n).lane, sessionId: session(n).sessionId, sessionHash: hash([session(n).lane, session(n).sessionId, session(n).token]),
    expiresAt: now + 3_600_000, teamId: 'TTEAM', userId: `UAGENT${n}`, botId: `BAGENT${n}`, topic: 'mesh' })) });
  write('dispatch.json', { version: 1, enabled: true, peers: ['agent0', 'agent1'],
    repositories: [{ repo: 'ashlrai/phantom', tierCeiling: 'fast', paths: ['docs/AGENT-BUS.md'] }] });
  writeFileSync(join(root, '.ashlr/comms.toml'), 'confirmedByMason = true\n', { mode: 0o600 });
  writeFileSync(join(root, '.ashlr/agent-network.toml'),
    '[team]\nidentities = [{channel="bus",id="agent0"},{channel="bus",id="agent1"}]\n', { mode: 0o600 });
  options = { bindings: join(root, 'bindings.json'), busRoot: root, runsDir: root, now: () => now,
    readPolicy: () => ({ config: { bridgeId: 'slack', teamId: 'TTEAM', ownUserId: 'UAGENT0', ownBotId: 'BAGENT0',
      botTokenRef: 'phm_TEST_TOKEN', map: [{ topic: 'mesh', channel: 'CMESH' }] }, confirmedByMason: false,
    teamIdentities: [0, 1].map(n => ({ channel: 'slack', id: `UAGENT${n}` })) }),
    call: async (method, args) => {
      if (method === 'conversations.info') return { channel: { id: 'CMESH', is_channel: true, is_shared: false,
        is_ext_shared: false, is_pending_ext_shared: false, context_team_id: 'TTEAM' } };
      if (method === 'conversations.members') return { members: ['UAGENT0', 'UAGENT1'] };
      if (method === 'users.info') return { user: { id: args?.user, team_id: 'TTEAM', is_bot: true } };
      throw new Error('Unexpected transport call');
    },
  };
  store = new QueueStore(join(root, 'queue'));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('orchestration integration with an explicit supervisor fixture', () => {
  it('describes the typed work handoff in the actual CoS runner prompt', async () => {
    const { prompts } = await intake();
    expect(prompts).toHaveLength(1);
    for (const field of ['work.post', 'jobId', 'claimKeys', 'dispatch', 'acceptance', 'queue:', 'path:']) {
      expect(prompts[0]).toContain(field);
    }
  });

  it('carries one intake through authenticated work, claims, results, captured proof, evaluation and shadow skills', async () => {
    const { id } = await intake();
    const [receipt] = journal().receipts;
    expect(receipt).toMatchObject({ job: id, status: 'complete' });
    expect(receipt!.peerMessages).toHaveLength(1);
    const inbox = readPeerInbox(session(1), 0, options);
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]!.envelope.id).toBe(receipt!.peerMessages![0]);
    expect(inbox.messages[0]!.envelope.body).toEqual(work());
    expect(readBusWorkFeed({ root, now: () => now })).toMatchObject({ status: 'refused', reason: 'missing-provider' });
    expect(await consumePeerWork(session(1), {}, options)).toMatchObject({ dryRun: true, results: [{ status: 'proposed' }] });
    expect((await store.read()).jobs).toHaveLength(1);
    const admitted = await consumePeerWork(session(1), { apply: true }, options);
    expect(admitted.results).toMatchObject([{ status: 'admitted' }]);
    const queueId = admitted.results[0]!.queueId!;
    const claimed = (await store.read()).jobs.find(j => j.id === queueId)!;
    expect(claimed).toMatchObject({ status: 'CLAIMED', exclusive: true, claims: [{ owner: 'peer:agent0' }] });
    expect(results().map(r => r.outcome)).toEqual(['reserved', 'admitted']);
    expect(existsSync(join(root, 'results'))).toBe(false); // No executor/publisher hook in dispatch.

    // Explicit trusted-supervisor fixture: execute in disposable Git, retry a real
    // failed checker, finish with the recorded claim owner, then capture the staged diff.
    const repo = join(root, 'repo'); mkdirSync(join(repo, 'docs'), { recursive: true });
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture',
      '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
    git('init', '-q'); writeFileSync(join(repo, 'docs/AGENT-BUS.md'), 'Typoo\n'); git('add', '.'); git('commit', '-qm', 'fixture base');
    const base = git('rev-parse', 'HEAD');
    const check = () => spawnSync(process.execPath, ['-e',
      "require('node:assert/strict').equal(require('node:fs').readFileSync('docs/AGENT-BUS.md','utf8'),'Typo\\n'); console.log('spelling passed')"],
    { cwd: repo, encoding: 'utf8', timeout: 10_000 });
    expect(check().status).toBe(1);
    writeFileSync(join(repo, 'docs/AGENT-BUS.md'), 'Typo\n'); git('add', '.');
    const checked = check(); expect(checked.status).toBe(0);
    await store.finish(queueId, claimed.claims[0]!.owner, {});
    await consumePeerWork(session(1), { apply: true }, options);
    expect(results().map(r => r.outcome)).toEqual(['reserved', 'admitted', 'complete']);
    expect(results().every(r => r.jobId === work().jobId && r.queueId === queueId)).toBe(true);
    // The dispatch journal admits the latest work.result outcome to the posting peer.
    const returned = readPeerInbox(session(0), 0, options);
    if (returned.status !== 'ok') throw new Error('fixture inbox unavailable');
    expect(returned.workResults).toBe('available');
    expect(returned.messages).toHaveLength(1);
    expect(workResultBodySchema.parse(returned.messages[0]!.envelope.body).outcome).toBe('complete');

    const output = join(root, 'results'), log = join(root, 'checker.log');
    writeFileSync(log, checked.stdout + checked.stderr);
    const proof = capturePublishProof({ repo, gitDir: join(repo, '.git'), layout: 'repo', base,
      output: join(output, `${queueId}.proof.json`), test: { cmd: 'fixture spelling check', exitCode: checked.status!, log } });
    const publish = join(output, `${queueId}.publish`), url = 'https://github.com/ashlrai/phantom/pull/42';
    writeFileSync(publish, `PROOF ${proof.file} sha256:${proof.sha256}\nRESULT PR ${url}\n`);
    expect(verifyProofResult(publish).flags).toEqual(['Risk tier requires reviewer classification']);
    // Mock publication/merge metadata is supplied by the supervisor, not inferred from DONE.
    const ts = new Date(now).toISOString();
    const report = buildFleetEvalReport({ nowMs: now + 1, jobsText: [
      { event: 'launch', job: queueId, repo: 'phantom', lane: 'lane-1', tier: 'fast', ts },
      { event: 'finish', job: queueId, exit_code: checked.status, ts },
      { event: 'publish', job: queueId, url, ts },
      { event: 'outcome', job: queueId, url, state: 'MERGED', mergedAt: ts, ts },
    ].map(row => JSON.stringify(row)).join('\n') });
    const joined = buildProofOutcomeReport(report, output);
    expect(joined.pullRequests).toMatchObject([{ jobId: queueId, proofId: `sha256:${proof.sha256}`,
      proofState: 'needs-review', durability: 'pending', diffStats: { files: 1, added: 1, removed: 1 },
      verification: { commands: 1, failed: 0 }, predicted: null }]);
    expect(listSkills().total).toBe(0); // Proof reports do not write verified skills.
    const recovery = { id: queueId, lane: 'lane-1', outcome: 'merged' as const, retries: 1 };
    const cards = nudgeSkillsFromJobs([recovery], ts);
    expect(cards).toMatchObject([{ status: 'candidate', sourceJobIds: [queueId], verification: { passed: false } }]);
    expect(listSkills()).toMatchObject({ total: 1, skills: [{ status: 'candidate', verificationPassed: false, attestationPresent: false }] });

    expect(await emitCosPeerPlanOnce(plan(), id, { session: session(0), options, apply: true,
      directory: join(root, 'specialists') })).toMatchObject({ status: 'duplicate' });
    expect(await consumePeerWork(session(1), { apply: true }, options)).toMatchObject({ results: [{ status: 'duplicate' }] });
    expect((await store.read()).jobs).toHaveLength(2); expect(results()).toHaveLength(3);
    expect(nudgeSkillsFromJobs([recovery], ts)).toEqual([]);
    writeFileSync(join(output, `${proof.file}.test.log`), 'tampered');
    expect(verifyProofResult(publish).ok).toBe(false);
    expect(buildProofOutcomeReport(report, output).pullRequests[0]!.flags).toBeGreaterThan(joined.pullRequests[0]!.flags!);
  });

  it('exposes the separate Bus v2 projection without treating dispatch results as owner status', async () => {
    const reply = plan(); reply.peers[0]!.work!.provider = 'codex-personal';
    await intake(reply);
    const admitted = await consumePeerWork(session(1), { apply: true }, options);
    expect(admitted.results).toMatchObject([{ status: 'admitted' }]);
    await store.finish(admitted.results[0]!.queueId!, 'peer:agent0', {});
    await consumePeerWork(session(1), { apply: true }, options);
    expect(results().at(-1)!.outcome).toBe('complete');
    // work.result is not work.status: this read-only projection still shows queued.
    expect(readBusWorkFeed({ root, now: () => now })).toMatchObject({ status: 'ok', jobs: [
      { id: work().jobId, owner: 'agent0', provider: 'codex-personal', status: 'queued' },
    ] });
  });

  it.each(['dry-run', 'prose', 'policy', 'kill', 'paths'] as const)('preserves the %s admission boundary across CoS and dispatch', async gate => {
    const reply = plan();
    if (gate === 'prose') delete reply.peers[0]!.work;
    if (gate === 'paths') reply.peers[0]!.work!.claimKeys = ['queue:RQ-ORCH-FIX', 'path:ashlrai/phantom:src/core/cos/worker.ts'];
    await intake(reply, gate !== 'dry-run');
    if (gate === 'policy') rmSync(join(root, 'dispatch.json'));
    if (gate === 'kill') writeFileSync(join(root, '.ashlr/KILL'), 'halt');
    const result = await consumePeerWork(session(1), { apply: true }, options);
    expect((await store.read()).jobs).toHaveLength(1);
    if (gate === 'paths') expect(result.results).toMatchObject([{ status: 'failed', reason: 'paths-not-allowed' }]);
    else expect(results()).toEqual([]);
    if (gate === 'dry-run') expect(existsSync(join(root, 'specialists/orchestration.json'))).toBe(false);
  });
});
