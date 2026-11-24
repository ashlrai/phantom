import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cmdFleetCooldownEvidence, COOLDOWN_EVIDENCE_MAX_BYTES } from '../src/cli/fleet-cooldown-evidence.js';
import { cooldownActive, parseCliCooldown } from '../src/core/providers/coding-cli/limits.js';

// Recovered from closed PR #5952 (head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886). Fixtures are plainly fake.
const SENTINEL = 'PLAIN_FAKE_CAPTURE_SENTINEL_640S';
const NOW = '2026-11-19T12:00:00Z';
const NOW_MS = Date.parse(NOW);
const FUTURE = '2026-11-19T13:00:00Z';
const PAST = '2026-11-19T11:00:00Z';
const FUTURE_ISO = new Date(FUTURE).toISOString(); // the CLI prints millisecond-precision UTC

let dir: string;
let counter = 0;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'cooldown-evidence-640s-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
afterEach(() => vi.restoreAllMocks());

async function capture(body: string | Buffer): Promise<string> {
  const path = join(dir, `capture-${counter++}.txt`);
  await writeFile(path, body);
  return path;
}

/** `text()` is every printed line, for leak checks. */
function io() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(' ')); });
  return { out, err, text: () => [...out, ...err].join('\n') };
}

const base = (file: string, extra: string[] = [], now = NOW) => ['--backend', 'claude', '--file', file, '--now', now, ...extra];

it('returns null with no limit line, so no cooldown evidence exists', () => {
  expect(parseCliCooldown('claude', `all good, reset: ${FUTURE} is only a date`, NOW_MS)).toBeNull();
  expect(cooldownActive(null, NOW_MS)).toBe(false);
});

it('recognises each limit phrase case-insensitively', () => {
  for (const phrase of ['rate limit', 'USAGE LIMIT', 'Too Many Requests', 'status 429', 'quota exceeded']) expect(parseCliCooldown('b', `${phrase} hit`, NOW_MS), phrase).not.toBeNull();
});

it('keeps a known future reset active until it expires exactly at that time', () => {
  const cd = parseCliCooldown('claude', `rate limit. resets: ${FUTURE}`, NOW_MS);
  expect(cd).toMatchObject({ backend: 'claude', untilMs: Date.parse(FUTURE) });
  expect(cooldownActive(cd, Date.parse(FUTURE) - 1)).toBe(true);
  expect(cooldownActive(cd, Date.parse(FUTURE))).toBe(false);
  expect(cooldownActive(cd, Date.parse(FUTURE) + 1)).toBe(false);
});

it('accepts the recovered reset phrasings and fractional seconds', () => {
  for (const text of [`rate limit reset at: ${FUTURE}`, `usage limit try again after = ${FUTURE}`, `rate limit until ${FUTURE}`]) {
    expect(parseCliCooldown('b', text, NOW_MS)?.untilMs, text).toBe(Date.parse(FUTURE));
  }
  expect(parseCliCooldown('b', 'rate limit reset 2026-11-19T13:00:00.250Z', NOW_MS)?.untilMs)
    .toBe(Date.parse('2026-11-19T13:00:00.250Z'));
});

it('treats a limit with no parseable reset as active with unknown expiry', () => {
  const noReset = parseCliCooldown('b', 'rate limit exceeded, try later', NOW_MS);
  expect(noReset).toMatchObject({ untilMs: null });
  expect(cooldownActive(noReset, NOW_MS)).toBe(true);
  // Offset-form timestamps are outside the recovered reset grammar; they are not guessed.
  const offset = parseCliCooldown('b', 'rate limit reset 2026-11-19T13:00:00+00:00', NOW_MS);
  expect(offset).toMatchObject({ untilMs: null });
  expect(cooldownActive(offset, NOW_MS)).toBe(true);
});

it('treats a past or equal-to-now reset as unknown, never as expired-and-usable', () => {
  const stale = parseCliCooldown('b', `rate limit reset ${PAST}`, NOW_MS);
  expect(stale).toMatchObject({ untilMs: null });
  expect(cooldownActive(stale, NOW_MS)).toBe(true);
  expect(parseCliCooldown('b', `rate limit reset ${NOW}`, NOW_MS)).toMatchObject({ untilMs: null });
});

