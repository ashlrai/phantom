/**
 * `phm improve` — self-improvement loop.
 *   propose  [--team t] [--open-pr --repo <dir>] [--json]   evidence-backed proposals, ranked by realized leverage; draft PRs
 *   register <proposal.json>                                 record a proposal's hypothesis and deterministic metric
 *   measure  <id> --repo <dir> [--repeat N]                  measure the metric at the PR's exact merge base and head
 *   outcomes [--json]                                        measured outcomes and proposer comparison vs the deterministic baseline
 *   sync-backlog                                             register cloud backlog PRs whose item declares a metric and record checkout-free merge/revert observations
 *   observe  --repo <dir>                                    record merges of registered PRs and reverts that undo them
 *   discover [--repo owner/name] [--dry-run] [--json]        add backlog items from member issues, a red default branch and proposals
 *   promote  <id> --repo <dir> [--queue-merge] [--json]      evaluate the promotion gate; --queue-merge queues auto-merge when admitted
 *   lessons  [--json]                                        lessons trial: cloud runs with lessons vs the holdout without them
 *   nightly  [--json] [--limit <1-200>]                      read-only report of the nightly self-improvement state
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gatherProposals, openProposalPr, renderProposal } from '../core/improve/loop.js';
import { defaultStewardPolicy, runSteward } from '../core/steward/disk.js';
import { rejectUnknownOptions } from './args.js';
import type { NightlyReport } from '../core/learn/retro/store.js';

const USAGE = `Usage:
  phm improve propose [--team <id>] [--open-pr --repo <dir>] [--json]
  phm improve register <proposal.json>
  phm improve measure <id> --repo <dir> [--repeat <1-5>]
  phm improve outcomes [--json]
  phm improve sync-backlog
  phm improve discover [--repo <owner/name>] [--dry-run] [--json]
  phm improve observe --repo <dir>
  phm improve promote <id> --repo <dir> [--queue-merge] [--json]
  phm improve lessons [--json]
  phm improve nightly [--json] [--limit <1-200>]`;

export async function cmdImprove(argv: string[]): Promise<number> {
  const args = [...argv];
  const val = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  switch (args[0]) {
    case 'propose': return propose(args, val);
    case 'register': return register(args[1]);
    case 'measure': return measure(args[1], val('--repo'), val('--repeat'));
    case 'outcomes': return outcomes(args.includes('--json'));
    case 'sync-backlog': return syncBacklog();
    case 'observe': return observe(val('--repo'));
    case 'discover': return discover(val('--repo'), args.includes('--dry-run'), args.includes('--json'));
    case 'promote': return promote(args[1], val('--repo'), !args.includes('--queue-merge'), args.includes('--json'));
    case 'lessons': return lessons(args.includes('--json'));
    case 'nightly': return nightly(args.slice(1));
    default: console.error(USAGE); return 2;
  }
}

async function propose(args: string[], val: (n: string) => string | undefined): Promise<number> {
  // Refuse an option propose does not read before the steward runs: a typo like
  // `--open-p` used to fall through to a normal proposal run.
  const bad = rejectUnknownOptions(args.slice(1), { flags: ['--json', '--open-pr', '--auto-merge'], values: ['--team', '--repo'] });
  if (bad) {
    if (args.includes('--json') && args.includes('--open-pr')) console.log(JSON.stringify({ opened: [], error: bad.message }, null, 2));
    else { console.error(bad.message); console.error(USAGE); }
    return 2;
  }
  if (args.includes('--auto-merge')) { console.error('Draft proposals cannot request auto-merge. Promotion is `phm improve promote`, gated by green checks and a measured metric improvement.'); return 2; }
  const gathered = gatherProposals(val('--team') ?? 'default', runSteward(defaultStewardPolicy()));
  const { readLedger, scoreOutcomes, rankByLeverage } = await import('../core/improve/outcomes.js');
  const proposals = rankByLeverage(gathered, scoreOutcomes(readLedger().records));
  if (!args.includes('--open-pr')) {
    if (args.includes('--json')) console.log(JSON.stringify(proposals, null, 2));
    else console.log(proposals.length ? proposals.map((p) => renderProposal(p, { includeLocal: true })).join('\n---\n') : 'No proposals: no qualifying evidence yet.');
    return 0;
  }
  // --json with --open-pr: stdout carries one JSON object, never bare PR lines or human errors.
  const json = args.includes('--json');
  const repo = val('--repo');
  if (!repo) {
    if (json) console.log(JSON.stringify({ opened: [], error: '--open-pr needs --repo <checkout>' }, null, 2));
    else console.error('--open-pr needs --repo <checkout>');
    return 2;
  }
  const opened: Array<{ id: string; pr: string }> = [];
  for (const p of proposals) {
    try {
      const pr = openProposalPr(p, repo);
      if (json) opened.push({ id: p.id, pr });
      else console.log(pr);
    } catch (err) {
      const error = `${p.id}: ${err instanceof Error ? err.message : String(err)}`;
      if (json) console.log(JSON.stringify({ opened, error }, null, 2));
      else console.error(error);
      return 1;
    }
  }
  if (json) console.log(JSON.stringify({ opened }, null, 2));
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
  const { measureAt, standingMetricConfinement } = await import('../core/improve/measure.js');
  const { readPr, defaultBranchOf, assertOriginIs, prMergeBase } = await import('../core/improve/promote.js');
  try {
    assertOriginIs(outcome.pr.repository, repo);
    const pr = readPr(outcome.pr.repository, outcome.pr.number, repo);
    const base = prMergeBase(repo, pr, defaultBranchOf(outcome.pr.repository, repo));
    for (const [phase, sha] of [['base', base], ['head', pr.headRefOid]] as const) {
      for (let i = 0; i < repeat; i++) {
        const m = await measureAt(repo, sha, outcome.metric, undefined, standingMetricConfinement);
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

async function syncBacklog(): Promise<number> {
  try {
    const { syncCloudBacklogOutcomes } = await import('../core/improve/backlog-sync.js');
    const res = syncCloudBacklogOutcomes();
    if (!res.intact) { console.error(`! outcome ledger is not intact: ${res.reasons.join(', ')}`); return 1; }
    if (res.reason === 'append-failed') { console.error('! could not append to the outcome ledger'); return 1; }
    if (res.reason === 'source-unavailable') { console.error('! could not read the cloud task store, backlog or outcome ledger'); return 1; }
    const { syncCloudOutcomeObservations } = await import('../core/improve/observe-sync.js');
    const obs = syncCloudOutcomeObservations();
    if (!obs.intact) { console.error(`! outcome ledger is not intact: ${obs.reasons.join(', ')}`); return 1; }
    if (obs.reason === 'append-failed') { console.error('! could not append to the outcome ledger'); return 1; }
    if (obs.reason === 'source-unavailable') { console.error('! could not read the cloud task store or outcome ledger'); return 1; }
    console.log(res.registered ? `ok registered ${res.registered} cloud backlog PR(s); measure them with phm improve measure <id> --repo <dir>` : 'No new cloud backlog PRs with a declared metric.');
    if (obs.appended > 0) console.log(`ok recorded ${obs.appended} post-merge observation(s) (${obs.merged} merged, ${obs.reverted} reverted)`);
    return 0;
  } catch (err) { console.error(`! ${err instanceof Error ? err.message : String(err)}`); return 1; }
}

async function observe(repo: string | undefined): Promise<number> {
  if (!repo) { console.error('Usage: phm improve observe --repo <dir>'); return 2; }
  const { appendLedger, readLedger, scoreOutcomes } = await import('../core/improve/outcomes.js');
  const { observeCloudReverts, observeOutcomes } = await import('../core/improve/observe.js');
  const { defaultBranchOf, assertOriginIs } = await import('../core/improve/promote.js');
  const read = readLedger();
  if (!read.intact) { console.error(`! outcome ledger is not intact: ${read.reasons.join(', ')}`); return 1; }
  try {
    // Only registered PRs and cloud tasks whose PR lives in this checkout's origin repository.
    const { listCloudTasks, readCloudTask, writeCloudTask } = await import('../core/cloud/store.js');
    const all = scoreOutcomes(read.records).filter((o) => o.pr);
    const tasks = listCloudTasks(Number.MAX_SAFE_INTEGER);
    const candidates = [...new Set([...all.map((o) => o.pr!.repository), ...tasks.filter((t) => t.state === 'merged').map((t) => t.repo)])];
    const repository = candidates.find((r) => { try { assertOriginIs(r, repo); return true; } catch { return false; } });
    if (!repository) { console.log('No registered PRs or merged cloud tasks belong to this checkout\'s origin.'); return 0; }
    const branch = defaultBranchOf(repository, repo);
    const mine = all.filter((o) => o.pr!.repository.toLowerCase() === repository.toLowerCase());
    const res = observeOutcomes(mine, repo, branch);
    for (const e of res.events) appendLedger(e);
    for (const e of res.errors) console.log(`warn ${e}`);
    const reverts = res.events.filter((e) => e.type === 'observed' && e.observation === 'reverted').length;
    console.log(`ok ${res.events.length - reverts} merge(s) and ${reverts} revert(s) recorded`);
    const cloud = observeCloudReverts(tasks, repository, repo, branch);
    let written = 0;
    for (const c of cloud.changes) {
      const t = readCloudTask(c.taskId);
      if (!t?.outcome) continue;
      writeCloudTask({ ...t, outcome: { ...t.outcome, revertedBy: c.revertedBy } });
      written += 1;
    }
    for (const e of cloud.errors) console.log(`warn ${e}`);
    const cloudReverts = cloud.changes.filter((c) => c.revertedBy).length;
    console.log(`ok ${cloudReverts} cloud task revert(s) and ${written - cloudReverts} re-land(s) recorded`);
    return 0;
  } catch (err) { console.error(`! ${err instanceof Error ? err.message : String(err)}`); return 1; }
}

async function discover(repoArg: string | undefined, dryRun: boolean, json: boolean): Promise<number> {
  const { discoverBacklog } = await import('../core/improve/discover.js');
  const { appendUserBacklogItems, validBacklogItem } = await import('../core/cloud/backlog.js');
  const { readCloudBudget, CLOUD_REPO_PATTERN } = await import('../core/cloud/store.js');
  const repo = repoArg ?? readCloudBudget().selfImprove.repo;
  if (!CLOUD_REPO_PATTERN.test(repo)) { console.error('--repo must be owner/name'); return 2; }
  const res = await discoverBacklog(repo, { proposals: gatherProposals('default', runSteward(defaultStewardPolicy())) });
  const items = res.items.filter((i) => validBacklogItem(i) !== null);
  const added = dryRun ? 0 : appendUserBacklogItems(items);
  if (json) console.log(JSON.stringify({ repo, dryRun, found: items.length, added, items, errors: res.errors }, null, 2));
  else {
    for (const i of items) console.log(`${i.id.padEnd(28)} p${i.priority} ${i.area.padEnd(12)} ${i.title}`);
    for (const e of res.errors) console.log(`warn ${e}`);
    console.log(dryRun ? `-> ${items.length} item(s) found; dry run, nothing added` : `ok ${added} new backlog item(s) added (${items.length} found)`);
  }
  return res.errors.length && !items.length ? 1 : 0;
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
  const { measureAt, standingMetricConfinement } = await import('../core/improve/measure.js');
  const { readPr, defaultBranchOf, assertOriginIs, prMergeBase, prDiff, evaluatePromotion, queueMerge, confirmQueued, NOT_REMEASURED, npmMetricFiles, readFileAt } = await import('../core/improve/promote.js');
  const guards = async () => {
    const [{ killSwitchOn }, { isPaused }] = await Promise.all([import('../core/sandbox/policy.js'), import('../core/comms/pause.js')]);
    return { killSwitch: killSwitchOn(), paused: isPaused() };
  };
  try {
    assertOriginIs(repository, repo);
    const pr = readPr(repository, outcome.pr.number, repo);
    const defaultBranch = defaultBranchOf(repository, repo);
    const mergeBase = prMergeBase(repo, pr, defaultBranch);
    const facts = { outcome, pr, defaultBranch, mergeBase, ledgerIntact: read.intact, diff: prDiff(repo, mergeBase, pr.headRefOid),
      npmMetricFiles: outcome.metric.runner.kind === 'npm' ? npmMetricFiles(readFileAt(repo, mergeBase, 'package.json'), outcome.metric.runner.script) : undefined };
    let decision = evaluatePromotion({ ...facts, guards: await guards() });
    // Measuring runs the PR's code; only spend it on a PR that passes every other gate.
    if (decision.reasons.length === 1 && decision.reasons[0] === NOT_REMEASURED) {
      const base = await measureAt(repo, mergeBase, outcome.metric, undefined, standingMetricConfinement);
      const head = await measureAt(repo, pr.headRefOid, outcome.metric, undefined, standingMetricConfinement);
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

async function lessons(json: boolean): Promise<number> {
  const [{ listCloudTasks }, { revertedPrKeys }, trial] = await Promise.all([
    import('../core/cloud/store.js'), import('../core/improve/reverted.js'), import('../core/improve/lesson-trial.js')]);
  const tasks = listCloudTasks(Number.MAX_SAFE_INTEGER);
  const report = trial.lessonTrial(tasks, revertedPrKeys(tasks));
  if (json) { console.log(JSON.stringify(report, null, 2)); return 0; }
  console.log(`Lessons trial (holdout ${Math.round(report.holdout * 100)}% of eligible cloud launches run without lessons)`);
  console.log(trial.renderLessonEffect(report.overall));
  for (const e of report.byNote) console.log(`  ${trial.renderLessonEffect(e)}`);
  if (report.excluded.launchFailed || report.excluded.unfinished) console.log(`Not counted: ${report.excluded.launchFailed} launch failure(s), ${report.excluded.unfinished} still running.`);
  console.log(trial.renderFamilyPromotion(report.byFamily));
  return 0;
}

const NIGHTLY_USAGE = 'Usage: phm improve nightly [--json] [--limit <1-200>]';

async function nightly(args: string[]): Promise<number> {
  const bad = rejectUnknownOptions(args, { flags: ['--json'], values: ['--limit'] });
  const limitRaw = args.includes('--limit') ? args[args.indexOf('--limit') + 1] : undefined;
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (bad) { console.error(bad.message); console.error(NIGHTLY_USAGE); return 2; }
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)) {
    console.error(NIGHTLY_USAGE);
    return 2;
  }
  const { readNightlyReport } = await import('../core/learn/retro/store.js');
  const report = await readNightlyReport(limit);
  if (args.includes('--json')) { console.log(JSON.stringify(report, null, 2)); return report.state === 'unreadable' ? 1 : 0; }
  console.log(nightlyLines(report).join('\n'));
  return report.state === 'unreadable' ? 1 : 0;
}

function nightlyLines(report: NightlyReport): string[] {
  if (report.state !== 'read') {
    return report.state === 'missing'
      ? ['nightly self-improvement: no completed run yet', `state ${report.path} absent; the first eligible nightly tick has not completed`]
      : ['nightly self-improvement: state unreadable or unsafe', `state ${report.path}; last completed night unknown`];
  }
  const c = report.counts!;
  const lines = [
    `nightly self-improvement completed=${report.completedNight} advisory-only`,
    `state ${report.path}`,
    `jobs=${c.jobs} reviews=${c.reviews} priors=${c.priors} lessons=${c.lessons} proposals=${c.proposals}`,
  ];
  if (c.proposals > 0) {
    lines.push(`proposals (${c.proposals}):`);
    for (const p of report.proposals) {
      lines.push(`  [${p.status}] ${p.title} (${p.repo})`);
      lines.push(`    id=${p.id} lesson=${p.lessonId}`);
      lines.push(`    prompt=${p.prompt}`);
      lines.push(`    evaluation=${p.evaluation}`);
      lines.push(`    metric=${p.metric}`);
    }
    if (c.proposals > report.proposals.length) lines.push(`  … ${c.proposals - report.proposals.length} more (raise --limit or --json)`);
  }
  if (c.lessons > 0) {
    lines.push(`lessons (${c.lessons} pending):`);
    for (const l of report.lessons) {
      lines.push(`  [${l.cause}] ${l.repo}${l.playbook ? ` playbook=${l.playbook}` : ''} — ${l.text}`);
      lines.push(`    id=${l.id} evidence=${l.evidence.join(', ') || 'none'}`);
    }
    if (c.lessons > report.lessons.length) lines.push(`  … ${c.lessons - report.lessons.length} more (raise --limit or --json)`);
  }
  if (c.priors > 0) {
    lines.push(`priors (${c.priors}):`);
    for (const p of report.priors) lines.push(`  ${p.repo} / ${p.arm}: successes=${p.successes} failures=${p.failures} alpha=${p.alpha} beta=${p.beta}`);
    if (c.priors > report.priors.length) lines.push(`  … ${c.priors - report.priors.length} more (raise --limit or --json)`);
  }
  return lines;
}
