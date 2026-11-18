/** Fixture `phm home --json` (home.v1), `phm fleet pulse --json` (fleet.pulse.v1) and `phm approvals` (approvals.asks.v1) payloads for the phone's Home tests: fake repos, lanes and asks only. */
import type { ApprovalsList } from '../../../../core/fleet/approvals.js';
import type { HomeSummary } from '../../../../core/fleet/home.js';
import type { PulseV1 } from '../../../../core/fleet/pulse.js';

const ok = <T,>(value: T) => ({ state: 'ok' as const, value });
const unknown = (reason: string) => ({ state: 'unknown' as const, reason });
const ask = (n: number, request: string, ageSeconds: number | null) => ({ id: `nm-${String(n).repeat(12)}`, shortId: String(n).repeat(4), kind: '2fa' as const, request, ageSeconds, answers: ['yes', 'no', 'done'] as const });

export type HomeFixture = 'quiet' | 'busy' | 'red' | 'needs' | 'unknown';

export function homeSummary(kind: HomeFixture): HomeSummary {
  const busy = kind !== 'quiet';
  const base: HomeSummary = {
    schema: 'home.v1', asOf: '2026-11-17T12:00:00.000Z', health: busy ? 'healthy' : 'stalled',
    headline: busy ? 'Healthy: 7 PRs merged in the last hour and main is green.' : 'Stalled: no PR merged in the last 60 minutes.',
    mergedLastHour: ok(busy ? 7 : 0), merged24h: ok(busy ? 143 : 0), medianMergeSeconds: busy ? ok(360) : unknown('No merged PR with a known publish time in the last 24 hours.'),
    main: ok([{ repo: 'phantom', state: 'green' }, { repo: 'locus', state: 'green' }]),
    running: ok(busy ? [{ lane: 'claude', running: 8, target: 8 }, { lane: 'codex-personal', running: 19, target: 20 }] : [{ lane: 'claude', running: 0, target: 8 }]),
    atRisk: ok(null), worklog: ok([]), unreadLeaderReplies: unknown('No last-read time was given, so replies cannot be counted as unread.'),
    needsYou: ok([]),
  };
  if (kind === 'red') return { ...base, health: 'red', headline: 'Main is red on phantom.', main: ok([{ repo: 'phantom', state: 'red' }, { repo: 'locus', state: 'green' }]) };
  if (kind === 'needs') return { ...base, needsYou: ok([
    ask(1, 'Enter the fake 2FA code for a-very-long-example-registry-name-that-must-wrap-on-a-narrow-phone.example', 240),
    ask(2, 'Approve the fake device', null), ask(3, 'Pay the fake invoice', 7200),
  ]) };
  if (kind === 'unknown') {
    const why = 'The job metrics file could not be read.';
    return { ...base, health: 'unknown', headline: `Unknown: ${why}`, mergedLastHour: unknown(why), merged24h: unknown(why),
      main: unknown('The main guardian status could not be read.'), running: unknown('No fleet status has been written yet.'), needsYou: unknown('The needs-you ledger could not be read.') };
  }
  return base;
}

const approval = (n: number, question: string, ageSeconds: number | null) => ({ id: `nm-${String(n).repeat(12)}`, ref: String(n).repeat(4), number: null,
  kind: '2fa' as const, question, options: ['yes', 'no', 'done'], askedBy: null, created: null, ageSeconds, expires: null });

/** The approvals card's read for the same fixture: what needs Mason, or unknown. */
export function approvalsList(kind: HomeFixture): ApprovalsList {
  const base: ApprovalsList = { schema: 'approvals.asks.v1', asOf: '2026-11-17T12:00:00.000Z', ledger: 'available', count: 0, approvals: [], expired: 0 };
  if (kind === 'unknown') return { ...base, ledger: 'unavailable' };
  if (kind !== 'needs') return base;
  const approvals = [
    approval(1, 'Enter the fake 2FA code for a-very-long-example-registry-name-that-must-wrap-on-a-narrow-phone.example', 240),
    approval(2, 'Approve the fake device', null), approval(3, 'Pay the fake invoice', 7200),
  ];
  return { ...base, count: approvals.length, approvals };
}

const none = (line: string) => ({ value: null, trend: 'unknown' as const, better: null, line });
/** The Pulse card's read for the same fixture: unknown numbers when quiet or unknown, a red main named when red. */
export function pulse(kind: HomeFixture): PulseV1 {
  const empty: PulseV1 = {
    schema: 'fleet.pulse.v1', v: 1, asOf: '2026-11-17T12:00:00.000Z', verdict: 'unknown', headline: 'Partly unknown: 5 numbers could not be read.',
    mergesPerHour: { ...none('Unknown: the job metrics file could not be read.'), sparkline: [] }, medianMergeSeconds: none('Unknown: the job metrics file could not be read.'),
    mainsGreen: { ...none('Unknown: the main guardian status could not be read.'), total: null, red: [] },
    daysSinceRelease: { ...none('Unknown: no guarded repo is known to read releases for.'), worstRepo: null, repos: [] },
    poolsOnPace: { ...none('Unknown: the spend snapshot could not be read.'), measured: null },
  };
  if (kind === 'quiet' || kind === 'unknown') return empty;
  const red = kind === 'red';
  return { ...empty, verdict: red ? 'bad' : 'good', headline: red ? 'Not well: main is red on phantom.' : 'Doing well: 6 PRs merged per hour and every main is green.',
    mergesPerHour: { value: 6, trend: 'up', better: true, line: '143 PRs merged in the last 24 hours, 120 the day before.', sparkline: [4, 6, 7, 5, 6, 8, 7, 6, 5, 6, 7, 6, 5, 6, 7, 8, 6, 5, 6, 7, 5, 6, 7, 7] },
    medianMergeSeconds: { value: 360, trend: 'flat', better: null, line: 'Half of PRs merge within 6m 0s of publishing.' },
    mainsGreen: { value: red ? 1 : 2, total: 2, red: red ? ['phantom'] : [], trend: 'unknown', better: null, line: red ? 'Red: phantom.' : 'Every main branch is green.' },
    daysSinceRelease: { value: 3, trend: 'up', better: false, line: 'locus last released 3 days ago (v1.0.0).', worstRepo: 'locus', repos: [{ repo: 'locus', tag: 'v1.0.0', days: 3 }] },
    poolsOnPace: { value: 2, measured: 2, trend: 'unknown', better: null, line: '2 of 2 pools on pace.' } };
}
