/** One foreground Cortex assignment. Remote instructions never confer merge authority. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { inspectPrivateDirectory } from '../universe/artifacts.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { acquireProposalMutationLock, releaseProposalMutationLock, type ProposalMutationLock } from '../inbox/proposal-mutation-lock.js';
import { parseEngineeringAssignmentV1, type EngineeringAssignmentV1 } from './engineering-assignment.js';
import { assertNoCortexProjectConfig, cortexCodexConfig } from './codex-policy.js';
import { inspectCortexAdmission, withCortexForegroundAdmission, type CortexAdmissionToken } from './admission.js';
import type { AshlrConfig, Proposal, RunOptions, RunState } from '../types.js';

export { parseCortexBridgeConfig, readCortexBridgeConfig } from './config.js';
export type { CortexBridgeConfig } from './config.js';
import { parseCortexBridgeConfig, type CortexBridgeConfig } from './config.js';
export interface BridgeReceipt {
  protocol: 'ashlr-engineering-receipt/v1'; assignmentDigest: string; runId: string; sourceCommit: string;
  proposalId: string; proposalStatus: 'pending'; summary: string;
  changes: { files: number; lines: number };
  verification: { status: 'passed' | 'failed' | 'not_run'; commands: string[] };
  artifacts: Array<{ kind: 'diff' | 'proposal' | 'verification'; path: string; sha256: string }>;
}
type Json = Record<string, unknown>;
const record = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/.test(v);
const hash = (v: string): string => createHash('sha256').update(v).digest('hex');
const integer = (v: unknown, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= max;
function requireFact(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }

function git(path: string, args: string[]): string {
  return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function repositoryIdentity(remote: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(remote);
  return match?.[1]?.toLowerCase() ?? null;
}
export function matchCortexRepository(config: CortexBridgeConfig, assignment: EngineeringAssignmentV1): string {
  const name = `${assignment.repo.owner}/${assignment.repo.name}`;
  const row = config.repositories.find(v => v.repository === name && v.workstreams.includes(assignment.workstream));
  requireFact(row && assignment.organizationRef === config.organizationId && assignment.authority.requiredTenantRef === config.organizationId, 'Cortex tenant or repository not admitted');
  const path = realpathSync(row.path);
  const contains = (parent: string, child: string) => {
    const part = relative(parent, child); return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
  };
  requireFact(!contains(config.root, path) && !contains(path, config.root), 'Cortex records must be separate from execution repositories');
  requireFact(git(path, ['rev-parse', '--show-toplevel']) === path && git(path, ['rev-parse', 'HEAD']) === assignment.repo.sourceCommit &&
    repositoryIdentity(git(path, ['remote', 'get-url', 'origin'])) === name && !git(path, ['status', '--porcelain']), 'Cortex repository identity, source commit or clean state changed');
  // The shared delegation normalizer has a smaller path bound than the wire codec.
  requireFact(assignment.mission.allowedFiles.length <= 32 && assignment.mission.allowedFiles.every(v => v.length <= 220), 'Assignment exceeds local file-scope bounds');
  assertNoCortexProjectConfig(path);
  return path;
}

/** Gate the captured diff itself; prompt hints are never the write-scope proof. */
export function validateCortexProposalDiff(diff: string, assignment: EngineeringAssignmentV1): { files: number; lines: number } {
  requireFact(Buffer.byteLength(diff) <= 4 * 1024 * 1024, 'Cortex proposal diff exceeds byte bound');
  const stats = execFileSync('git', ['apply', '--numstat', '-z', '--'], { input: diff, encoding: 'utf8',
    timeout: 10_000, maxBuffer: 256 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  const rows = stats.split('\0'); requireFact(rows.pop() === '' && rows.length >= 1, 'Cortex proposal diff is empty');
  let lines = 0;
  for (const row of rows) {
    const match = /^(\d+)\t(\d+)\t([\x21-\x7e]+)$/.exec(row);
    requireFact(match, 'Cortex diff contains unsupported binary, rename or filename');
    lines += Number(match[1]) + Number(match[2]);
    const path = match[3]!; requireFact(!path.startsWith('/') && !path.split('/').some(v => v === '..' || v === '.git'), 'Cortex diff contains invalid path');
    requireFact(assignment.mission.allowedFiles.some(pattern => {
      const parts = pattern.split('/'); const actual = path.split('/');
      return parts.every((part, index) => {
        if (part === '**' && index === parts.length - 1) return true;
        if (part === '*') return actual[index] !== undefined;
        return part === actual[index];
      }) &&
        (parts.at(-1) === '**' ? actual.length >= parts.length : parts.length === actual.length);
    }), 'Cortex diff exceeds signed allowed files');
  }
  requireFact(rows.length <= assignment.resultContract.maxChangedFiles && lines <= assignment.resultContract.maxChangedLines, 'Cortex diff exceeds signed change budget');
  return { files: rows.length, lines };
}

export interface BridgeHost {
  /** Actual owner-private file. Parsed or host-injected objects are not admission proof. */
  configPath?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  execute?(objective: string, config: AshlrConfig, options: RunOptions): Promise<RunState>;
  loadConfig?(): AshlrConfig;
  correlate?(run: RunState, repo: string, workItemId: string, config: AshlrConfig): Proposal;
  verify?(proposal: Proposal, config: AshlrConfig, authority: CortexAdmissionToken): Promise<{ passed: boolean; commands: string[]; baseHead?: string }>;
}

/** Pin both pending identity and the persisted verification to the same bytes. */
export function assertCortexVerifiedProposalSnapshot(original: Proposal, current: Proposal, sourceCommit: string): void {
  requireFact(current.id === original.id && current.repo === original.repo && current.status === 'pending' &&
    current.diff === original.diff && current.diffHash === original.diffHash && current.provenanceSig === original.provenanceSig &&
    current.producerProvenanceSig === original.producerProvenanceSig && current.pendingAuthoritySig === original.pendingAuthoritySig &&
    current.verifyResult?.passed === true && current.verifyResult.baseHead === sourceCommit &&
    current.verifyResult.diffHash === hash(original.diff ?? '') && current.diffHash === hash(original.diff ?? ''),
  'Cortex proposal changed after verification or lacks exact persisted evidence');
}

async function boundedJson(response: Response): Promise<Json> {
  requireFact(response.body, 'Cortex returned no response');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try { while (true) { const next = await reader.read(); if (next.done) break;
    length += next.value.byteLength; requireFact(length <= 256 * 1024, 'Cortex response exceeds bound'); chunks.push(next.value); }
  } finally { await reader.cancel().catch(() => {}); }
  const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requireFact(record(raw) && response.ok && raw.ok === true, `Cortex refused request (${response.status})`); return raw;
}

export async function runCortexBridgeOnce(config: CortexBridgeConfig, host: BridgeHost = {}): Promise<{ state: 'idle' | 'proposed'; runId?: string; proposalId?: string; cortexProposalId?: string }> {
  requireFact(host.configPath, 'Cortex requires an explicitly admitted private configuration path');
  const admitted = inspectCortexAdmission(host.configPath);
  requireFact(JSON.stringify(parseCortexBridgeConfig(config)) === JSON.stringify(admitted.config), 'Cortex configuration differs from its admission');
  config = admitted.config;
  inspectPrivateDirectory(config.root);
  const token = process.env[config.tokenEnv]; requireFact(token && /^[\x21-\x7e]{20,4096}$/.test(token), 'Cortex worker token environment is missing or invalid');
  const worker = { id: `phantom-${hash(`${config.url}\0${config.organizationId}\0${config.root}`).slice(0, 40)}`,
    version: 'cortex-bridge-v1', host: hostname(), runtimes: config.runtimes, capabilities: ['engineering-assignment-v1'] };
  const control = new AbortController(); const stop = () => control.abort();
  host.signal?.addEventListener('abort', stop, { once: true }); if (host.signal?.aborted) stop();
  const post = async (op: string, body: Json = {}): Promise<Json> => {
    requireFact(!control.signal.aborted, 'Cortex bridge stopped');
    return boundedJson(await (host.fetchImpl ?? fetch)(`${config.url}/api/fleet/worker`, {
      method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 2, op, worker, ...body }),
      signal: AbortSignal.any([control.signal, AbortSignal.timeout(10_000)]),
    }));
  };
  let timer: ReturnType<typeof setInterval> | undefined; let deadline: ReturnType<typeof setTimeout> | undefined;
  let claimedRunId: string | undefined; let beat: Promise<void> | undefined;
  let proposalLock: ProposalMutationLock | null = null;
  try {
    // This foreground CLI owns its process environment. Keep the bearer in the
    // transport closure, outside both model children and repository verification.
    delete process.env[config.tokenEnv];
    const hello = await post('hello');
    requireFact(hello.protocolVersion === 2 && hello.organizationId === config.organizationId, 'Cortex authenticated organization mismatch');
    const claim = await post('claim'); if (claim.assignment === null) return { state: 'idle' };
    requireFact(record(claim.assignment), 'Malformed Cortex assignment');
    const raw = claim.assignment;
    const assignment = parseEngineeringAssignmentV1(raw.engineeringAssignment, { verifier: config.verifier });
    requireFact(assignment && assignment.runId === raw.runId && raw.goal === assignment.mission.objective &&
      Array.isArray(raw.scope) && raw.scope.length === 1 && raw.scope[0] === assignment.workstream &&
      raw.runtimeId === 'codex' && integer(raw.maxWallClockMs, 20 * 60_000), 'Invalid signed Cortex handoff');
    claimedRunId = assignment.runId;
    const maxWallClockMs = raw.maxWallClockMs;
    return await withCortexForegroundAdmission(host.configPath, raw.engineeringAssignment, async authority => {
    authority.signal.addEventListener('abort', stop, { once: true });
    try {
    const repo = matchCortexRepository(config, assignment);
    const attempt = join(config.root, hash(assignment.runId));
    // Atomic exclusive reservation: a lost response/crash never dispatches the same assignment twice.
    mkdirSync(attempt, { mode: 0o700 }); inspectPrivateDirectory(attempt);
    const save = (name: string, content: string): string => {
      writePrivateFileAtomically(join(attempt, `.${name}.tmp`), join(attempt, name), content, { anchorPath: config.root, label: 'Cortex bridge artifact' });
      return hash(content);
    };
    save('assignment.json', `${JSON.stringify(assignment)}\n`);
    const heartbeat = async () => { const ack = await post('heartbeat', { runId: assignment.runId });
      requireFact(ack.cancelled === false && ack.status === 'running' && Date.now() < Date.parse(assignment.expiresAt), 'Cortex assignment revoked, expired or stopped'); };
    await heartbeat();
    timer = setInterval(() => { if (beat) return; beat = heartbeat().catch(stop).finally(() => { beat = undefined; }); }, 10_000);
    deadline = setTimeout(stop, Math.min(maxWallClockMs, Date.parse(assignment.expiresAt) - Date.now()));
    const cfg = host.loadConfig ? host.loadConfig() : (await import('../config.js')).loadConfig();
    const isolated = cortexCodexConfig(cfg);
    (await import('../sandbox/policy.js')).assertMayExecuteWithCortexAdmission(repo, { cortexAdmission: authority.producer });
    const workItemId = `cortex-${hash(assignment.assignmentDigest).slice(0, 48)}`;
    const options: RunOptions = { cortexAdmission: authority.producer, engine: 'codex', sandboxEngine: true, requireSandbox: true,
      cwd: repo, signal: control.signal, noMemory: true, noCapture: true, tools: false, budget: config.budget, workItemId,
      delegationScope: { schemaVersion: 1, sourceRepo: repo, memoryMode: 'none', allowedFiles: { include: [...assignment.mission.allowedFiles], enforceWrites: true },
        resultContract: { ...assignment.resultContract }, contextBudget: { memoryChars: 0, resultChars: 4000 } } };
    const objective = `${assignment.mission.objective}\n\nSuccess signals:\n${assignment.mission.successSignals.join('\n')}\n\nGuardrails:\n${assignment.mission.guardrails.join('\n')}`;
    const run = await (host.execute ?? (await import('../run/orchestrator.js')).runGoal)(objective, isolated, options);
    await heartbeat(); matchCortexRepository(config, assignment);
    let proposal = host.correlate ? host.correlate(run, repo, workItemId, isolated) : await correlateProposal(run, repo, workItemId, isolated);
    requireFact(proposal.status === 'pending' && proposal.diff && proposal.repo === repo, 'Cortex proposal identity mismatch');
    const changes = validateCortexProposalDiff(proposal.diff, assignment);
    const original = JSON.parse(JSON.stringify(proposal)) as Proposal;
    const verification = host.verify ? await host.verify(proposal, isolated, authority.verifier) : await verifyProposal(proposal, isolated, authority.verifier);
    if (timer) { clearInterval(timer); timer = undefined; } if (beat) await beat;
    await heartbeat(); matchCortexRepository(config, assignment);
    requireFact(verification.passed && verification.baseHead === assignment.repo.sourceCommit && verification.commands.length >= 1 &&
      verification.commands.length <= 30 && verification.commands.every(v => v.length <= 500 && [...v].every(char => char.charCodeAt(0) >= 32)), 'Cortex proposal verification did not pass at signed source commit');
    if (!host.correlate) { proposalLock = acquireProposalMutationLock(proposal.id); requireFact(proposalLock, 'Cortex proposal snapshot lock unavailable'); }
    proposal = host.correlate ? host.correlate(run, repo, workItemId, isolated) : await correlateProposal(run, repo, workItemId, isolated, original);
    assertCortexVerifiedProposalSnapshot(original, proposal, assignment.repo.sourceCommit);
    const artifacts: BridgeReceipt['artifacts'] = [
      { kind: 'diff', path: 'proposal.diff', sha256: save('proposal.diff', proposal.diff!) },
      { kind: 'proposal', path: 'proposal.json', sha256: save('proposal.json', `${JSON.stringify(proposal)}\n`) },
      { kind: 'verification', path: 'verification.json', sha256: save('verification.json', `${JSON.stringify(verification)}\n`) },
    ];
    const receipt: BridgeReceipt = { protocol: 'ashlr-engineering-receipt/v1', assignmentDigest: assignment.assignmentDigest, runId: assignment.runId,
      sourceCommit: assignment.repo.sourceCommit, proposalId: proposal.id, proposalStatus: 'pending', summary: proposal.summary.slice(0, 4000) || proposal.title,
      changes,
      verification: { status: 'passed', commands: verification.commands }, artifacts };
    const text = JSON.stringify({ outcome: receipt.summary, engineeringReceipt: receipt }); save('receipt.json', `${text}\n`);
    if (proposalLock) { releaseProposalMutationLock(proposalLock); proposalLock = null; }
    // Stop may have been armed after verification persisted its evidence.
    // Recheck the full policy, not only the private admission, before publishing.
    (await import('../sandbox/policy.js')).assertMayExecuteWithCortexAdmission(repo, { cortexAdmission: authority.verifier }, 'verify');
    const finish = await post('finish', { runId: assignment.runId, ok: true, text });
    requireFact(finish.status === 'succeeded' && id(finish.proposalId), 'Cortex did not confirm an Approval Inbox proposal');
    save('accepted.json', `${JSON.stringify(finish)}\n`);
    return { state: 'proposed' as const, runId: assignment.runId, proposalId: proposal.id, cortexProposalId: finish.proposalId };
    } finally { authority.signal.removeEventListener('abort', stop); }
    });
  } catch (error) {
    if (claimedRunId && !control.signal.aborted) {
      await post('finish', { runId: claimedRunId, ok: false, text: 'Phantom could not produce a verified proposal. Inspect retained local bridge artifacts; no merge or release was invoked.' }).catch(() => {});
    }
    throw error;
  } finally {
    control.abort();
    if (timer) clearInterval(timer); if (deadline) clearTimeout(deadline); host.signal?.removeEventListener('abort', stop);
    if (proposalLock) releaseProposalMutationLock(proposalLock);
    process.env[config.tokenEnv] = token;
  }
}