it('uses the first reset stamp and parses long whitespace runs quickly (no quadratic backtracking)', () => {
  expect(parseCliCooldown('b', `rate limit reset ${FUTURE} then reset 2026-11-20T00:00:00Z`, NOW_MS)?.untilMs)
    .toBe(Date.parse(FUTURE));
  const started = performance.now();
  expect(parseCliCooldown('b', `rate limit reset${' '.repeat(60_000)}x`, NOW_MS)).toMatchObject({ untilMs: null });
  expect(performance.now() - started).toBeLessThan(1_000);
});

it('prints help with exit 0 and never touches the named file', async () => {
  const log = io();
  expect(await cmdFleetCooldownEvidence(['--help'])).toBe(0);
  expect(await cmdFleetCooldownEvidence(['--backend', 'x', '--file', '/no/such/file-640s', '-h'])).toBe(0);
  expect(log.out.join('\n')).toContain('Usage: phm fleet cooldown-evidence');
  expect(log.out.join('\n')).toContain('not proof of remaining allowance');
  expect(log.err).toEqual([]);
});

it('rejects malformed or unknown arguments with exit 2 and a usage message', async () => {
  const file = await capture(`rate limit reset ${FUTURE}`);
  const cases: string[][] = [
    [],
    ['--file', file, '--now', NOW],
    ['--backend', 'claude', '--now', NOW],
    ['--backend', 'claude', '--file', file],
    [...base(file), '--bogus'],
    [...base(file), '--json', '--json'],
    ['--backend', 'claude', '--backend', 'other', '--file', file, '--now', NOW],
    ['--backend', '--file', file, '--now', NOW],
    ['--backend', 'claude', '--file', '--now', NOW],
    ['--backend', '', '--file', file, '--now', NOW],
    ['positional', ...base(file)],
  ];
  for (const args of cases) {
    const log = io();
    expect(await cmdFleetCooldownEvidence(args), JSON.stringify(args)).toBe(2);
    expect(log.err.join('\n')).toContain('Usage: phm fleet cooldown-evidence');
    vi.restoreAllMocks();
  }
});

it('rejects an invalid backend label or relative path without echoing the value', async () => {
  const file = await capture('rate limit');
  for (const backend of ['has space', '../escape', 'bad!', `a${'b'.repeat(64)}`, '-leading']) {
    const log = io();
    expect(await cmdFleetCooldownEvidence(['--backend', backend, '--file', file, '--now', NOW]), backend).toBe(2);
    expect(log.text()).not.toContain(backend);
    expect(log.err.join('\n')).toContain('plain identifier');
    vi.restoreAllMocks();
  }
  const log = io();
  expect(await cmdFleetCooldownEvidence(['--backend', 'claude', '--file', 'relative/capture-640s.txt', '--now', NOW])).toBe(2);
  expect(log.err.join('\n')).toContain('absolute path');
  expect(log.text()).not.toContain('relative/capture-640s.txt');
});

it('rejects malformed --now values with exit 2 and does not echo them', async () => {
  const file = await capture('rate limit');
  for (const now of ['2026-11-19 12:00:00Z', 'not-a-time', '2026-11-19T12:00:00.000000000Z', `${NOW}${'0'.repeat(40)}`, '2026-13-40T99:00:00Z']) {
    const log = io();
    expect(await cmdFleetCooldownEvidence(base(file, [], now)), now).toBe(2);
    expect(log.text()).not.toContain(now);
    expect(log.err.join('\n')).toContain('ISO-8601');
    vi.restoreAllMocks();
  }
});

it('reports a known future reset with --json and exactly the v1 fields', async () => {
  const log = io();
  expect(await cmdFleetCooldownEvidence(base(await capture(`${SENTINEL} rate limit exceeded. resets: ${FUTURE}`), ['--json']))).toBe(0);
  expect(JSON.parse(log.out[0]!)).toEqual({
    schema: 'fleet.cooldown-evidence.v1', advisory: true, authority: 'none', source: 'captured-output', backend: 'claude',
    observedAt: new Date(NOW).toISOString(), reportedLimit: true, resetAt: FUTURE_ISO, resetKnown: true, activeAtObservation: true,
    interpretation: 'limit-with-known-future-reset', allowanceProven: false, live: false,
  });
  expect(log.text()).not.toContain(SENTINEL);
  expect(log.text()).not.toContain(dir);
});

