/**
 * A realistic Verse session log of any size, for the V3.10 client benchmarks
 * (spec §1: replay 5k events < 10 ms, 10k < 25 ms; ≤ 4 ms per streamed delta
 * at 5k events).
 *
 * Shape follows the real logs measured in research (scratchpad perf/): every
 * turn is an ask, reasoning, a few tool calls (a shell run, a read, an edit
 * with a diff), a reply streamed as deltas and then stated whole, usage, and
 * turn-done — so the derivation exercises tool facts, diffs and grouping, not
 * just text.
 */
import type { VerseEvent } from '../../data/api-types.js';

const BASE = Date.parse('2026-09-20T09:00:00.000Z');

export function stamp(seq: number): string {
  return new Date(BASE + seq * 250).toISOString();
}

/** At least `targetEvents` events of finished turns (about 32 events per turn). */
export function realisticLog(targetEvents: number, deltasPerTurn = 20): VerseEvent[] {
  const events: VerseEvent[] = [];
  let seq = 1;
  let turn = 0;
  const push = (e: Omit<VerseEvent, 'seq' | 'at'>) => {
    events.push({ ...e, seq, at: stamp(seq) } as VerseEvent);
    seq += 1;
  };
  while (events.length < targetEvents) {
    turn += 1;
    const turnId = `t${turn}`;
    push({ type: 'user-message', turnId, text: `Turn ${turn}: fix the failing check in module ${turn % 17}.` } as never);
    push({ type: 'turn-started', turnId, pid: 4000 + turn } as never);
    push({ type: 'thinking', turnId, text: `The failure in module ${turn % 17} looks like an off-by-one in the pager; read it first.` } as never);
    push({ type: 'tool-use', turnId, toolUseId: `${turnId}-run`, name: 'Bash', input: { command: `npm test -- module-${turn % 17}` } } as never);
    push({ type: 'tool-result', turnId, toolUseId: `${turnId}-run`, output: `FAIL module-${turn % 17}.test.ts\n  expected 10, received 9\n`, isError: true } as never);
    push({ type: 'tool-use', turnId, toolUseId: `${turnId}-read`, name: 'Read', input: { file_path: `/repo/src/module-${turn % 17}.ts` } } as never);
    push({ type: 'tool-result', turnId, toolUseId: `${turnId}-read`, output: 'export function page(n) {\n  return n - 1;\n}\n', isError: false } as never);
    push({
      type: 'tool-use', turnId, toolUseId: `${turnId}-edit`, name: 'Edit',
      input: { file_path: `/repo/src/module-${turn % 17}.ts`, old_string: '  return n - 1;', new_string: '  return n;' },
    } as never);
    push({ type: 'tool-result', turnId, toolUseId: `${turnId}-edit`, output: 'ok', isError: false } as never);
    const words = 'The pager subtracted one twice, so the last page was dropped; I removed the extra decrement and the check passes. '.split(' ');
    let reply = '';
    for (let d = 0; d < deltasPerTurn; d++) {
      const text = `${words[d % words.length]} `;
      reply += text;
      push({ type: 'text-delta', turnId, text } as never);
    }
    push({ type: 'assistant-message', turnId, text: `${reply.trim()}\n\n\`\`\`ts\nreturn n;\n\`\`\`` } as never);
    push({
      type: 'usage', turnId,
      usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 9000, cacheCreationTokens: 0, contextTokens: 20_000 + turn * 100, contextWindow: 200_000 },
    } as never);
    push({ type: 'turn-done', turnId, ok: true, nativeSessionId: 'native-1', durationMs: 9000 } as never);
  }
  return events;
}

/**
 * The quietest (minimum) wall time of each case, sampled in interleaved
 * rounds until every case has run once under its limit, `maxRounds` rounds
 * have run, or `budgetMs` of sampling has passed.
 *
 * Why not the minimum of seven back-to-back runs per case: those samples sit
 * in one ~20 ms window, so one stretch of a loaded hosted runner (CPU time-sliced
 * with other test files, a GC, starved background JIT threads) inflates all
 * of them and the minimum with them. Interleaving the cases and spreading the
 * samples over up to `budgetMs` gives each case a chance at a quiet slice.
 *
 * This does not weaken the limit: noise only ever adds time, so the minimum
 * converges on the real cost from above. Code whose real cost is over the
 * limit never produces a sample under it, however many rounds run, and a
 * quadratic regression (seconds per replay) spends the whole budget in its
 * first round and fails at once.
 */
export function quietestOf<K extends string>(
  cases: Record<K, { run: () => void; limitMs: number }>,
  { maxRounds = 25, budgetMs = 2000 }: { maxRounds?: number; budgetMs?: number } = {},
): { best: Record<K, number>; rounds: number } {
  const keys = Object.keys(cases) as K[];
  const best = Object.fromEntries(keys.map((k) => [k, Infinity])) as Record<K, number>;
  const started = performance.now();
  let rounds = 0;
  while (rounds < maxRounds) {
    rounds += 1;
    for (const k of keys) {
      const t0 = performance.now();
      cases[k].run();
      best[k] = Math.min(best[k], performance.now() - t0);
    }
    if (keys.every((k) => best[k] < cases[k].limitMs)) break;
    if (performance.now() - started >= budgetMs) break;
  }
  return { best, rounds };
}

/** Median of per-iteration timings. */
export function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * The log with its LAST turn reopened: its reply, usage and turn-done are
 * dropped, so the turn is live and the next text-delta streams into it.
 */
export function openLastTurn(log: VerseEvent[]): { events: VerseEvent[]; turnId: string } {
  let cut = log.length;
  for (let i = log.length - 1; i >= 0; i -= 1) {
    if (log[i]!.type === 'assistant-message') {
      cut = i;
      break;
    }
  }
  const events = log.slice(0, cut);
  return { events, turnId: (events[events.length - 1] as { turnId: string }).turnId };
}

/**
 * CPU time (user + system) this process spent in `fn`, in ms. The web suite
 * runs each file in its own process, so — unlike wall time — this does not
 * inflate when the other test files are busy on the same cores.
 */
export function cpuMs(fn: () => void): number {
  const start = process.cpuUsage();
  fn();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}
