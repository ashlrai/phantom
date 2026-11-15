/**
 * desktop-error-report.test.ts — the crash-report ledger behind
 * POST /api/verse/desktop-errors (RQ-PHX-DESKTOPCRASHREPORT100).
 *
 * Covers normaliseDesktopError's validation and sanitation (bad surface,
 * secret-shaped text, home paths), recordDesktopError's dedupe window and
 * single rotation, and readDesktopErrors' fingerprint grouping — all
 * against temp runsDirs, never the real ~/.ashlr-runs.
 */
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  desktopErrorFingerprint,
  normaliseDesktopError,
  readDesktopErrors,
  recordDesktopError,
  type DesktopErrorInput,
} from '../src/core/verse/desktop-error-report.js';

// Clearly fake, pattern-shaped only — the same class of fixture scrub-310
// pins (30-char ghp_ body, made-up characters, never a real token).
const FAKE_GH_TOKEN = `ghp_${'Ab1Cd2Ef3Gh4'.repeat(2)}IjKl`;

const dir = async () => mkdtemp(join(tmpdir(), 'desktop-errors-'));
const ledger = (runsDir: string) => join(runsDir, 'desktop', 'errors.jsonl');
const rotated = (runsDir: string) => join(runsDir, 'desktop', 'errors.1.jsonl');

const crash = (over: Partial<DesktopErrorInput> = {}): DesktopErrorInput => ({
  surface: 'route:fleet',
  message: 'Cannot read properties of undefined',
  stack: 'TypeError: boom\n    at FleetView.render (~/app/FleetView.tsx:10:2)\n    at finishClassComponent (~/app/react.js:1:1)',
  componentStack: '\n    at FleetView\n    at RouteErrorBoundary',
  appVersion: '3.30.0',
  ...over,
});

async function lines(file: string): Promise<Record<string, unknown>[]> {
  return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('normaliseDesktopError', () => {
  it('rejects a bad surface, non-object input, extra keys and wrong types', () => {
    const base = { surface: 'route:fleet', message: 'boom' };
    expect(normaliseDesktopError({ ...base, surface: '/fleet' })).toBeNull();
    expect(normaliseDesktopError({ ...base, surface: 'Bad Surface!' })).toBeNull();
    expect(normaliseDesktopError({ ...base, surface: '' })).toBeNull();
    expect(normaliseDesktopError(null)).toBeNull();
    expect(normaliseDesktopError('route:fleet')).toBeNull();
    expect(normaliseDesktopError({ ...base, extra: true })).toBeNull();
    expect(normaliseDesktopError({ surface: 'route:fleet' })).toBeNull();
    expect(normaliseDesktopError({ ...base, message: 42 })).toBeNull();
    expect(normaliseDesktopError({ ...base, stack: 7 })).toBeNull();
    expect(normaliseDesktopError({ ...base, componentStack: {} })).toBeNull();
    expect(normaliseDesktopError({ ...base, appVersion: 330 })).toBeNull();
    expect(normaliseDesktopError(base)).toEqual({ surface: 'route:fleet', message: 'boom' });
  });

  it('scrubs a secret-shaped value and strips home paths from every string', () => {
    const out = normaliseDesktopError({
      surface: 'pane:terminal-pane',
      message: `failed with ${FAKE_GH_TOKEN}`,
      stack: `Error: x\n    at run (/Users/someone/Projects/phantom/src/x.ts:1:1)`,
      componentStack: '\n    at TerminalPane',
    });
    expect(out).not.toBeNull();
    expect(out!.message).not.toContain(FAKE_GH_TOKEN);
    expect(out!.message).toContain('[REDACTED]');
    expect(out!.stack).not.toContain('/Users/someone');
    expect(out!.stack).toContain('~/Projects/phantom/src/x.ts');
  });

  it('truncates message to 500 chars and stacks to 4000', () => {
    // Realistic frame text: homogeneous runs like 'x'.repeat(n) can trip the
    // secret scrub (a long hex/base64-looking blob) and shrink below the cap.
    const frame = '    at PaneView.render (/proj/app/src/PaneView.tsx:10:5)\n';
    const out = normaliseDesktopError({
      surface: 'route:fleet',
      message: 'm'.repeat(900),
      stack: frame.repeat(200),
      componentStack: '    at PaneView\n'.repeat(300),
    });
    expect(out!.message).toHaveLength(500);
    expect(out!.stack).toHaveLength(4000);
    expect(out!.componentStack).toHaveLength(4000);
  });
});

describe('desktopErrorFingerprint', () => {
  it('is 16 hex chars and stable per crash signature', () => {
    const a = desktopErrorFingerprint(crash());
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(desktopErrorFingerprint(crash())).toBe(a);
    expect(desktopErrorFingerprint(crash({ message: 'different' }))).not.toBe(a);
    expect(desktopErrorFingerprint(crash({ surface: 'pane:diff-pane' }))).not.toBe(a);
  });
});

describe('recordDesktopError', () => {
  it('appends a fingerprinted record and dedupes it inside 10 minutes', async () => {
    const runsDir = await dir();
    const t0 = Date.parse('2026-11-10T12:00:00Z');
    const first = await recordDesktopError(runsDir, crash(), t0);
    expect(first).toEqual({ recorded: true, fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/) });
    const again = await recordDesktopError(runsDir, crash(), t0 + 5 * 60_000);
    expect(again).toEqual({ recorded: false, fingerprint: first.fingerprint });
    const rows = await lines(ledger(runsDir));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      at: '2026-11-10T12:00:00.000Z', surface: 'route:fleet',
      message: 'Cannot read properties of undefined', fingerprint: first.fingerprint,
    });
    const later = await recordDesktopError(runsDir, crash(), t0 + 11 * 60_000);
    expect(later.recorded).toBe(true);
    expect(await lines(ledger(runsDir))).toHaveLength(2);
  });

  it('still writes a different crash inside the dedupe window', async () => {
    const runsDir = await dir();
    const t0 = Date.parse('2026-11-10T12:00:00Z');
    await recordDesktopError(runsDir, crash(), t0);
    const other = await recordDesktopError(runsDir, crash({ surface: 'dock-helper:fleet-workspace-auto-open' }), t0 + 60_000);
    expect(other.recorded).toBe(true);
    expect(await lines(ledger(runsDir))).toHaveLength(2);
  });

  it('rotates errors.jsonl to errors.1.jsonl once it passes 2 MB', async () => {
    const runsDir = await dir();
    await recordDesktopError(runsDir, crash(), Date.now());
    const fat = (await stat(ledger(runsDir))).size;
    // Pad past the cap with one overlong line — parseLedgerLine skips it.
    const { appendFile } = await import('node:fs/promises');
    await appendFile(ledger(runsDir), `${'x'.repeat(2 * 1024 * 1024 - fat + 1)}\n`);
    expect((await stat(ledger(runsDir))).size).toBeGreaterThanOrEqual(2 * 1024 * 1024);
    const result = await recordDesktopError(runsDir, crash({ message: 'post-rotation' }), Date.now());
    expect(result.recorded).toBe(true);
    expect((await stat(rotated(runsDir))).size).toBeGreaterThanOrEqual(2 * 1024 * 1024);
    const rows = await lines(ledger(runsDir));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message).toBe('post-rotation');
  });
});

