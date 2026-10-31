// @vitest-environment jsdom — pane validators live in src/web-ui modules that
// touch document/localStorage at import time (theme-store), same as under
// vitest.config.web.ts's jsdom environment.
/**
 * test/verse-fleet-day-one.test.ts — Phantom 3.30.0 day-one smoke for the
 * /verse/ desktop fleet console. Every GET the fleet/ops/leader panes poll is
 * walked through the REAL dispatch order — handleVerseControlApi first, then
 * handleVerseApi's workbench families and mounted modules — once against a
 * fixture ~/.ashlr-runs (+ ~/.ashlr) and once against a HOME with no runs dir.
 * Each 200 must satisfy the pane's own validator: a 500, or a shape the UI
 * narrows away, is caught here instead of spinning on release morning.
 * Hermetic: gh/git probing, the Codex reader and control inputs are injected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AshlrConfig } from '../src/core/types.js';
import {
  handleVerseApi, mountedApiModules, setMountedApiModulesForTest, setWorkbenchApiModulesForTest,
  workbenchApiModules, type VerseApiContext } from '../src/core/verse/verse-api.js';
import { handleVerseControlApi } from '../src/core/verse/control-api.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import { createOpsApi } from '../src/core/verse/ops-api.js';
import { createReleasePrApi } from '../src/core/verse/ops-release-pr-api.js';
import { resetFleetLiveApiForTest } from '../src/core/verse/fleet-live-api.js';
import { resetLeaderApiCacheForTest } from '../src/core/verse/leader-api.js';
import { _resetExecutionFeedbackCacheForTest } from '../src/core/verse/execution-feedback-api.js';
import { setFleetControlDepsForTest } from '../src/core/verse/fleet-control-api.js';
import { resetFleetHistoryServiceForTests } from '../src/core/verse/fleet-history.js';
import type { FleetControlDeps } from '../src/core/fleet/fleet-control.js';
import type { AuthorityStatusV1 } from '../src/core/authority/types.js';
import type { ReadProjectionReader } from '../src/core/web/read-projections.js';
import type { ExecutionFeedbackView } from '../src/core/fleet/execution-feedback-types.js';
import type { ExecutionFeedbackCaseDetail } from '../src/core/fleet/execution-feedback-case-types.js';

// The pane-side validators the desktop applies to each response — the
// contract this test exists to pin.
import { isFleetRuns } from '../src/web-ui/routes/verse/ops/ops-runs-model.js';
import { isFleetQueue } from '../src/web-ui/routes/verse/ops/ops-queue-model.js';
import { isLaneTargets } from '../src/web-ui/routes/verse/ops/lane-targets-model.js';
import { isOpsReleases } from '../src/web-ui/routes/verse/fleet-releases/fleet-releases-model.js';
import { isLeaderJournal } from '../src/web-ui/routes/verse/leader-journal/leader-journal-model.js';
import { isResourceLedger } from '../src/web-ui/routes/verse/usage/fleet-ledger-model.js';
import { isRunsHistory } from '../src/web-ui/routes/verse/fleet-capacity/capacity-queries.js';
import { isReleasePrData } from '../src/web-ui/routes/verse/fleet/release-pr-query.js';
import { narrowRunsSwitches } from '../src/web-ui/routes/verse/fleet/runs-switches-queries.js';
import { narrowBusFeed } from '../src/web-ui/routes/verse/fleet/bus-feed-queries.js';
import { narrowFleetControl, narrowFleetQueue } from '../src/web-ui/routes/verse/fleet/fleet-control-queries.js';
import { narrowExecutionFeedbackRead } from '../src/web-ui/routes/verse/fleet/execution-feedback-model.js';
import { narrowExecutionCaseRead } from '../src/web-ui/routes/verse/fleet/execution-case-model.js';
import { narrowGrokUltraRunway } from '../src/web-ui/routes/verse/fleet/GrokUltraRunway.js';
import { narrowInboxRead } from '../src/web-ui/routes/verse/mobile/inbox-read-query.js';
import { narrow } from '../src/web-ui/routes/verse/command/surface-data.js';
import { narrowThreadPage, narrowDirectives } from '../src/web-ui/routes/verse/leader/thread-model.js';
import { projectFleet } from '../src/web-ui/routes/verse/autonomy/fleet-model.js';
import { readSelfUpdate } from '../src/web-ui/routes/verse/shell/self-update-badge.js';

const TOKEN = 'day-one-smoke-token';
const CFG = {} as AshlrConfig;
const REPO = 'ashlrai/phantom';
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const utcStamp = (ms: number) => iso(ms).replace('T', ' ').slice(0, 19);
const localStamp = (ms: number) => {
  const d = new Date(ms); const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

// Fixture: the minimum ~/.ashlr-runs + ~/.ashlr the readers observe. Every
// value is plainly fake; timestamps are generated so "last hour" windows hit.
function writeFixture(home: string): string {
  const runs = join(home, '.ashlr-runs');
  const write = (rel: string, text: string, mode = 0o644) => {
    const file = join(runs, rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text, { mode });
  };
  write('queue/status.json', JSON.stringify({
    last_tick: iso(NOW - 60_000), paused: false, mem_free_pct: 41, autopilot: { disk: { free_gb: 24 } },
    lanes: {
      'codex-cmp': { running: 1, target: 2, queued: 3, floor: 0, ceiling: 4, held: false },
      claude: { running: 0, target: 1, queued: 0, floor: 0, ceiling: 2, held: true, held_reason: 'smoke hold' } },
    rollup_24h: { by_lane: { 'codex-cmp': { merged: 2, merge_rate: 0.5 }, claude: { merged: 0, merge_rate: 0 } } } }));
  write('queue/claimed.tsv', `job-smoke-1\tcodex-cmp\tmid\t14:05\t${Math.floor(NOW / 1000) - 60}\n`);
  write('queue/ready.tsv',
    `READY\tjob-smoke-ready\tcodex-cmp\tmid\tphantom\tSmoke ready job\n` +
    `PARKED-BYHAND.claude\tjob-smoke-parked\tclaude\tmid\tphantom\tSmoke parked job\n`);
  write('queue/precheck-skips.tsv', `${localStamp(NOW - 30_000)}\tjob-smoke-skip\tLANE\tunknown lane\n`);
  write('queue/slots.json', JSON.stringify({
    'codex-cmp': { target: 2, floor: 0, ceiling: 4, held: false, last_change: Math.floor(NOW / 1000) - 300, changed_by: `mason ${iso(NOW - 300_000)}` },
    claude: { target: 1, floor: 0, ceiling: 2, held: true, held_reason: 'smoke hold', held_by: `mason ${iso(NOW - 300_000)}`, last_change: Math.floor(NOW / 1000) - 300 },
  }));
  write('queue/claude-lane.state', 'smoke claude lane note\n');
  write('HOLD', ''); // sentinel: the HOLD switch reads on
  write('metrics/jobs.jsonl',
    `${JSON.stringify({ job: 'job-smoke-1', ts: iso(NOW - 60_000), lane: 'codex-cmp', event: 'finish', tokens_total: 1500 })}\n` +
    `${JSON.stringify({ job: 'job-smoke-2', ts: iso(NOW - 30_000), lane: 'codex-cmp', event: 'publish', class: 'pr', url: `https://github.com/${REPO}/pull/667` })}\n`);
  write('dispatch-events.log',
    `${utcStamp(NOW - 90_000)} LAUNCH job-smoke-1 codex-cmp\n` +
    `${utcStamp(NOW - 80_000)} ORCH-PASS codex-cmp\n` +
    `${utcStamp(NOW - 70_000)} INBOX new entry from Mason\n` +
    `${utcStamp(NOW - 60_000)} LANE_HOLD claude smoke hold\n` +
    `${utcStamp(NOW - 30_000)} PUBLISHED job-smoke-2\n`);
  write('leader/MASON-INBOX.md',
    `## ${utcStamp(NOW - 120_000)} ET (Mason, Telegram) PRIORITY P0\nWatch the codex lane tonight.\n` +
    `## ${utcStamp(NOW - 60_000)} ET (Mason, Phantom desktop) PRIORITY P1\nShip the smoke test first.\n`);
  write('leader/PLAN-LOG.md', `## ${utcStamp(NOW - 3_600_000)} plan\n**Dispatch**\n- keep codex-cmp warm\n`);
  write('leader/drop/done/.keep', ''); write('leader/drop/codex-cmp/job-smoke-drop.md', '# smoke drop job\n');
  write('leader/drop/ingest.log',
    `${iso(NOW - 120_000)} ingest job-smoke.md accepted\n${iso(NOW - 60_000)} reject bad-job.md missing lane\n`);
  write('leader/drop/ingested.tsv', `${iso(NOW - 100_000)}\tjob-smoke-ing\tleader\tcodex-cmp\tmid\tSmoke ingested job\n`);
  // ~/.ashlr side: the bus hop store wants a private 0700 chain.
  const ashlr = join(home, '.ashlr');
  for (const dir of [ashlr, join(ashlr, 'fleet'), join(ashlr, 'fleet', 'bus')]) {
    mkdirSync(dir, { recursive: true }); chmodSync(dir, 0o700); }
  writeFileSync(join(ashlr, 'fleet', 'bus', 'hops.jsonl'),
    `${JSON.stringify({ id: 'hop-1', from: 'leader', to: 'codex-cmp', inputTokens: 10, outputTokens: 4 })}\n` +
    `${JSON.stringify({ id: 'hop-2', from: 'codex-cmp', to: 'leader', inputTokens: null, outputTokens: null })}\n`,
    { mode: 0o600 });
  writeFileSync(join(ashlr, 'fleet', 'runs-history.jsonl'),
    `${JSON.stringify({ at: iso(NOW - 120_000), lanes: [{ lane: 'codex-cmp', running: 1, target: 2, queued: 3, held: false }], workers: 1, leaders: 0, paused: false })}\n`,
    { mode: 0o600 });
  // The enrolled checkout probed by /ops/releases and /release-pr.
  const repo = join(home, 'checkouts', 'phantom');
  mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: '@ashlr/phantom', version: '3.30.0' }));
  writeFileSync(join(repo, '.github', 'workflows', 'release-please.yml'), 'name: release-please\n');
  return repo;
}

// Injected git/gh runner: the only command surface these routes own, replaced
// so the test never reaches the network. Release probing only.
const opsRunner = async (bin: string, args: readonly string[]): Promise<string | null> => {
  const key = `${bin} ${args.join(' ')}`;
  if (bin === 'git' && key.includes('remote')) return `git@github.com:${REPO}.git\n`;
  if (bin === 'git' && key.includes('describe')) return 'v3.29.0\n';
  if (bin === 'git' && key.includes('rev-list')) return '42\n';
  if (bin === 'git' && key.includes('tag')) return 'v3.29.0\nv3.28.0\n';
  if (bin === 'gh' && key.includes('pr')) return JSON.stringify([{
    number: 667, title: 'chore(main): release 3.30.0', url: `https://github.com/${REPO}/pull/667`,
    createdAt: iso(NOW - 86_400_000), updatedAt: iso(NOW - 3_600_000), mergeable: 'MERGEABLE',
    headRefName: 'release-please--branches--main',
    statusCheckRollup: [{ name: 'gate', conclusion: 'SUCCESS', detailsUrl: `https://github.com/${REPO}/actions/runs/1` }],
  }]) + '\n';
  if (bin === 'gh' && key.includes('release'))
    return JSON.stringify([{ tagName: 'v3.29.0', name: 'v3.29.0', publishedAt: iso(NOW - 604_800_000), isDraft: false, isPrerelease: false }]) + '\n';
  if (bin === 'gh' && key.includes('run'))
    return JSON.stringify([{ status: 'completed', conclusion: 'success', createdAt: iso(NOW - 604_800_000), displayTitle: 'release-please' }]) + '\n';
  return null;
};

// Daemon/authority inputs for fleet control — deterministic, no launchctl,
// no custody or service probes on the host.
const AUTHORITY: AuthorityStatusV1 = {
  v: 1, checkedAt: iso(NOW), switch: 'propose', effectiveSwitch: 'off', maxSwitchWithoutGrant: 'off',
  kill: false, rollout: null, policy: null,
  grant: { state: 'none', reason: null, grantId: null, grantSeq: null, keyId: null, issuedAt: null, expiresAt: null, repos: [], engines: [], maxMode: null, stageIds: [] },
  ledger: { state: 'empty', head: null, reason: null },
  custody: { installed: null, keyInitialized: null, githubApp: null, claudeToken: null } };
const NOOP = { ok: false as const, reason: 'not exercised by the day-one smoke' };
const CONTROL_DEPS: FleetControlDeps = {
  now: Date.now, authority: async () => AUTHORITY, pause: () => ({ paused: false, pausedAt: null }),
  liveness: () => ({ state: 'unknown', pid: null, lastTickAt: null, reason: 'smoke test has no daemon' }),
  service: async () => ({ service: 'unknown', plist: 'unknown' }), working: () => null,
  spend: async () => ({ todayUsd: null, capUsd: null }), hubCheckout: async () => null,
  trustRootsCompiled: () => false, setPause: () => ({ ...NOOP, changed: false }),
  stop: async () => ({ armed: false, reason: NOOP.reason, aborted: null }), clearStop: () => NOOP,
  raiseSwitch: () => ({ ...NOOP, code: null }), cancelRun: () => NOOP, editTask: () => NOOP,
  cancelTask: () => NOOP, enqueueTask: () => NOOP, tasks: () => ({ ok: true, tasks: [] }),
  goals: async () => [], retargetGoal: async () => NOOP, enrolledPaths: async () => [],
  grantedRepos: async () => [],
  readRunLog: async () => ({ available: false, reason: 'no stream for this run', lines: [], truncated: false }),
};

// A healthy execution-feedback reading, as the projection worker would build.
const FB_DIGEST = 'a'.repeat(64);
const FB_CASE = 'b'.repeat(64);
const FB_COUNTS = { 'producer-succeeded': 1, failed: 1, cancelled: 0, refused: 0, 'empty-diff': 0, disabled: 0, unknown: 0 };
const feedbackView: ExecutionFeedbackView = {
  schemaVersion: 1, sourceState: 'healthy', complete: true, digest: FB_DIGEST,
  window: { since: iso(NOW - 3_600_000), through: iso(NOW) }, observedThrough: iso(NOW),
  counts: FB_COUNTS, observedCounts: FB_COUNTS,
  cases: [{ caseId: FB_CASE, endedAt: iso(NOW - 60_000), outcome: 'failed', failureKind: 'engine', proposalRecorded: false }],
  coverage: { legacyRows: 0, invalidAttempts: 0, conflictingAttempts: 0, duplicateRows: 0, invalidTimestamps: 0, proposalSource: 'healthy' },
};
const caseDetail: ExecutionFeedbackCaseDetail = {
  schemaVersion: 1, caseId: FB_CASE, outcome: 'failed', endedAt: iso(NOW - 60_000), shipping: 'not-recorded', digest: 'c'.repeat(64),
  coverage: { dispatch: 'healthy', proposals: 'healthy', ledger: 'healthy', invalidRecords: 0, conflictingRecords: 0 },
  timeline: [
    { stage: 'produced', result: 'recorded', basis: 'dispatch-final', at: iso(NOW - 90_000) },
    { stage: 'verified', result: 'failed', basis: 'proposal-verification', at: iso(NOW - 60_000) } ],
};
const readProjections = {
  read: async (kind: string) => {
    if (kind === 'execution-feedback') return feedbackView;
    if (kind === 'execution-feedback-case') return caseDetail;
    throw new Error(`no projection for ${kind}`);
  },
  invalidate: async () => undefined, close: async () => undefined } as unknown as ReadProjectionReader;

// Harness: the same mock req/res the module tests use, driven through the
// real dispatch order — control routes first (web/api.ts), then verse-api.
const ctx: VerseApiContext = { cfg: CFG, token: TOKEN, allowDispatch: false, readProjections };

type Wire = Record<string, unknown> | null;
async function get(pathname: string): Promise<{ handled: boolean; status: number; wire: Wire }> {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.url = pathname; req.method = 'GET';
  req.headers = { 'content-type': 'application/json', 'x-ashlr-token': TOKEN };
  let status = 0;
  let wire: Wire = null;
  const res = {
    headersSent: false,
    setHeader() { /* sendJson writes headers via writeHead; nothing else sets one */ },
    writeHead(code: number) { status = code; this.headersSent = true; },
    end(text?: string) { try { wire = JSON.parse(text ?? ''); } catch { wire = null; } },
  } as unknown as ServerResponse;
  const path = pathname.split('?')[0]!;
  const handled = (await handleVerseControlApi(ctx, req, res, path, 'GET')) || (await handleVerseApi(ctx, req, res, path, 'GET'));
  return { handled, status, wire };
}

