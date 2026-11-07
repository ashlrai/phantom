/**
 * radar/local-bench.ts — loopback-only local-model classification bench.
 *
 * Scores small local models (default candidates: LFM3 1.7B, d1 2B) on the
 * checked-in triage, routing and CI-failure bucketing fixtures, beside the
 * incumbent local tier (`DEFAULT_LOCAL_MODEL_TAG`). The verdict on every case
 * is an exact label match decided by this code — a model never judges a model.
 *
 * THE ONE RULE: the bench only ever talks to a loopback endpoint. The base URL
 * is validated before any fetch and before any file is written; a non-loopback
 * endpoint is refused outright (same predicate the local-only spend guard
 * uses). Loopback inference is provably free, so "dollars saved" is computed
 * against the repository's standard would-be-cloud reference price
 * (`estCostUsd` on 'anthropic', the same figure forecast.ts reports as
 * localSavingsUsd), scaled to 100 jobs at the measured accuracy. It is an
 * ESTIMATE for the dev-cycle dashboard, never a billing claim.
 *
 * Results are written as `ashlr.radar-local-bench.v1` JSON (mode 0600). The
 * `devCycleDashboard` block carries one bounded-label gauge sample per
 * (suite, model) under the `phantom_cycle_*` naming the engineering-cycle
 * dashboard contract uses; an external exporter may surface it there. This
 * bench emits no telemetry itself.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLoopbackEndpoint } from '../policy/local-only.js';
import { estCostUsd } from '../run/budget.js';
import { DEFAULT_LOCAL_MODEL_TAG } from '../run/model-catalog.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LOCAL_BENCH_SCHEMA = 'ashlr.radar-local-bench.v1';

/** The provider key whose published price is the would-be-cloud reference. */
const CLOUD_REFERENCE_SUBJECT = 'anthropic';

/** Fixed suite order in the report and on the dashboard samples. */
export const BENCH_SUITES = ['triage', 'routing', 'ci-failure'] as const;
export type BenchSuiteId = (typeof BENCH_SUITES)[number];

/** Metric name the dev-cycle dashboard reads, per docs/observability/README.md naming. */
export const DEV_CYCLE_SAVINGS_METRIC = 'phantom_cycle_local_model_dollars_saved_per_100_jobs';

/** Candidate tags the job names; overridable with --models. */
export const DEFAULT_CANDIDATE_MODELS = ['lfm3:1.7b', 'd1:2b'] as const;

export const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
export const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;
/** Chat replies are a single label; a sane ceiling on the whole response body. */
const MAX_RESPONSE_BYTES = 256 * 1024;
/** One label, no reasoning. */
const MAX_COMPLETION_TOKENS = 24;
/** Fixture token hints used only when the endpoint reports no usage. */
const FALLBACK_TOKENS_IN = 220;
const FALLBACK_TOKENS_OUT = 4;

// ---------------------------------------------------------------------------
// Fixture parsing — fail closed, never infer
// ---------------------------------------------------------------------------

export interface BenchCase {
  readonly id: string;
  /** The fixture text handed to the model. */
  readonly input: string;
  /** The required answer: exactly one of `labels`. */
  readonly expected: string;
  /** Optional token estimates for the savings math when usage is unreported. */
  readonly tokensIn?: number;
  readonly tokensOut?: number;
}

