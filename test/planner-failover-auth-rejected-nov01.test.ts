import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTH_REJECTED_RETRY_MS, isAuthRejectedText, isProviderLimited, readPlannerHealth, selectPlannerRunner, type PlannerHealth } from '../src/core/fleet/planner-failover.js';

const now = new Date(2026, 10, 1, 12).getTime();
const candidates = [
  { provider: 'claude', argv: ['echo'] },
  { provider: 'codex-personal', argv: ['echo'] },
];
const rejected = (age: number): PlannerHealth => ({
  status: 'failing', reason: 'auth-rejected', failingSince: new Date(now - age).toISOString(),
  resetAt: null, lastGoodPassAt: null,
});

describe('auth rejection failover', () => {
  it.each(['authentication_error', 'invalid x-api-key', 'OAuth token has expired', 'token rejected', 'Please run /login', '401 Unauthorized', 'Unauthorized: 401', 'Not logged in'])('recognizes %s', (text) => {
    expect(isAuthRejectedText(text)).toBe(true);
  });
  it.each(['401', 'unauthorized', '401\nunauthorized', 'unauthorized\r401', 'token count: 401', 'synthetic render fault'])('ignores ambiguous text %s', (text) => {
    expect(isAuthRejectedText(text)).toBe(false);
  });
  it.each([
    ['authentication_error', 'auth-rejected', null],
    ['authentication_error\ntry again at Nov 4th, 2026 1:41 AM', 'usage-limit', new Date(2026, 10, 4, 1, 41).getTime()],
    ['authentication_error\nusage limit reached', 'usage-limit', null],
  ])('classifies failed log %s with usage evidence taking priority', async (text, reason, reset) => {
    const root = await mkdtemp(join(tmpdir(), 'planner-auth-'));
    try {
      await mkdir(join(root, 'queue'));
      await mkdir(join(root, 'supervisor'));
      await writeFile(join(root, 'queue/dispatch-events.log'), '2026-11-01 11:50:00 LEADER claude rc=1\n');
      await writeFile(join(root, 'supervisor/run.fixture.log'), text);
      const health = await readPlannerHealth(root, now);
      expect(health).toMatchObject({ status: 'failing', reason });
      expect(health.resetAt === null ? null : Date.parse(health.resetAt)).toBe(reset);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('skips recent rejection, retries after seven hours and at the exact boundary', () => {
    expect(AUTH_REJECTED_RETRY_MS).toBe(6 * 60 * 60 * 1000);
    expect(selectPlannerRunner(candidates, { claude: rejected(10 * 60 * 1000) }, now)).toMatchObject({ ok: true, provider: 'codex-personal' });
    for (const age of [7 * 60 * 60 * 1000, AUTH_REJECTED_RETRY_MS]) {
      expect(selectPlannerRunner(candidates, { claude: rejected(age) }, now)).toMatchObject({ ok: true, provider: 'claude' });
    }
  });
  it('reports the earliest auth or usage retry when all candidates are limited', () => {
    const auth = rejected(10 * 60 * 1000);
    const retry = new Date(Date.parse(auth.failingSince!) + AUTH_REJECTED_RETRY_MS).toISOString();
    expect(selectPlannerRunner(candidates, { claude: auth, 'codex-personal': rejected(0) }, now))
      .toEqual({ ok: false, reason: 'all candidates are usage-limited or auth-rejected', nextResetAt: retry });
    const resetAt = new Date(now + 1000).toISOString();
    expect(selectPlannerRunner(candidates, { claude: auth, 'codex-personal': { ...auth, reason: 'usage-limit', resetAt } }, now))
      .toMatchObject({ ok: false, nextResetAt: resetAt });
  });
  it.each([null, 'invalid date'])('keeps an unparseable failingSince %s limited', (failingSince) => {
    const health = { ...rejected(0), failingSince };
    expect(isProviderLimited(health, now)).toBe(true);
    expect(selectPlannerRunner([candidates[0]!], { claude: health }, now)).toMatchObject({ ok: false, nextResetAt: null });
  });
});
