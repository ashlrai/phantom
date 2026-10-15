/**
 * `phm improve` — self-improvement loop.
 *   propose  [--team t] [--open-pr --repo <dir>] [--json]   evidence-backed proposals, ranked by realized leverage; draft PRs
 *   register <proposal.json>                                 record a proposal's hypothesis and deterministic metric
 *   measure  <id> --repo <dir> [--repeat N]                  measure the metric at the PR's exact merge base and head
 *   outcomes [--json]                                        measured outcomes and proposer comparison vs the deterministic baseline
 *   promote  <id> --repo <dir> [--queue-merge] [--json]      evaluate the promotion gate; --queue-merge queues auto-merge when admitted
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gatherProposals, openProposalPr, renderProposal } from '../core/improve/loop.js';
import { defaultStewardPolicy, runSteward } from '../core/steward/disk.js';

const USAGE = `Usage:
  phm improve propose [--team <id>] [--open-pr --repo <dir>] [--json]
  phm improve register <proposal.json>
  phm improve measure <id> --repo <dir> [--repeat <1-5>]
  phm improve outcomes [--json]
  phm improve promote <id> --repo <dir> [--queue-merge] [--json]`;

export async function cmdImprove(argv: string[]): Promise<number> {
  const args = [...argv];
  const val = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  switch (args[0]) {
    case 'propose': return propose(args, val);
    case 'register': return register(args[1]);
    case 'measure': return measure(args[1], val('--repo'), val('--repeat'));
    case 'outcomes': return outcomes(args.includes('--json'));
    case 'promote': return promote(args[1], val('--repo'), !args.includes('--queue-merge'), args.includes('--json'));
    default: console.error(USAGE); return 2;
  }
}

async function propose(args: string[], val: (n: string) => string | undefined): Promise<number> {
  if (args.includes('--auto-merge')) { console.error('Draft proposals cannot request auto-merge. Promotion is `phm improve promote`, gated by green checks and a measured metric improvement.'); return 2; }
  const gathered = gatherProposals(val('--team') ?? 'default', runSteward(defaultStewardPolicy()));
  const { readLedger, scoreOutcomes, rankByLeverage } = await import('../core/improve/outcomes.js');
  const proposals = rankByLeverage(gathered, scoreOutcomes(readLedger().records));
  if (!args.includes('--open-pr')) {
    if (args.includes('--json')) console.log(JSON.stringify(proposals, null, 2));
    else console.log(proposals.length ? proposals.map((p) => renderProposal(p, { includeLocal: true })).join('\n---\n') : 'No proposals: no qualifying evidence yet.');
    return 0;
  }
  const repo = val('--repo');
  if (!repo) { console.error('--open-pr needs --repo <checkout>'); return 2; }
  for (const p of proposals) {
    try { console.log(openProposalPr(p, repo)); } catch (err) { console.error(`${p.id}: ${err instanceof Error ? err.message : String(err)}`); return 1; }
  }
  return 0;
}

async function register(file: string | undefined): Promise<number> {
  if (!file) { console.error('Usage: phm improve register <proposal.json>'); return 2; }
  const { appendLedger } = await import('../core/improve/outcomes.js');
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const title = String(raw.title ?? '');
    const proposalId = typeof raw.id === 'string' ? raw.id : createHash('sha256').update(title).digest('hex').slice(0, 10);
    appendLedger({ type: 'registered', proposalId, title, proposalKind: String(raw.kind ?? ''), source: raw.source as never,
      metric: raw.metric as never, predictedDelta: raw.predictedDelta === undefined ? null : Number(raw.predictedDelta) });
    const pr = raw.pr as { repository?: unknown; number?: unknown } | undefined;
    if (pr) appendLedger({ type: 'pr', proposalId, repository: String(pr.repository), number: Number(pr.number) });
    console.log(`ok registered ${proposalId}`);
    return 0;
  } catch (err) { console.error(`! ${err instanceof Error ? err.message : String(err)}`); return 1; }
}

async function outcomeFor(id: string | undefined) {
  const { readLedger, scoreOutcomes } = await import('../core/improve/outcomes.js');
  const read = readLedger();
  return { read, outcome: scoreOutcomes(read.records).find((o) => o.proposalId === id) };
}

async function measure(id: string | undefined, repo: string | undefined, repeatArg: string | undefined): Promise<number> {
  const repeat = repeatArg === undefined ? 2 : Number(repeatArg);
  if (!id || !repo || !Number.isInteger(repeat) || repeat < 1 || repeat > 5) { console.error('Usage: phm improve measure <id> --repo <dir> [--repeat <1-5>]'); return 2; }
  const { read, outcome } = await outcomeFor(id);
  if (!read.intact) { console.error(`! outcome ledger is not intact: ${read.reasons.join(', ')}`); return 1; }
  if (!outcome?.pr) { console.error('! register the proposal with its PR first (phm improve register)'); return 1; }
  const { appendLedger } = await import('../core/improve/outcomes.js');
  const { measureAt } = await import('../core/improve/measure.js');
  const { readPr, defaultBranchOf, assertOriginIs, prMergeBase } = await import('../core/improve/promote.js');
  try {
    assertOriginIs(outcome.pr.repository, repo);
    const pr = readPr(outcome.pr.repository, outcome.pr.number, repo);
    const base = prMergeBase(repo, pr, defaultBranchOf(outcome.pr.repository, repo));
    for (const [phase, sha] of [['base', base], ['head', pr.headRefOid]] as const) {
      for (let i = 0; i < repeat; i++) {
        const m = measureAt(repo, sha, outcome.metric);
        appendLedger({ type: 'measured', proposalId: id, phase, sha, value: m.value, reason: m.reason });
        console.log(`-> ${phase} ${sha.slice(0, 12)} ${outcome.metric.name} = ${m.value ?? `unknown (${m.reason})`}`);
        if (m.value === null) break;
      }
    }
  } catch (err) { console.error(`! ${err instanceof Error ? err.message : String(err)}`); return 1; }
  const after = await outcomeFor(id);
  console.log(`ok ${after.outcome?.status ?? 'unknown'}${after.outcome?.effect != null ? ` (effect ${after.outcome.effect})` : ''}`);
  return 0;
}

async function outcomes(json: boolean): Promise<number> {
  const { readLedger, scoreOutcomes, summarizeBySource } = await import('../core/improve/outcomes.js');
  const read = readLedger();
  const scored = scoreOutcomes(read.records);
  const sources = summarizeBySource(scored);
  if (json) { console.log(JSON.stringify({ intact: read.intact, reasons: read.reasons, outcomes: scored, sources }, null, 2)); return 0; }
  if (!read.intact) console.log(`warn ledger not intact: ${read.reasons.join(', ')}`);
  if (!scored.length) { console.log('No registered proposals yet.'); return 0; }
  for (const o of scored) console.log(`${o.proposalId}  ${o.status.padEnd(9)} ${o.metric.name}${o.effect !== null ? ` ${o.effect > 0 ? '+' : ''}${o.effect}` : ''}  ${o.title}`);
  console.log('');
  const pct = (v: number | null) => v === null ? 'unknown' : `${Math.round(v * 100)}%`;
  for (const s of sources) console.log(`${s.key}: ${s.measured} measured, ${s.unknown} unknown, improvement rate ${pct(s.improvementRate)}${s.key === 'deterministic' ? ' (baseline)' : `, vs deterministic ${s.versusDeterministic === null ? 'unknown' : `${s.versusDeterministic > 0 ? '+' : ''}${Math.round(s.versusDeterministic * 100)} pts`}`}`);
  return 0;
}

async function promote(id: string | undefined, repo: string | undefined, dryRun: boolean, json: boolean): Promise<number> {
  if (!id || !repo) { console.error('Usage: phm improve promote <id> --repo <dir> [--queue-merge] [--json]'); return 2; }
  const { read, outcome } = await outcomeFor(id);
  if (!outcome?.pr) { console.error('! register the proposal with its PR first (phm improve register)'); return 1; }
  const repository = outcome.pr.repository;
  const { appendLedger } = await import('../core/improve/outcomes.js');
  const { measureAt } = await import('../core/improve/measure.js');
  const { readPr, defaultBranchOf, assertOriginIs, prMergeBase, prDiff, evaluatePromotion, queueMerge, confirmQueued, NOT_REMEASURED } = await import('../core/improve/promote.js');
  const guards = async () => {
    const [{ killSwitchOn }, { isPaused }] = await Promise.all([import('../core/sandbox/policy.js'), import('../core/comms/pause.js')]);
    return { killSwitch: killSwitchOn(), paused: isPaused() };
  };
  try {
    assertOriginIs(repository, repo);
    const pr = readPr(repository, outcome.pr.number, repo);
    const defaultBranch = defaultBranchOf(repository, repo);
    const mergeBase = prMergeBase(repo, pr, defaultBranch);
    const facts = { outcome, pr, defaultBranch, mergeBase, ledgerIntact: read.intact, diff: prDiff(repo, mergeBase, pr.headRefOid) };
    let decision = evaluatePromotion({ ...facts, guards: await guards() });
    // Measuring runs the PR's code; only spend it on a PR that passes every other gate.
    if (decision.reasons.length === 1 && decision.reasons[0] === NOT_REMEASURED) {
      const base = measureAt(repo, mergeBase, outcome.metric);
      const head = measureAt(repo, pr.headRefOid, outcome.metric);
      const remeasured = { base: base.value, head: head.value, reasons: [base.reason, head.reason].filter((r): r is string => !!r) };
      // Measuring takes minutes: Stop/Pause and the PR itself are read again right before acting.
      const now = readPr(repository, outcome.pr.number, repo);
      decision = evaluatePromotion({ ...facts, pr: now, guards: await guards(), remeasured });
      if (now.headRefOid !== pr.headRefOid || now.baseRefName !== pr.baseRefName) decision = { admit: false, reasons: [...decision.reasons, 'the PR changed while the gate measured it; run promote again'] };
    }
    let drift: string[] = [];
    if (decision.admit && !dryRun) {
      queueMerge(repository, pr, repo);
      drift = confirmQueued(repository, pr, repo);
      if (drift.length) decision = { admit: false, reasons: [`auto-merge disabled again: ${drift.join(', ')}`] };
    }
    if (!dryRun && /^[0-9a-f]{40}$/.test(pr.headRefOid)) {
      appendLedger({ type: 'promotion', proposalId: id, headSha: pr.headRefOid, decision: decision.admit ? 'merge-queued' : 'refused', reasons: decision.reasons });
    }
    if (json) console.log(JSON.stringify({ ...decision, dryRun, headSha: pr.headRefOid }, null, 2));
    else if (decision.admit) console.log(dryRun ? 'ok gate admits; pass --queue-merge to queue auto-merge' : `ok auto-merge queued for ${repository}#${pr.number} at ${pr.headRefOid.slice(0, 12)}`);
    else console.log(['! not promoted:', ...decision.reasons.map((r) => `  - ${r}`)].join('\n'));
    return decision.admit ? 0 : 1;
  } catch (err) { console.error(`! ${err instanceof Error ? err.message : String(err)}`); return 1; }
}
