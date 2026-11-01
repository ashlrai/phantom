import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Sleep budget: the daily suite pays wall-clock for every real wait a test
 * file leaves on the table. This guard scans test/*.test.ts for a literal
 * wait of MIN_WAIT_MS or more inside a setTimeout- or sleep-style call and
 * fails on any occurrence that is not on the allow list below — each entry
 * exists for a specific reason a refactor cannot remove, and a stale entry
 * fails just like a new wait does.
 *
 * "Wait" means the call's first argument merely resolves or completes the
 * surrounding promise — setTimeout(resolve, N), setTimeout(() => resolve(x), N),
 * await sleep(N), await delay(N). Watchdog callbacks that reject, kill or
 * assign are deadlines rather than sleeps: they never match and never need
 * the list. File reads only; nothing here spawns, so the guard stays in the
 * unit lane.
 *
 * The guard file excludes itself: its allow-list fragments are literals that
 * a textual scan cannot distinguish from real waits.
 */

const SELF = 'test-sleep-budget.test.ts';
const MIN_WAIT_MS = 2_000;
const TEST_DIR = fileURLToPath(new URL('.', import.meta.url));

const NUM = String.raw`(\d[\d_]*)`;
// Identifiers tests conventionally give a promise's resolve/done callback.
const RESOLVER = String.raw`(?:resolve|res|done|finish|complete|ok|settle|release|proceed|r|s|cb|next|ack|unblock)`;
const WAIT_PATTERNS: readonly RegExp[] = [
  // setTimeout(resolver, N) or setTimeout(() => resolver(...), N) — an arrow
  // whose whole body is the resolver call, braces optional.
  new RegExp(
    String.raw`setTimeout\s*\(\s*(?:${RESOLVER}\s*,|\(\s*\)\s*=>\s*\{?\s*` +
    String.raw`${RESOLVER}\s*\([^()]*\)\s*;?\s*\}?\s*,)\s*${NUM}\s*\)`,
    'g',
  ),
  // sleep(N) / delay(N) / wait(N) — any receiver (deps.sleep counts: it is a
  // literal sleep-shaped call and only the allow list can excuse it).
  new RegExp(String.raw`(?<![\w$])(?:sleep|delay|wait|pause|nap)\s*\(\s*${NUM}\s*\)`, 'g'),
];
// Cheap substring gate so multi-MB files never touch the patterns at all:
// a call cannot match without one of these names appearing first.
const WAIT_NAMES = ['setTimeout', 'sleep', 'delay', 'wait', 'pause', 'nap'] as const;
const mayWait = (text: string) => WAIT_NAMES.some(name => text.includes(name));

interface AllowEntry {
  readonly file: string;
  /** Whitespace-normalized substring of the offending call. */
  readonly fragment: string;
  readonly reason: string;
}

// Today's real exceptions — every one either still costs wall time for a
// reason stated here, or provably costs none. A new wait belongs in a fake
// timer, an injected clock, or a smaller constant — not on this list.
const ALLOW: readonly AllowEntry[] = [
  {
    file: 'bus-claimed-run.integration.test.ts',
    fragment: 'delay(3600)',
    reason: 'real lease-renewal window: the contender must arrive past a live claim’s original 3s lease, so only renewals can fence it; smaller windows flake under host load',
  },
  {
    file: 'bridge-worktree.test.ts',
    fragment: 'setTimeout(resolve, 2000)',
    reason: 'join fence for 20 parallel clone deps; only elapses when a dep never arrives, in which case the run fails anyway',
  },
  {
    file: 'cloud-launcher.test.ts',
    fragment: 'setTimeout(r, 3_500)',
    reason: 'must outlast the fixture grandchild’s own 3s marker delay to prove it was killed; cannot shrink below the fixture constant',
  },
  {
    file: 'desktop-qualified-update.test.ts',
    fragment: 'sleep(9000)',
    reason: 'injected fixture dep resolves immediately (sleep: async(ms)=>{now+=ms}); exercises a stalled verifyParent at zero wall cost',
  },
  {
    file: 'local-runtime-anthropic-proxy.test.ts',
    fragment: 'setTimeout(resolve, 30_000)',
    reason: 'deliberately never-idle SSE handler; the server under test cuts the connection — unref’d and never elapses',
  },
  {
    file: 'm32.inbox-api.test.ts',
    fragment: 'setTimeout(() => resolve(\'\'), 20_000)',
    reason: 'failure-path fallback resolving empty so a missing SSE frame fails its assertion instead of hanging the lane',
  },
  {
    file: 'mcp-gateway-stdin-eof.test.ts',
    fragment: 'delay(2_100)',
    reason: 'real liveness window proving the attached host keeps the child alive past stdin EOF (real-io lane)',
  },
  {
    file: 'remote-gateway-http.test.ts',
    fragment: 'setTimeout(() => resolve(\'timeout\'), 3_000)',
    reason: 'stream-close race fallback (3 occurrences); only elapses when the reader hangs',
  },
  {
    file: 'resource-reading-cache.test.ts',
    fragment: 'setTimeout(resolve, 20_000)',
    reason: 'inside vi.useFakeTimers scope; advanced instantly by vi.advanceTimersByTimeAsync — zero wall cost',
  },
  {
    file: 'universe-controller-signal-integration.test.ts',
    fragment: 'setTimeout(resolve,10000)',
    reason: 'sleep inside the spawned worker fixture source (a separate process), not in the test process',
  },
  {
    file: 'usage-api-body-stall.test.ts',
    fragment: 'setTimeout(() => resolve({ settled: false }), 8_000)',
    reason: 'race guard for a deliberately stalled local server; only elapses when the fetch hangs',
  },
  {
    file: 'verse-git-runner-hung-child.test.ts',
    fragment: 'setTimeout(() => r(\'hung\'), 8_000)',
    reason: 'race fallback labelling a hung child; only elapses when hung-child detection itself hangs',
  },
];