/** Mount the real modules, stubbing only the network/auth-dir seams. */
function installMounts(repo: string): void {
  setWorkbenchApiModulesForTest(workbenchApiModules().map((entry) => {
    if (entry.id === 'fleet-runs') return { ...entry, load: async () => createFleetRunsApi({
      mergedLastHour: async () => ({ count: 1, items: [{ repo: REPO, number: 42, title: 'Smoke merge' }] }),
      codexPersonal: async () => ({ usedPct: null, resetsAt: null, asOf: null }) }) };
    if (entry.id === 'ops') return { ...entry, load: async () => createOpsApi({ enrolled: () => [repo], releaseDeps: { run: opsRunner, identity: () => REPO } }) };
    return entry;
  }));
  setMountedApiModulesForTest(mountedApiModules().map((entry) =>
    entry.id === 'release-pr' ? { ...entry, load: async () => createReleasePrApi({ enrolled: () => [repo], run: opsRunner }) } : entry));
  setFleetControlDepsForTest(CONTROL_DEPS);
}

const resetModuleState = async () => {
  resetFleetLiveApiForTest(); resetLeaderApiCacheForTest(); _resetExecutionFeedbackCacheForTest();
  await resetFleetHistoryServiceForTests();
};

// The walk: pane route → the validator that pane applies to the response.
// `missing` asserts the documented empty-home shape where the wire has one.
type Walk = { route: string; pane: string; check: (wire: Wire) => boolean; missing?: (wire: Wire) => void };
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const sources = (w: Wire) => (record(w?.['sources']) ? w!['sources'] : {});
const COLUMN = (v: unknown) => v === 'next' || v === 'active' || v === 'held' || v === 'done' || v === 'closed';
const taskRow = (v: unknown): boolean => record(v) && typeof v['id'] === 'string'
  && ['fleet', 'handoff', 'companion'].includes(String(v['source'])) && typeof v['title'] === 'string'
  && (v['repo'] === null || typeof v['repo'] === 'string') && COLUMN(v['column'])
  && (v['assignee'] === null || typeof v['assignee'] === 'string') && (v['estimate'] === null || typeof v['estimate'] === 'string')
  && (v['outcome'] === null || (record(v['outcome']) && typeof v['outcome']['state'] === 'string' && (v['outcome']['text'] === null || typeof v['outcome']['text'] === 'string')))
  && typeof v['needsYou'] === 'boolean' && typeof v['updatedAt'] === 'string';