export interface BenchSuiteFixture {
  readonly suite: BenchSuiteId;
  readonly labels: readonly string[];
  /** Instruction block prepended to every case prompt. */
  readonly instruction: string;
  readonly cases: readonly BenchCase[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function idString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function labelString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 &&
    /^[a-z0-9][a-z0-9:_-]*$/i.test(value);
}

function tokenHint(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000
    ? value : undefined;
}

/**
 * Parse one decoded suite fixture. Anything malformed — wrong schema, unknown
 * suite, missing cases, a case whose `expected` is not in `labels`, duplicate
 * ids — throws, because a partial or ambiguous fixture must never be scored
 * as if it were the suite.
 */
export function parseBenchFixture(body: unknown): BenchSuiteFixture {
  if (!isRecord(body) || body['schema'] !== LOCAL_BENCH_SCHEMA) {
    throw new Error('fixture is not ashlr.radar-local-bench.v1');
  }
  const suite = body['suite'];
  if (typeof suite !== 'string' || !(BENCH_SUITES as readonly string[]).includes(suite)) {
    throw new Error(`fixture suite must be one of ${BENCH_SUITES.join(', ')}`);
  }
  const labels = body['labels'];
  if (!Array.isArray(labels) || labels.length < 2 || !labels.every(labelString) || new Set(labels).size !== labels.length) {
    throw new Error('fixture labels must be two or more unique label strings');
  }
  const instruction = body['instruction'];
  if (typeof instruction !== 'string' || instruction.trim().length === 0 || instruction.length > 8_000) {
    throw new Error('fixture instruction is missing or oversized');
  }
  const rawCases = body['cases'];
  if (!Array.isArray(rawCases) || rawCases.length === 0 || rawCases.length > 500) {
    throw new Error('fixture must carry 1-500 cases');
  }
  const seen = new Set<string>();
  const labelSet = new Set(labels as string[]);
  const cases = rawCases.map((entry: unknown, index: number): BenchCase => {
    const at = `cases[${index}]`;
    if (!isRecord(entry) || !idString(entry['id'])) throw new Error(`invalid case id at ${at}`);
    const id = entry['id'];
    if (seen.has(id)) throw new Error(`duplicate case id at ${at}`);
    seen.add(id);
    if (typeof entry['input'] !== 'string' || entry['input'].trim().length === 0 || entry['input'].length > 24_000) {
      throw new Error(`invalid case input at ${at}`);
    }
    if (typeof entry['expected'] !== 'string' || !labelSet.has(entry['expected'])) {
      throw new Error(`case ${id} expects a label outside the suite labels`);
    }
    const tokensIn = tokenHint(entry['tokensIn']);
    const tokensOut = tokenHint(entry['tokensOut']);
    if (entry['tokensIn'] !== undefined && tokensIn === undefined) throw new Error(`invalid tokensIn at ${at}`);
    if (entry['tokensOut'] !== undefined && tokensOut === undefined) throw new Error(`invalid tokensOut at ${at}`);
    return { id, input: entry['input'], expected: entry['expected'], ...(tokensIn !== undefined ? { tokensIn } : {}), ...(tokensOut !== undefined ? { tokensOut } : {}) };
  });
  return { suite: suite as BenchSuiteId, labels: labels as string[], instruction: instruction.trim(), cases };
}

// ---------------------------------------------------------------------------
// Loopback guard — the acceptance property
// ---------------------------------------------------------------------------

export class NonLoopbackEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonLoopbackEndpointError';
  }
}

/**
 * Validate the bench endpoint and return its normalised ORIGIN — any path,
 * query or fragment the operator appended is dropped, because the bench owns
 * the paths it calls.
 *
 * Refuses before anything else can happen: non-http(s) schemes, credentials,
 * and — the point — every hostname that is not this machine. Uses `isLoopbackEndpoint` from the local-only spend guard so the
 * bench and the dispatcher share one definition of "cannot bill anyone".
 */
export function assertLoopbackBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new NonLoopbackEndpointError('bench endpoint is not a parseable URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NonLoopbackEndpointError(`bench endpoint must be http(s), got ${url.protocol}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new NonLoopbackEndpointError('bench endpoint must not carry credentials');
  }
  if (!isLoopbackEndpoint(url.origin)) {
    throw new NonLoopbackEndpointError(
      'bench endpoint is not loopback: this script only scores models on this machine and never calls a remote or metered endpoint',
    );
  }
  return url.origin;
}

// ---------------------------------------------------------------------------
// Answer extraction — exact label match, a model never grades a model
// ---------------------------------------------------------------------------

