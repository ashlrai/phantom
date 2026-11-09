#!/usr/bin/env node
/**
 * generate.mjs — emits the frozen prompt-A/B day (benchmarks/prompt-ab/jobs.jsonl).
 *
 * Synthetic regression record, not production telemetry: every line's `arms`
 * table is invented counterfactual ground truth, assigned by a deterministic
 * index pattern so the committed file regenerates byte for byte. The class
 * mix is deliberate:
 *
 *   - docs    — adaptive prompt wins with disjoint Wilson intervals (PROMOTED)
 *   - tests   — adaptive leads on points but intervals overlap (held)
 *   - secrets — too few resolved rows for the gate (held, insufficient-data)
 *
 *   node benchmarks/prompt-ab/generate.mjs > benchmarks/prompt-ab/jobs.jsonl
 */

import process from 'node:process';

const PLAIN = 'prompt:plain';
const ADAPTIVE = 'prompt:adaptive';

/** Deterministic merge patterns per class (merged unless stated otherwise). */
const CLASSES = [
  {
    id: 'docs',
    n: 30,
    tasks: ['docs link audit', 'readme freshness pass', 'changelog draft', 'site copy pass', 'docs anchor repair'],
    repos: ['site', 'phantom', 'ashlr-md'],
    plainMerge: (i) => i % 3 === 0,          // ~33%
    adaptiveMerge: (i) => i % 5 !== 0,       // 80%
  },
  {
    id: 'tests',
    n: 26,
    tasks: ['test flake triage', 'ci shard rebalance', 'vitest drift fix', 'ci watchdog tune'],
    repos: ['phantom', 'phantom', 'lexicon'],
    plainMerge: (i) => i % 5 < 3,            // 60%
    adaptiveMerge: (i) => i % 8 < 5,         // 62.5%
  },
  {
    id: 'secrets',
    n: 6,
    tasks: ['secrets shape lint', 'rotation window audit', 'credential ceremony check'],
    repos: ['binshield', 'custody'],
    plainMerge: (i) => i % 2 === 0,          // 50% (n too small either way)
    adaptiveMerge: (i) => i % 2 === 1,       // 50%
  },
];

const lines = [];
lines.push({
  v: 1,
  kind: 'meta',
  id: 'prompt-ab-2026-10-28',
  day: '2026-10-28',
  note: 'Frozen prompt-variant A/B day for the prompt-opt benchmark. Synthetic regression record; arm tables are frozen counterfactual ground truth.',
  arms: {
    [PLAIN]: { catalogCostUsd: 0.4, tier: 'prompt', label: 'Plain task prompt' },
    [ADAPTIVE]: { catalogCostUsd: 0.9, tier: 'prompt', label: 'Adaptive structured prompt' },
  },
});

let seq = 0;
for (const cls of CLASSES) {
  for (let i = 0; i < cls.n; i++) {
    seq += 1;
    const id = `PAB-${String(seq).padStart(3, '0')}`;
    const chosen = i % 2 === 0 ? ADAPTIVE : PLAIN; // 50/50 logged assignment
    const at = `2026-10-28T${String(6 + Math.floor(seq / 6)).padStart(2, '0')}:${String((seq * 7) % 60).padStart(2, '0')}:00Z`;
    const outcomeFor = (arm, i) => {
      const merged = arm === PLAIN ? cls.plainMerge(i) : cls.adaptiveMerge(i);
      if (merged) return 'merged';
      return i % 4 === 3 ? 'failed' : 'closed';
    };
    const line = {
      v: 1,
      id,
      at,
      repo: cls.repos[i % cls.repos.length],
      pool: 'codex-cmp',
      tier: 'standard',
      priority: 'P1',
      task: cls.tasks[i % cls.tasks.length],
      candidates: [PLAIN, ADAPTIVE],
      chosen,
      outcome: outcomeFor(chosen, i),
      costUsd: +(chosen === PLAIN ? 0.5 + 0.05 * (i % 4) : 0.8 + 0.05 * (i % 4)).toFixed(2),
      tokens: 40000 + 900 * (i % 7) + (chosen === ADAPTIVE ? 15000 : 0),
      wallTimeMs: 1_200_000 + 120_000 * (i % 6) + (chosen === ADAPTIVE ? 240_000 : 0),
    };
    // Freeze the counterfactual on ~9 of 10 lines; the rest model real history
    // (only the realized arm's outcome known) and count as unobserved when the
    // replay changes the arm.
    if (i % 10 !== 7) {
      const other = chosen === PLAIN ? ADAPTIVE : PLAIN;
      line.arms = {
        [chosen]: { outcome: line.outcome, costUsd: line.costUsd, tokens: line.tokens, wallTimeMs: line.wallTimeMs },
        [other]: {
          outcome: outcomeFor(other, i),
          costUsd: +(other === PLAIN ? 0.5 + 0.05 * (i % 4) : 0.8 + 0.05 * (i % 4)).toFixed(2),
          tokens: 40000 + 900 * (i % 7) + (other === ADAPTIVE ? 15000 : 0),
          wallTimeMs: 1_200_000 + 120_000 * (i % 6) + (other === ADAPTIVE ? 240_000 : 0),
        },
      };
    }
    lines.push(line);
  }
}

// Two held lines (never dispatched) and one pending line — the harness keeps
// them out of the terminal cohort.
lines.push(
  { v: 1, id: `PAB-${String(++seq).padStart(3, '0')}`, at: '2026-10-28T16:05:00Z', repo: 'phantom', pool: 'codex-cmp', tier: 'standard', priority: 'P1', task: 'docs freshness sweep', candidates: [PLAIN, ADAPTIVE], chosen: null, outcome: 'held' },
  { v: 1, id: `PAB-${String(++seq).padStart(3, '0')}`, at: '2026-10-28T16:10:00Z', repo: 'custody', pool: 'codex-cmp', tier: 'standard', priority: 'P1', task: 'secrets rotation window', candidates: [PLAIN, ADAPTIVE], chosen: null, outcome: 'held' },
  { v: 1, id: `PAB-${String(++seq).padStart(3, '0')}`, at: '2026-10-28T16:20:00Z', repo: 'phantom', pool: 'codex-cmp', tier: 'standard', priority: 'P2', task: 'ci badge refresh', candidates: [PLAIN, ADAPTIVE], chosen: ADAPTIVE, outcome: 'pending' },
);

for (const line of lines) process.stdout.write(`${JSON.stringify(line)}\n`);