const throwing = (fn: (w: Wire) => unknown) => (w: Wire) => { try { return fn(w) !== null; } catch { return false; } };

const WALKS: Walk[] = [
  { route: '/api/verse/fleet', pane: 'autonomy/fleet-model:projectFleet', check: (w) => projectFleet(w) !== null },
  { route: '/api/verse/fleet/runs', pane: 'ops/ops-runs-model:isFleetRuns', check: (w) => isFleetRuns(w),
    missing: (w) => expect(sources(w)['runsDir']).toBe('missing') },
  { route: '/api/verse/fleet/runs/inbox?limit=100', pane: 'mobile/inbox-read-query:narrowInboxRead', check: (w) => narrowInboxRead(w) !== null,
    missing: (w) => expect(w?.['sourceState']).toBe('missing') },
  { route: '/api/verse/fleet/live', pane: 'command/surface-data:narrow.fleetLive', check: (w) => narrow.fleetLive(w) !== null },
  { route: '/api/verse/fleet/live/bus?limit=50', pane: 'fleet/bus-feed-queries:narrowBusFeed', check: (w) => narrowBusFeed(w) !== null,
    missing: (w) => expect([sources(w)['hops'], sources(w)['events']]).toEqual(['missing', 'missing']) },
  { route: '/api/verse/fleet/live/queue?limit=25', pane: 'ops/ops-queue-model:isFleetQueue', check: (w) => isFleetQueue(w),
    missing: (w) => expect(sources(w)['ready']).toBe('missing') },
  { route: '/api/verse/fleet/live/feedback', pane: 'fleet/execution-feedback-model:narrowExecutionFeedbackRead', check: (w) => narrowExecutionFeedbackRead(w) !== null },
  { route: '/api/verse/fleet/control', pane: 'fleet/fleet-control-queries:narrowFleetControl', check: (w) => narrowFleetControl(w) !== null },
  { route: '/api/verse/fleet/control/lanes', pane: 'ops/lane-targets-model:isLaneTargets', check: (w) => isLaneTargets(w),
    missing: (w) => expect(w?.['sourceState']).toBe('missing') },
  { route: '/api/verse/fleet/control/switches', pane: 'fleet/runs-switches-queries:narrowRunsSwitches', check: throwing(narrowRunsSwitches),
    missing: (w) => {
      expect(w?.['sourceState']).toBe('missing');
      expect((w?.['switches'] as unknown[]).every((s) => record(s) && s['on'] === false)).toBe(true); } },
  { route: '/api/verse/fleet/control/queue', pane: 'fleet/fleet-control-queries:narrowFleetQueue', check: (w) => narrowFleetQueue(w) !== null },
  { route: '/api/verse/fleet/control/runs/smoke-run-1/log', pane: 'fleet run-log read (shape — the pane has no narrow)',
    check: (w) => record(w) && w['v'] === 1 && typeof w['runId'] === 'string' && typeof w['available'] === 'boolean' && Array.isArray(w['lines']) },
  { route: '/api/verse/fleet/history', pane: 'command/surface-data:narrow.fleetHistory', check: (w) => narrow.fleetHistory(w) !== null },
  { route: '/api/verse/fleet/grok-ultra', pane: 'fleet/GrokUltraRunway:narrowGrokUltraRunway', check: (w) => narrowGrokUltraRunway(w) !== null },
  { route: '/api/verse/leader', pane: 'command/surface-data:narrow.leader', check: (w) => narrow.leader(w) !== null },
  { route: '/api/verse/leader/resources', pane: 'usage/fleet-ledger-model:isResourceLedger', check: (w) => isResourceLedger(w) },
  { route: '/api/verse/leader/thread?limit=50', pane: 'leader/thread-model:narrowThreadPage', check: (w) => narrowThreadPage(w) !== null },
  { route: '/api/verse/leader/directives', pane: 'leader/thread-model:narrowDirectives', check: (w) => narrowDirectives(w) !== null },
  {
    route: '/api/verse/ops/board', pane: 'ops/ops-queries:opsBoardQuery gate (mirrored — it sits inside fetch)',
    check: (w) => record(w) && w['v'] === 1 && record(w['columns']) && record(w['counts']) && record(w['sources'])
      && ['next', 'active', 'held', 'done', 'closed'].every((c) => Array.isArray(w['columns'][c]) && (w['columns'][c] as unknown[]).every(taskRow) && typeof w['counts'][c] === 'number')
      && ['fleet', 'handoff', 'companion'].every((s) => ['healthy', 'degraded'].includes(String(w['sources'][s]))),
  },
  {
    route: '/api/verse/ops/fleet', pane: 'ops/ops-queries:opsFleetQuery gate (mirrored — it sits inside fetch)',
    check: (w) => record(w) && w['v'] === 1 && record(w['sources'])
      && ['tick', 'journal', 'learning'].every((s) => ['healthy', 'degraded'].includes(String(w['sources'][s])))
      && (w['lanes'] === null || Array.isArray(w['lanes'])) && Array.isArray(w['held']) && Array.isArray(w['decisions']) && Array.isArray(w['experiments']),
  },
  { route: '/api/verse/ops/releases', pane: 'fleet-releases/fleet-releases-model:isOpsReleases', check: (w) => isOpsReleases(w) },
  {
    route: '/api/verse/ops/leaders', pane: 'ops/ops-queries:opsLeadersQuery gate (mirrored — it sits inside fetch)',
    check: (w) => record(w) && w['v'] === 1 && typeof w['canPost'] === 'boolean'
      && ['leaders', 'messages', 'channels', 'openHandoffs', 'pendingApprovals'].every((k) => Array.isArray(w[k])),
  },
  { route: '/api/verse/ops/leader-journal', pane: 'leader-journal/leader-journal-model:isLeaderJournal', check: (w) => isLeaderJournal(w) },
  { route: '/api/verse/ops/self-update', pane: 'shell/self-update-badge:readSelfUpdate', check: (w) => readSelfUpdate(w) !== null },
  { route: '/api/verse/release-pr', pane: 'fleet/release-pr-query:isReleasePrData', check: (w) => isReleasePrData(w) },
  { route: '/api/verse/runs-history', pane: 'fleet-capacity/capacity-queries:isRunsHistory', check: (w) => isRunsHistory(w) },
];