const flat = (text: string) => text.replace(/\s+/g, ' ');

interface Hit { readonly line: number; readonly text: string; readonly ms: number }

function* waitsIn(text: string): Generator<{ call: string; ms: number; start: number; end: number }> {
  for (const pattern of WAIT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const ms = Number(match[1].replaceAll('_', ''));
      if (ms >= MIN_WAIT_MS) yield { call: flat(match[0]), ms, start: match.index, end: match.index + match[0].length };
    }
  }
}

// Per-line pass plus a 3-line sliding window whose matches must cross the
// first boundary — catches a wait whose delay argument wrapped to the next
// line without ever re-finding a match already seen inside one line.
function hitsIn(content: string): Hit[] {
  const hits: Hit[] = [];
  // One whole-file pass: the vast majority of files hold no wait-shaped call
  // at all, so per-line and window work is skipped for them entirely.
  if (!mayWait(content)) return hits;
  const lines = content.split('\n');
  lines.forEach((text, i) => {
    if (!mayWait(text)) return;
    for (const wait of waitsIn(text)) hits.push({ line: i + 1, text: wait.call, ms: wait.ms });
  });
  for (let i = 0; i + 1 < lines.length; i++) {
    // A wrapped wait must open on this line — skip windows that cannot start one.
    if (!mayWait(lines[i])) continue;
    const boundary = lines[i].length;
    const window = `${lines[i]} ${lines[i + 1]} ${lines[i + 2] ?? ''}`;
    for (const wait of waitsIn(window)) {
      if (wait.start <= boundary && wait.end > boundary) hits.push({ line: 0, text: wait.call, ms: wait.ms });
    }
  }
  return hits;
}

describe('test-suite sleep budget', () => {
  it(`no test file contains a literal wait of ${MIN_WAIT_MS} ms or more without an allow-listed reason`, async () => {
    const files = readdirSync(TEST_DIR)
      .filter(name => name.endsWith('.test.ts') && name !== SELF)
      .sort();
    // Serial readFileSync of ~2.5k files is seconds under CI I/O load; read in
    // bounded parallel batches instead.
    const hitsByFile = new Map<string, Hit[]>();
    const BATCH = 32;
    for (let i = 0; i < files.length; i += BATCH) {
      await Promise.all(files.slice(i, i + BATCH).map(async file => {
        hitsByFile.set(file, hitsIn(await readFile(join(TEST_DIR, file), 'utf8')));
      }));
    }
    const offenders: string[] = [];
    const stale: string[] = [];
    for (const file of files) {
      const hits = hitsByFile.get(file)!;
      const allowed = ALLOW.filter(entry => entry.file === file);
      for (const hit of hits) {
        const where = hit.line === 0 ? file : `${file}:${hit.line}`;
        if (!allowed.some(entry => hit.text.includes(flat(entry.fragment)))) {
          offenders.push(`${where} waits ${hit.ms} ms — ${hit.text}`);
        }
      }
      for (const entry of allowed) {
        if (!hits.some(hit => hit.text.includes(flat(entry.fragment)))) {
          stale.push(`${file}: allow-list fragment no longer matches any wait — ${entry.fragment}`);
        }
      }
    }
    expect(
      [...offenders, ...stale.map(s => `stale ${s}`)],
      'a literal wait >= 2000 ms is real wall time for the daily suite: use a fake timer, an injected clock or a smaller constant; allow-list only a wait that cannot be removed, with a reason',
    ).toEqual([]);
  });

  it('every allow-list entry names a file that exists, pins a wait literal and states a reason', () => {
    const files = new Set(readdirSync(TEST_DIR));
    for (const entry of ALLOW) {
      expect(files.has(entry.file), `allow-listed file is missing: ${entry.file}`).toBe(true);
      expect(/\d[\d_]{3,}/.test(entry.fragment), `allow-list fragment for ${entry.file} must pin the wait literal`).toBe(true);
      expect(entry.reason.length, `allow-list entry for ${entry.file} needs a reason`).toBeGreaterThan(0);
    }
  });
});