it('reports a limit with a missing or stale reset as active with resetAt null', async () => {
  for (const body of ['rate limit exceeded', `too many requests, reset ${PAST}`]) {
    const log = io();
    expect(await cmdFleetCooldownEvidence(base(await capture(body), ['--json']))).toBe(0);
    expect(JSON.parse(log.out[0]!)).toMatchObject({
      reportedLimit: true, resetAt: null, resetKnown: false, activeAtObservation: true, interpretation: 'limit-with-unknown-reset',
    });
    vi.restoreAllMocks();
  }
});

it('reports no limit line as inactive and says it is not proof of allowance', async () => {
  const log = io();
  expect(await cmdFleetCooldownEvidence(base(await capture(`${SENTINEL} everything is fine`), ['--json']))).toBe(0);
  expect(JSON.parse(log.out[0]!)).toMatchObject({
    reportedLimit: false, resetAt: null, activeAtObservation: false, interpretation: 'no-limit-line-in-capture', allowanceProven: false,
  });
  expect(log.text()).not.toContain(SENTINEL);
});

it('prints a human summary that names the uncertainty and never echoes the capture', async () => {
  const log = io();
  expect(await cmdFleetCooldownEvidence(base(await capture(`${SENTINEL} rate limit reset ${FUTURE}`)))).toBe(0);
  const text = log.out.join('\n');
  expect(text).toContain('backend=claude');
  expect(text).toContain(`limit reported: yes; reset: ${FUTURE_ISO}`);
  expect(text).toContain('not proof of remaining allowance');
  expect(log.text()).not.toContain(SENTINEL);
  expect(log.text()).not.toContain(dir);
});

it('treats a reset at or before --now as unknown and active (fail-closed), never as usable', async () => {
  // One observation instant per run: a reset equal to it is not a future expiry.
  const log = io();
  expect(await cmdFleetCooldownEvidence(base(await capture(`rate limit reset ${FUTURE}`), ['--json'], FUTURE))).toBe(0);
  expect(JSON.parse(log.out[0]!)).toMatchObject({ resetAt: null, resetKnown: false, activeAtObservation: true });
});

it('accepts a capture exactly at the byte cap and refuses one byte more', async () => {
  const atCap = await capture(`rate limit reset ${FUTURE}`.padEnd(COOLDOWN_EVIDENCE_MAX_BYTES, ' '));
  expect(await cmdFleetCooldownEvidence(base(atCap, ['--json']))).toBe(0);
  const log = io();
  expect(await cmdFleetCooldownEvidence(base(await capture('x'.repeat(COOLDOWN_EVIDENCE_MAX_BYTES + 1)), ['--json']))).toBe(1);
  expect(JSON.parse(log.out[0]!)).toMatchObject({ schema: 'fleet.cooldown-evidence.v1', error: expect.stringContaining('exceeds') });
});

it('refuses symbolic links without reading the target', async () => {
  const link = join(dir, `link-${counter++}.txt`);
  await symlink(await capture(`${SENTINEL} rate limit reset ${FUTURE}`), link);
  const log = io();
  expect(await cmdFleetCooldownEvidence(base(link))).toBe(1);
  expect(log.err.join('\n')).toContain('symbolic links are refused');
  expect(log.text()).not.toContain(SENTINEL);
  expect(log.text()).not.toContain(link);
});

it('refuses directories and missing files with fixed messages and no path echo', async () => {
  const sub = join(dir, `dir-${counter++}`);
  await mkdir(sub);
  const dirLog = io();
  expect(await cmdFleetCooldownEvidence(base(sub))).toBe(1);
  expect(dirLog.err.join('\n')).toContain('not a regular file');
  vi.restoreAllMocks();
  const missLog = io();
  expect(await cmdFleetCooldownEvidence(base(join(dir, 'absent-640s.txt')))).toBe(1);
  expect(missLog.err.join('\n')).toContain('input file not found');
  expect(missLog.text()).not.toContain('absent-640s');
});

it('refuses binary (NUL-containing) captures without echoing their content', async () => {
  const log = io();
  expect(await cmdFleetCooldownEvidence(base(await capture(Buffer.concat([Buffer.from(SENTINEL), Buffer.from([0]), Buffer.from('rate limit')]))))).toBe(1);
  expect(log.err.join('\n')).toContain('NUL byte');
  expect(log.text()).not.toContain(SENTINEL);
});
