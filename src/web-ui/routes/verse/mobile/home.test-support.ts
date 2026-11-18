/** Fixture `phm home --json` payloads (home.v1) for the phone's Home tests: fake repos, lanes and asks only. */
import type { HomeSummary } from '../../../../core/fleet/home.js';

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