describe('readDesktopErrors', () => {
  it('groups by fingerprint with count, first and last seen, newest first', async () => {
    const runsDir = await dir();
    const now = Date.now();
    const a = crash();
    const b = crash({ surface: 'pane:diff-pane', message: 'Diff exploded' });
    // >10 min apart so all three land; still inside the 24h read window.
    await recordDesktopError(runsDir, a, now - 3 * 3_600_000);
    await recordDesktopError(runsDir, b, now - 2 * 3_600_000);
    await recordDesktopError(runsDir, a, now - 60_000);
    const groups = await readDesktopErrors(runsDir, { sinceMs: 24 * 3_600_000, limit: 10 });
    expect(groups).toHaveLength(2);
    expect(groups[0]!.fingerprint).toBe(desktopErrorFingerprint(a));
    expect(groups[0]!.count).toBe(2);
    expect(groups[0]!.lastSeen).toBe(new Date(now - 60_000).toISOString());
    expect(groups[0]!.firstSeen).toBe(new Date(now - 3 * 3_600_000).toISOString());
    expect(groups[1]!.fingerprint).toBe(desktopErrorFingerprint(b));
    expect(groups[1]!.count).toBe(1);
    expect(groups[1]!.message).toBe('Diff exploded');
  });

  it('drops records outside the since window and skips malformed lines', async () => {
    const runsDir = await dir();
    const now = Date.now();
    await recordDesktopError(runsDir, crash(), now - 26 * 3_600_000);
    await recordDesktopError(runsDir, crash({ surface: 'pane:terminal-pane' }), now - 60_000);
    const { appendFile } = await import('node:fs/promises');
    await appendFile(ledger(runsDir), 'not-json\n{"at":"never"}\n');
    const groups = await readDesktopErrors(runsDir, { sinceMs: 24 * 3_600_000, limit: 10 });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.surface).toBe('pane:terminal-pane');
  });

  it('returns an empty list when the ledger does not exist', async () => {
    expect(await readDesktopErrors(await dir(), { sinceMs: 24 * 3_600_000, limit: 10 })).toEqual([]);
  });
});
