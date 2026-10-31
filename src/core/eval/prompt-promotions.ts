/**
 * prompt-promotions.ts — RQ-SELFOPT-PROMPT-OPT: the prompt-variant promotion
 * registry.
 *
 * `phm eval prompts --promote` writes the registry; `phm pulse` reads it to
 * render the before/after dashboard, and `assignPromptVariant` reads it to
 * route new jobs in a promoted class to the winning prompt. One record per
 * job class — a re-promotion replaces the class's earlier record, so the
 * registry is always the current winners, never a history.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

export interface PromptPromotionMetric {
  value: number | null;
  ci95: [number, number] | null;
  n: number;
}

/** What the dashboard shows: before = control, after = promoted variant. */
export interface PromptPromotionRecord {
  classId: string;
  experimentId: string;
  variant: string;
  control: string;
  before: PromptPromotionMetric;
  after: PromptPromotionMetric;
  /** after.value - before.value in merge-rate points. */
  liftPoints: number;
  costPerMergedPrBefore: number | null;
  costPerMergedPrAfter: number | null;
  decidedAt: string;
  datasetSha256: string;
}

export interface PromptPromotionsRegistry {
  schemaVersion: 1;
  generatedAt: string;
  experimentId: string;
  dataset: { id?: string; sha256: string; jobs: number };
  /** Every class the last experiment covered — mergePromotions' overwrite set. */
  classes: string[];
  promoted: PromptPromotionRecord[];
  /** Classes evaluated but not promoted — kept so the dashboard shows holds. */
  held: Array<{ classId: string; variant: string; verdict: string }>;
}

export interface PromptPromotionsStoreOptions {
  rootDir?: string;
}

function ashlrRoot(rootDir: string | undefined): string {
  if (rootDir && rootDir.trim() !== '') return rootDir;
  const configuredHome = process.env.ASHLR_HOME;
  if (typeof configuredHome === 'string' && configuredHome.trim() !== '') return configuredHome;
  return path.join(homedir(), '.ashlr');
}

export function promptPromotionsPath(opts: PromptPromotionsStoreOptions = {}): string {
  return path.join(ashlrRoot(opts.rootDir), 'eval', 'prompts', 'promotions.json');
}

export function loadPromptPromotions(opts: PromptPromotionsStoreOptions = {}): PromptPromotionsRegistry | null {
  const file = promptPromotionsPath(opts);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as PromptPromotionsRegistry;
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.promoted) || !Array.isArray(parsed.held)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Merge a fresh experiment's verdicts into the stored registry: classes the
 * experiment covered take the new record (promotion or hold); classes it did
 * not cover keep their stored records untouched.
 */
export function mergePromotions(
  existing: PromptPromotionsRegistry | null,
  next: PromptPromotionsRegistry,
): PromptPromotionsRegistry {
  if (existing === null) return next;
  const covered = new Set(next.classes);
  const promoted = [
    ...existing.promoted.filter((p) => !covered.has(p.classId)),
    ...next.promoted,
  ];
  const held = [
    ...existing.held.filter((h) => !covered.has(h.classId)),
    ...next.held,
  ];
  return { ...next, promoted, held };
}

/** Atomic write (tmp + rename), same stance as the attention report store. */
export function savePromptPromotions(
  registry: PromptPromotionsRegistry,
  opts: PromptPromotionsStoreOptions = {},
): string {
  const file = promptPromotionsPath(opts);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n', 'utf8');
    renameSync(tmp, file);
    return file;
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup only
    }
    throw err;
  }
}