describe('verse fleet day-one smoke', { timeout: 30_000 }, () => {
  const ambientHome = process.env['HOME']!;
  const ambientAshlr = process.env['ASHLR_HOME'];
  let repo = '';

  beforeEach(async () => {
    const home = mkdtempSync(join(ambientHome, 'day-one-'));
    process.env['HOME'] = home;
    process.env['ASHLR_HOME'] = join(home, '.ashlr');
    repo = writeFixture(home);
    installMounts(repo);
    await resetModuleState();
  });

  afterEach(async () => {
    setWorkbenchApiModulesForTest(null);
    setMountedApiModulesForTest(null);
    setFleetControlDepsForTest(null);
    process.env['HOME'] = ambientHome;
    if (ambientAshlr === undefined) delete process.env['ASHLR_HOME']; else process.env['ASHLR_HOME'] = ambientAshlr;
    await resetModuleState();
  });

  // Walks WALKS through real dispatch; returns per-route failure lines.
  const walkAll = async (assertMissing: boolean): Promise<string[]> => {
    const failures: string[] = [];
    for (const walk of WALKS) {
      const { handled, status, wire } = await get(walk.route);
      if (!handled) { failures.push(`${walk.route}: not handled`); continue; }
      if (status !== 200) { failures.push(`${walk.route}: HTTP ${status} ${JSON.stringify(wire)}`); continue; }
      if (!walk.check(wire)) { failures.push(`${walk.route}: ${walk.pane} rejects ${JSON.stringify(wire)?.slice(0, 300)}`); continue; }
      if (assertMissing) { try { walk.missing?.(wire); } catch (e) { failures.push(`${walk.route}: ${(e as Error).message}`); } }
    }
    return failures;
  };

  it('answers every fleet read with the shape its pane validates, on a real runs dir', async () => {
    const failures = await walkAll(false);
    // The feedback read warms, then serves the projection reading.
    const tick = () => new Promise((done) => setImmediate(done));
    const wireCase = `h:${FB_CASE.match(/.{16}/g)!.join(':')}`;
    await get('/api/verse/fleet/live/feedback'); await tick();
    const feedback = (await get('/api/verse/fleet/live/feedback')).wire;
    if (feedback?.['state'] !== 'current') failures.push(`feedback never reached current: ${JSON.stringify(feedback)}`);
    else {
      const cases = (feedback['feedback'] as { cases?: { caseId?: string }[] }).cases ?? [];
      if (cases[0]?.caseId !== wireCase) failures.push(`feedback case id drifted: ${cases[0]?.caseId}`);
    }
    const casePath = `/api/verse/fleet/live/feedback/cases/${wireCase}`;
    await get(casePath); await tick(); // warm the case entry
    const caseRead = await get(casePath);
    if (caseRead.status !== 200 || narrowExecutionCaseRead(caseRead.wire, wireCase) === null)
      failures.push(`feedback case read: HTTP ${caseRead.status} ${JSON.stringify(caseRead.wire)?.slice(0, 300)}`);
    // The fixture proves the readers saw real data, not just a valid shape.
    const runs = (await get('/api/verse/fleet/runs')).wire;
    expect(runs?.['lanes']).toHaveLength(2);
    expect(runs?.['inbox']).toHaveLength(2);
    expect(failures).toEqual([]);
  });

  it('answers the same walk with documented missing shapes when the runs dir does not exist', async () => {
    const home = mkdtempSync(join(ambientHome, 'day-one-empty-'));
    process.env['HOME'] = home;
    process.env['ASHLR_HOME'] = join(home, '.ashlr');
    installMounts(repo); // fresh module instances → fresh response caches
    await resetModuleState();
    expect(await walkAll(true)).toEqual([]);
  });
});
