/**
 * fleet-facts.ts — a short, Phantom-generated block of live fleet facts for
 * every chief-of-staff turn, so replies quote the real state instead of
 * guessing. renderCosFleetFacts is pure; readCosFleetFacts never throws and
 * never blocks a COS pass past FACT_READ_TIMEOUT_MS.
 */
import { readOperatorGlance } from '../fleet/operator-glance-read.js';
import type { OperatorGlance } from '../fleet/operator-glance.js';
import { scrubSecrets } from '../util/scrub.js';

const MAX_FACTS_CHARS = 4000;
const MAX_ITEM_CHARS = 200;
const MAX_LIST_ITEMS = 5;
const FACT_READ_TIMEOUT_MS = 5000;
const ABSOLUTE_PATH = /\/Users\/|\/home\/|~\//;

/** Scrub one value; null drops it entirely when it looks like a local path. */
function safe(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = scrubSecrets(value).replace(/\s+/g, ' ').trim();
  if (!text || ABSOLUTE_PATH.test(text)) return null;
  return text.slice(0, MAX_ITEM_CHARS);
}

const num = (value: number | null | undefined): string => (typeof value === 'number' && Number.isFinite(value) ? String(value) : 'unknown');

export function renderCosFleetFacts(glance: OperatorGlance, now: number): string {
  const lines: string[] = [];
  const asOf = safe(glance.at) ?? new Date(now).toISOString();
  lines.push(`Fleet snapshot at ${asOf}`);
  lines.push(`Lanes running: ${num(glance.running)} of target ${num(glance.target)}`);
  lines.push(`Merges today: ${num(glance.mergesToday)}`);
  lines.push(`Main branch: ${glance.main}`);
  if (typeof glance.usagePct === 'number' && Number.isFinite(glance.usagePct)) {
    const resets = safe(glance.resetsAt);
    lines.push(`Usage: ${Math.round(glance.usagePct)}% used (${Math.max(0, 100 - Math.round(glance.usagePct))}% headroom)${resets ? `, resets ${resets}` : ''}`);
  }
  if (glance.slowPrs) {
    lines.push(`Slow PRs (open 30+ min): ${num(glance.slowPrs.count)}`);
    for (const row of glance.slowPrs.repos.slice(0, MAX_LIST_ITEMS)) {
      const repo = safe(row.repo);
      if (repo) lines.push(`- ${repo}: ${num(row.count)} slow PR(s)`);
    }
  }
  const incidents = glance.incidents.map(safe).filter((item): item is string => item !== null);
  lines.push(`Open needs-you items: ${incidents.length}`);
  for (const title of incidents.slice(0, MAX_LIST_ITEMS)) lines.push(`- ${title}`);
  if (glance.guardian?.length) {
    lines.push('Main guardian by repo:');
    for (const row of glance.guardian.slice(0, MAX_LIST_ITEMS)) {
      const repo = safe(row.repo);
      if (repo) lines.push(`- ${repo}: ${row.state}${row.stale ? ' (stale)' : ''}, ${num(row.openFixes)} open fix job(s)`);
    }
  }

  // Cap at whole lines.
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    const next = size + line.length + (kept.length ? 1 : 0);
    if (next > MAX_FACTS_CHARS) break;
    kept.push(line);
    size = next;
  }
  return kept.join('\n');
}

export async function readCosFleetFacts(opts: {
  runsDir: string;
  now: number;
  read?: typeof readOperatorGlance;
}): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const read = opts.read ?? readOperatorGlance;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), FACT_READ_TIMEOUT_MS); });
    const glance = await Promise.race([read({ runsDir: opts.runsDir, now: () => new Date(opts.now) }), timeout]);
    return glance ? renderCosFleetFacts(glance, opts.now) : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