/**
 * Reduce a chat reply to one suite label, or null when the reply is not an
 * answer the bench can trust. Case-insensitive; tolerates one surrounding
 * punctuation/markdown noise but never substring-matches prose — a reply that
 * embeds a label inside a sentence did not answer the question.
 */
export function extractLabel(answer: string, labels: readonly string[]): string | null {
  const first = answer.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '';
  const cleaned = first.replace(/^[>*_`"'([]+|[)\].,;:!*_`"']+$/g, '').trim().toLowerCase();
  const byLower = new Map(labels.map((label) => [label.toLowerCase(), label]));
  const direct = byLower.get(cleaned);
  if (direct) return direct;
  // A reply like "label: work:fleet" or "answer is local" still named exactly
  // one label. Split on whitespace only — labels contain ':' — and strip
  // separators at token edges. Any earlier token naming a DIFFERENT label
  // makes the reply ambiguous, so the whole answer is rejected.
  const tokens = cleaned.split(/\s+/).map((t) => t.replace(/^[:=]+|[:=.,;]+$/g, ''));
  const tail = tokens.at(-1) ?? '';
  const viaTail = byLower.get(tail);
  if (viaTail && tokens.slice(0, -1).every((token) => !byLower.has(token))) return viaTail;
  return null;
}

// ---------------------------------------------------------------------------
// The one network call
// ---------------------------------------------------------------------------

export interface ChatAnswer {
  /** Raw reply text. */
  readonly text: string;
  /** Reported usage, when the endpoint reports it; nulls otherwise. */
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly wallMs: number;
}

/** Result of one model on one case. */
export interface ScoredCase {
  readonly id: string;
  readonly expected: string;
  readonly answered: string | null;
  readonly correct: boolean;
  readonly wallMs: number;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  /** 'transport' marks an endpoint error rather than a wrong answer. */
  readonly error: 'transport' | null;
}

async function chatCompletion(
  fetchImpl: typeof fetch,
  baseUrl: string,
  model: string,
  instruction: string,
  input: string,
  timeoutMs: number,
): Promise<ChatAnswer> {
  const started = Date.now();
  const res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: instruction },
        { role: 'user', content: input },
      ],
      temperature: 0,
      max_tokens: MAX_COMPLETION_TOKENS,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const wallMs = Date.now() - started;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_RESPONSE_BYTES) { await res.body?.cancel(); throw new Error('oversized response'); }
  const raw = await res.text();
  if (raw.length > MAX_RESPONSE_BYTES) throw new Error('oversized response');
  const body = JSON.parse(raw) as unknown;
  if (!isRecord(body) || !Array.isArray(body['choices']) || body['choices'].length === 0) {
    throw new Error('malformed chat response');
  }
  const choice = body['choices'][0];
  const message = isRecord(choice) && isRecord(choice['message']) ? choice['message'] : null;
  const text = message && typeof message['content'] === 'string' ? message['content'] : '';
  const usage = isRecord(body['usage']) ? body['usage'] : null;
  const count = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
  return {
    text,
    promptTokens: usage ? count(usage['prompt_tokens']) : null,
    completionTokens: usage ? count(usage['completion_tokens']) : null,
    wallMs,
  };
}

/**
 * Score one model on one suite. Transport failures are recorded per case as
 * `error: 'transport'` — they are not wrong answers, and they are not passes.
 * Sequentially, never in parallel: the runtime shares this machine.
 */