async function correlateProposal(run: RunState, repo: string, workItemId: string, config: AshlrConfig, original?: Proposal): Promise<Proposal> {
  requireFact(run.status === 'done' && run.proposalOutcome?.kind === 'filed' && !run.proposalOutcome.isPartial, 'Cortex run did not file a complete proposal');
  const { loadRun } = await import('../run/orchestrator.js'); const durable = loadRun(run.id);
  requireFact(durable?.proposalOutcome?.kind === 'filed' && durable.proposalOutcome.proposalId === run.proposalOutcome.proposalId && durable.status === 'done', 'Cortex run durable identity mismatch');
  const read = (await import('../inbox/store.js')).listProposalsDetailed({ requireComplete: true });
  const matches = read.proposals.filter(v => v.runId === run.id);
  requireFact(read.sourceState === 'healthy' && read.complete && !read.invalidFiles && !read.unreadableFiles && matches.length === 1, 'Cortex proposal source degraded');
  const proposal = matches[0]!;
  const { isAuthoritativeDurablePendingProposal } = await import('../inbox/pending-authority.js');
  requireFact(proposal.diff && isAuthoritativeDurablePendingProposal(proposal, { id: run.proposalOutcome.proposalId, repo, origin: 'agent', kind: 'patch',
    runId: run.id, trajectoryId: `run:${run.id}`, workItemId, isPartial: false,
    ...(original ? { diff: original.diff, diffHash: original.diffHash, provenanceSig: original.provenanceSig } : {}) }, config), 'Cortex pending proposal authority invalid');
  return proposal;
}
async function verifyProposal(proposal: Proposal, config: AshlrConfig, cortexAdmission: CortexAdmissionToken): Promise<{ passed: boolean; commands: string[]; baseHead?: string }> {
  const result = await (await import('../inbox/merge.js')).verifyAndPersistProposal(proposal, config, 'cortex-bridge', {
    cortexAdmission, requireConfinement: true, allowLoopback: false, denyCodexProjectConfig: true,
  });
  return { passed: result.persisted && result.authorityLive && result.verify.ok, commands: result.verify.ran.map(v => v.cmd.join(' ')), baseHead: result.verify.baseHead };
}