export async function scoreSuite(
  fetchImpl: typeof fetch,
  baseUrl: string,
  model: string,
  fixture: BenchSuiteFixture,
  timeoutMs: number,
): Promise<ScoredCase[]> {
  const out: ScoredCase[] = [];
  for (const benchCase of fixture.cases) {
    try {
      const answer = await chatCompletion(fetchImpl, baseUrl, model, fixture.instruction, benchCase.input, timeoutMs);
      const answered = extractLabel(answer.text, fixture.labels);
      out.push({
        id: benchCase.id, expected: benchCase.expected, answered,
        correct: answered !== null && answered === benchCase.expected,
        wallMs: answer.wallMs, promptTokens: answer.promptTokens, completionTokens: answer.completionTokens,
        error: null,
      });
    } catch {
      out.push({
        id: benchCase.id, expected: benchCase.expected, answered: null,
        correct: false, wallMs: 0, promptTokens: null, completionTokens: null, error: 'transport',
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scoring + savings math (pure)
// ---------------------------------------------------------------------------

/**
 * Would-be-cloud cost of one case: measured usage wins, the fixture's token
 * hints are next, then the small flat fallback. Never invents precision —
 * the report names which source fed the estimate.
 */
function caseCloudCost(scored: ScoredCase, benchCase: BenchCase): number {
  const inTok = scored.promptTokens ?? benchCase.tokensIn ?? FALLBACK_TOKENS_IN;
  const outTok = scored.completionTokens ?? benchCase.tokensOut ?? FALLBACK_TOKENS_OUT;
  return estCostUsd(CLOUD_REFERENCE_SUBJECT, inTok, outTok);
}

export interface SuiteArmResult {
  readonly model: string;
  readonly cases: number;
  readonly answered: number;
  readonly correct: number;
  readonly transportErrors: number;
  readonly accuracy: number | null;
  readonly meanWallMs: number | null;
  readonly usageSource: 'measured' | 'fixture-hint' | 'unavailable';
  /**
   * Estimated dollars saved per 100 jobs if this model handled this suite's
   * job class instead of the would-be-cloud reference: accuracy × the cloud
   * cost those jobs would have incurred. Loopback inference is $0; an
   * unanswered or transport-failed case saves nothing AND blocks a job.
   */
  readonly dollarsSavedPer100Jobs: number | null;
  /** Accuracy minus the incumbent's accuracy on this suite; null without an incumbent baseline or when either arm hit transport errors. */
  readonly accuracyDeltaVsIncumbent: number | null;
  readonly perCase: readonly ScoredCase[];
}

export function summarizeArm(
  model: string,
  fixture: BenchSuiteFixture,
  scored: readonly ScoredCase[],
  incumbentAccuracy: number | null,
): SuiteArmResult {
  const cases = fixture.cases.length;
  const correct = scored.filter((c) => c.correct).length;
  const transportErrors = scored.filter((c) => c.error === 'transport').length;
  const answered = scored.filter((c) => c.error === null).length;
  const walls = scored.map((c) => c.wallMs).filter((ms) => ms > 0);
  // Accuracy is only meaningful against transport-error-free evidence.
  const accuracy = transportErrors === 0 && cases > 0 ? correct / cases : null;
  const measured = scored.every((c) => c.promptTokens !== null && c.completionTokens !== null);
  const hinted = fixture.cases.every((c) => c.tokensIn !== undefined && c.tokensOut !== undefined);
  const usageSource = measured ? 'measured' : hinted ? 'fixture-hint' : 'unavailable';
  const dollars = accuracy === null
    ? null
    : (scored.reduce((sum, c, i) => sum + (c.correct ? caseCloudCost(c, fixture.cases[i]!) : 0), 0) / cases) * 100;
  return {
    model, cases, answered, correct, transportErrors, accuracy,
    meanWallMs: walls.length ? walls.reduce((a, b) => a + b, 0) / walls.length : null,
    usageSource, dollarsSavedPer100Jobs: dollars,
    accuracyDeltaVsIncumbent: accuracy !== null && incumbentAccuracy !== null ? accuracy - incumbentAccuracy : null,
    perCase: scored,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface DevCycleSample {
  readonly suite: BenchSuiteId;
  readonly model: string;
  readonly value: number;
  readonly correct: number;
  readonly cases: number;
}

/** One bounded-label gauge sample per (suite, model) — the dev-cycle record. */
export interface DevCycleDashboardRecord {
  readonly metric: typeof DEV_CYCLE_SAVINGS_METRIC;
  readonly kind: 'gauge';
  readonly unit: 'usd';
  readonly labels: { readonly pool: 'local' };
  readonly samples: readonly DevCycleSample[];
}

export interface SuiteReport {
  readonly suite: BenchSuiteId;
  readonly labels: readonly string[];
  readonly cases: number;
  readonly results: readonly SuiteArmResult[];
}

export interface LocalBenchReport {
  readonly schema: typeof LOCAL_BENCH_SCHEMA;
  readonly generatedAt: string;
  /** Normalised loopback origin; never a path, never credentials. */
  readonly endpoint: { readonly origin: string; readonly loopback: true };
  readonly incumbent: string;
  readonly suites: readonly SuiteReport[];
  readonly devCycleDashboard: DevCycleDashboardRecord;
  readonly transportErrors: number;
  readonly notes: readonly string[];
}

export function buildReport(
  origin: string,
  incumbent: string,
  suites: readonly SuiteReport[],
  generatedAt: string,
): LocalBenchReport {
  const samples: DevCycleSample[] = [];
  let transportErrors = 0;
  for (const suite of suites) {
    for (const arm of suite.results) {
      transportErrors += arm.transportErrors;
      if (arm.dollarsSavedPer100Jobs !== null) {
        samples.push({
          suite: suite.suite, model: arm.model,
          value: Math.round(arm.dollarsSavedPer100Jobs * 10_000) / 10_000,
          correct: arm.correct, cases: arm.cases,
        });
      }
    }
  }
  return {
    schema: LOCAL_BENCH_SCHEMA,
    generatedAt,
    endpoint: { origin, loopback: true },
    incumbent,
    suites,
    devCycleDashboard: {
      metric: DEV_CYCLE_SAVINGS_METRIC,
      kind: 'gauge',
      unit: 'usd',
      labels: { pool: 'local' },
      samples,
    },
    transportErrors,
    notes: [
      'Loopback-only: the endpoint hostname is validated before any request and before the results file is written.',
      'Scores are exact-label matches; a model never grades a model.',
      'Dollars saved per 100 jobs is an estimate at the repo\'s would-be-cloud reference price (estCostUsd on anthropic), accuracy-weighted. Local inference is $0; savings are what the same correct jobs would have cost on metered cloud.',
      'No capability, quality or billing claim is made beyond these fixtures.',
    ],
  };
}

const fmtUsd = (value: number | null): string => (value === null ? 'n/a' : `$${value.toFixed(4)}`);
const fmtAcc = (value: number | null): string => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);

/** Deterministic plain-text report. */
export function renderReport(report: LocalBenchReport): string {
  const lines = [
    'RADAR-LOCAL-BENCH',
    `Endpoint: ${report.endpoint.origin} (loopback-verified)`,
    `Incumbent local tier: ${report.incumbent}`,
    `Metric recorded for the dev-cycle dashboard: ${report.devCycleDashboard.metric} (${report.transportErrors === 0 ? 'clean run' : `${report.transportErrors} transport error(s)`})`,
  ];
  for (const suite of report.suites) {
    lines.push('', `Suite ${suite.suite} — ${suite.cases} cases, labels [${suite.labels.join(', ')}]`);
    for (const arm of suite.results) {
      lines.push(
        `  ${arm.model}: ${arm.correct}/${arm.cases} correct (${fmtAcc(arm.accuracy)}`
        + `${arm.accuracyDeltaVsIncumbent === null ? '' : `, ${arm.accuracyDeltaVsIncumbent >= 0 ? '+' : ''}${(arm.accuracyDeltaVsIncumbent * 100).toFixed(1)}pt vs incumbent`}`
        + `), ${arm.transportErrors} transport error(s), saved/100 jobs ${fmtUsd(arm.dollarsSavedPer100Jobs)}`
        + `, usage ${arm.usageSource}${arm.meanWallMs === null ? '' : `, ${Math.round(arm.meanWallMs)}ms mean`}`,
      );
    }
  }
  lines.push('', 'dev-cycle dashboard samples:');
  for (const s of report.devCycleDashboard.samples) {
    lines.push(`  ${report.devCycleDashboard.metric}{pool="local",suite="${s.suite}",model=${JSON.stringify(s.model)}} ${s.value} (${s.correct}/${s.cases})`);
  }
  return lines.join('\n');
}

/** Write the results file privately: 0600, even when overwriting an existing path. */
export function writeReportFile(path: string, report: LocalBenchReport): void {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(target, 0o600);
}

// ---------------------------------------------------------------------------
// CLI surface (the script is a thin wrapper over runLocalBench)
// ---------------------------------------------------------------------------

export class LocalBenchUsageError extends Error {}

export interface LocalBenchArgs {
  baseUrl: string;
  models: string[];
  incumbent: string;
  fixturesDir: string;
  out: string | null;
  timeoutMs: number;
}

const tagString = (value: string | undefined, flag: string): string => {
  if (!value || value.length > 200 || /[\s'"\\$`]/.test(value) || value.startsWith('-')) {
    throw new LocalBenchUsageError(`invalid ${flag}: expected a model tag`);
  }
  return value;
};

export function parseLocalBenchArgs(argv: readonly string[]): LocalBenchArgs {
  const args: LocalBenchArgs = {
    baseUrl: DEFAULT_BASE_URL,
    models: [...DEFAULT_CANDIDATE_MODELS],
    incumbent: DEFAULT_LOCAL_MODEL_TAG,
    fixturesDir: fileURLToPath(new URL('../../../test/fixtures/radar-local-bench/', import.meta.url)),
    out: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (seen.has(flag)) throw new LocalBenchUsageError(`duplicate option ${flag}`);
    seen.add(flag);
    const value = argv[i + 1];
    const take = (): string => {
      if (value === undefined || value.startsWith('--')) throw new LocalBenchUsageError(`${flag} requires a value`);
      i += 1;
      return value;
    };
    switch (flag) {
      case '--base-url': args.baseUrl = take(); break;
      case '--models': {
        const list = take().split(',').map((t) => t.trim()).filter((t) => t !== '');
        if (list.length === 0 || list.length > 16) throw new LocalBenchUsageError('--models expects 1-16 comma-separated tags');
        args.models = list.map((t) => tagString(t, flag));
        break;
      }
      case '--incumbent': args.incumbent = tagString(take(), flag); break;
      case '--fixtures': {
        const dir = take();
        if (dir.includes('\0')) throw new LocalBenchUsageError('invalid --fixtures');
        args.fixturesDir = dir;
        break;
      }
      case '--out': {
        const file = take();
        if (file.includes('\0')) throw new LocalBenchUsageError('invalid --out');
        args.out = file;
        break;
      }
      case '--timeout-ms': {
        const raw = take();
        if (!/^[1-9]\d*$/.test(raw)) throw new LocalBenchUsageError('invalid --timeout-ms');
        const n = Number(raw);
        if (!Number.isSafeInteger(n) || n > MAX_TIMEOUT_MS) throw new LocalBenchUsageError('--timeout-ms out of range');
        args.timeoutMs = n;
        break;
      }
      default: throw new LocalBenchUsageError(`unknown option ${flag}`);
    }
  }
  return args;
}

export interface LocalBenchDeps {
  readonly fetchImpl?: typeof fetch;
  readonly readFile?: (path: string) => string;
  readonly writeReport?: (path: string, report: LocalBenchReport) => void;
  readonly now?: () => Date;
  readonly out?: (text: string) => void;
  readonly err?: (text: string) => void;
}

async function readFixtureFiles(
  fixturesDir: string,
  readFile: (path: string) => string,
): Promise<BenchSuiteFixture[]> {
  const fixtures: BenchSuiteFixture[] = [];
  for (const suite of BENCH_SUITES) {
    const file = `${fixturesDir.replace(/\/+$/, '')}/${suite}.json`;
    const parsed = parseBenchFixture(JSON.parse(readFile(file)));
    if (parsed.suite !== suite) throw new Error(`fixture ${suite}.json declares suite ${parsed.suite}`);
    fixtures.push(parsed);
  }
  return fixtures;
}

/**
 * The bench. Validates the endpoint FIRST — a non-loopback base URL is a
 * usage refusal (exit 2) before any fetch or file write. Runs every arm
 * (incumbent + candidates) over every suite, writes the results file, and
 * prints the report. Exit 0 on a clean run, 1 on transport failures or
 * unreadable fixtures, 2 on usage errors.
 */
export async function runLocalBench(
  argv: readonly string[],
  deps: LocalBenchDeps = {},
): Promise<number> {
  const out = deps.out ?? ((text: string) => console.log(text));
  const err = deps.err ?? ((text: string) => console.error(text));
  let args: LocalBenchArgs;
  try {
    args = parseLocalBenchArgs(argv);
  } catch (error) {
    err(error instanceof Error ? error.message : 'invalid bench options');
    return 2;
  }
  let origin: string;
  try {
    origin = assertLoopbackBaseUrl(args.baseUrl);
  } catch (error) {
    err(error instanceof Error ? error.message : 'bench endpoint refused');
    return 2;
  }

  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const writeReport = deps.writeReport ?? writeReportFile;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());

  let fixtures: BenchSuiteFixture[];
  try {
    fixtures = await readFixtureFiles(args.fixturesDir, readFile);
  } catch {
    err('[radar-local-bench] fixture load failed; supply readable, valid suite fixtures');
    return 1;
  }

  const arms = [...new Set([args.incumbent, ...args.models])];
  // Arm-outer ordering: a serving runtime typically keeps only the current
  // model resident, so running each arm across every suite before switching
  // reloads each model once instead of once per suite.
  const scoredByArm = new Map<string, Map<BenchSuiteId, ScoredCase[]>>();
  for (const model of arms) {
    const perSuite = new Map<BenchSuiteId, ScoredCase[]>();
    for (const fixture of fixtures) {
      const scored = await scoreSuite(fetchImpl, origin, model, fixture, args.timeoutMs);
      perSuite.set(fixture.suite, scored);
      const transportErrors = scored.filter((c) => c.error === 'transport').length;
      err(`[radar-local-bench] ${model} ${fixture.suite}: ${scored.filter((c) => c.correct).length}/${fixture.cases.length} correct, ${transportErrors} transport error(s)`);
    }
    scoredByArm.set(model, perSuite);
  }
  const suites: SuiteReport[] = [];
  let failed = false;
  for (const fixture of fixtures) {
    let incumbentAccuracy: number | null = null;
    const results: SuiteArmResult[] = [];
    for (const model of arms) {
      const scored = scoredByArm.get(model)!.get(fixture.suite)!;
      const arm = summarizeArm(model, fixture, scored, model === args.incumbent ? null : incumbentAccuracy);
      if (model === args.incumbent) incumbentAccuracy = arm.accuracy;
      if (arm.transportErrors > 0) failed = true;
      results.push(arm);
    }
    suites.push({ suite: fixture.suite, labels: fixture.labels, cases: fixture.cases.length, results });
  }

  const report = buildReport(origin, args.incumbent, suites, now().toISOString());
  const target = args.out ?? `benchmarks/radar-local-bench-${now().toISOString().replace(/[:.]/g, '-')}.json`;
  try {
    writeReport(target, report);
  } catch {
    err('[radar-local-bench] results file could not be written');
    return 1;
  }
  out(renderReport(report));
  err(`[radar-local-bench] results written to ${target}`);
  return failed ? 1 : 0;
}
