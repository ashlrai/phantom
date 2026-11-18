/**
 * `phm models check`: every model the router can pick, read from the one registry
 * (model-verify.ts) plus the router's choices in models.json. Read-only and offline.
 * The Models card and `GET /api/verse/fleet/control/models/check` return the same report.
 */
import { basename } from 'node:path';
import { loadVerifiedRegistry, MODEL_ALIASES, readRouterChoices, readText, selectVerifiedModel, type ModelVerifyOptions, type VerifiedModelRegistryEntry } from './model-verify.js';

export const MODEL_CHECK_STALE_DAYS = 14;
export type ModelCheckState = 'confirmed' | 'stale' | 'unconfirmed';
export interface ModelCheckRow {
  id: string;
  /** Null when a lane uses an id that is not in the registry. */
  provider: string | null;
  /** Lanes recorded in the registry or set in models.json. Empty means unknown. */
  lanes: string[];
  source_url: string | null; confirmed_on: string | null; state: ModelCheckState;
  /** The router's own answer (selectVerifiedModel). Always false for unconfirmed. */
  routable: boolean;
  reason: string | null;
}
export interface ModelCheckDiff {
  file: string;
  /** The provider the page is about, inferred from the ids it names. */
  provider: string | null;
  /** On the page, not in the registry. */
  new: string[];
  /** The same id written another way (dots for dashes, a date suffix added or dropped). */
  renamed: Array<{ from: string; to: string }>;
  /** In the registry for this provider, not on the page. */
  retired: string[];
  error: string | null;
}
export interface ModelCheckReport {
  schema: 'models.check.v1'; version: 1;
  /** True only when nothing needs doing: no stale or unconfirmed model, and an empty diff. */
  ok: boolean;
  /** "unknown": the registry could not be read, so no model is listed and none is routable. */
  registry: 'ok' | 'unknown';
  /** "unknown": models.json could not be read, so lanes come from the registry alone. */
  router_choices: 'ok' | 'unknown';
  stale_after_days: typeof MODEL_CHECK_STALE_DAYS;
  counts: Record<ModelCheckState, number>;
  models: ModelCheckRow[];
  diff: ModelCheckDiff | null;
  error: string | null;
}
export interface ModelCheckOptions extends ModelVerifyOptions { /** A provider release-notes page saved to disk. */ diffPath?: string }

const DAY = 86_400_000;
const sorted = (ids: Iterable<string>) => [...new Set(ids)].sort();
const family = (id: string) => /^[a-z]+/.exec(id)?.[0] ?? '';
const canonical = (id: string) => id.toLowerCase().replace(/[.:]/g, '-').replace(/-(?:\d{8}|latest)$/, '');

/** Model ids in saved page text: lower-case tokens with a digit that start with a family the registry knows (claude, gpt, ...). */
export function parseReleaseNoteIds(text: string, families: Iterable<string>): string[] {
  const names = [...new Set(families)].filter(name => /^[a-z]+$/.test(name));
  if (!names.length) return [];
  const pattern = new RegExp(`(?<![a-z0-9])(?:${names.join('|')})[0-9]*(?:[-.:][a-z0-9]+)+`, 'g');
  return sorted([...text.matchAll(pattern)].map(match => match[0].replace(/\.(?:md|html?|json|txt)$/, '')).filter(id => /\d/.test(id)));
}

/** Compare the registry with the ids a saved release-notes page names. A guide for a person or agent to confirm, never an edit. */
export function diffReleaseNotes(text: string, registry: readonly VerifiedModelRegistryEntry[], file: string): ModelCheckDiff {
  const providerOf = new Map(registry.map(entry => [family(entry.id), entry.provider]));
  const found = parseReleaseNoteIds(text, providerOf.keys());
  const tally = new Map<string, number>();
  for (const id of found) { const provider = providerOf.get(family(id))!; tally.set(provider, (tally.get(provider) ?? 0) + 1); }
  const [first, second] = [...tally].sort((a, b) => b[1] - a[1]);
  const none = { file, provider: null, new: [], renamed: [], retired: [] };
  if (!first) return { ...none, error: 'No model ids from a known provider were found in this file.' };
  if (second && second[1] === first[1]) return { ...none, error: 'Could not tell which provider this page is from.' };
  const provider = first[0], onPage = found.filter(id => providerOf.get(family(id)) === provider);
  const known = new Set(registry.map(entry => entry.id));
  let fresh = onPage.filter(id => !known.has(id));
  const gone = registry.filter(entry => entry.provider === provider && entry.status !== 'retired' && !onPage.includes(entry.id)).map(entry => entry.id);
  const renamed: ModelCheckDiff['renamed'] = [];
  for (const from of gone) {
    const matches = fresh.filter(id => canonical(id) === canonical(from));
    if (matches.length !== 1) continue;
    renamed.push({ from, to: matches[0]! });
    fresh = fresh.filter(id => id !== matches[0]);
  }
  return { file, provider, new: fresh, renamed, retired: gone.filter(id => !renamed.some(pair => pair.from === id)), error: null };
}

export async function checkModels(opts: ModelCheckOptions = {}): Promise<ModelCheckReport> {
  const now = (opts.now ?? Date.now)();
  const report: ModelCheckReport = {
    schema: 'models.check.v1', version: 1, ok: false, registry: 'unknown', router_choices: 'unknown', stale_after_days: MODEL_CHECK_STALE_DAYS,
    counts: { confirmed: 0, stale: 0, unconfirmed: 0 }, models: [], diff: null,
    error: 'The model registry could not be read, so every model is unknown and none is routable.',
  };
  let registry: VerifiedModelRegistryEntry[];
  try { registry = await loadVerifiedRegistry({ ...opts, now: () => now }); } catch { return report; }
  const used = new Map<string, string[]>();
  try {
    for (const { key, model } of await readRouterChoices(opts))
      if (model && !MODEL_ALIASES.has(model)) used.set(model, [...used.get(model) ?? [], key.split('.')[0]!]);
    report.router_choices = 'ok';
  } catch { /* stays unknown */ }
  const entries = new Map(registry.map(entry => [entry.id, entry]));
  // A retired model is listed only while a lane still points at it.
  for (const id of sorted([...registry.filter(entry => entry.status !== 'retired').map(entry => entry.id), ...used.keys()])) {
    const entry = entries.get(id), confirmed = entry?.status === 'verified';
    const state: ModelCheckState = !confirmed ? 'unconfirmed' : now - Date.parse(entry.verified_at!) > MODEL_CHECK_STALE_DAYS * DAY ? 'stale' : 'confirmed';
    report.counts[state]++;
    report.models.push({
      id, provider: entry?.provider ?? null, lanes: sorted([...entry?.lanes ?? [], ...used.get(id) ?? []]),
      source_url: entry?.verified_source ?? null, confirmed_on: entry?.verified_at ?? null, state,
      routable: selectVerifiedModel([id], registry).model === id,
      reason: !entry ? 'Not in the registry. The router will not use it.'
        : entry.status === 'retired' ? 'Retired. The router will not use it.'
        : !confirmed ? 'Not confirmed by official docs. The router will not use it.'
        : state === 'stale' ? `Confirmed over ${MODEL_CHECK_STALE_DAYS} days ago. Check the docs again.` : null,
    });
  }
  if (opts.diffPath !== undefined) {
    const file = basename(opts.diffPath);
    report.diff = await readText(opts.diffPath, 8 * 1024 * 1024).then(text => diffReleaseNotes(text, registry, file),
      () => ({ file, provider: null, new: [], renamed: [], retired: [], error: 'Could not read this file.' }));
  }
  const { diff } = report;
  report.registry = 'ok';
  report.error = null;
  report.ok = !report.counts.stale && !report.counts.unconfirmed && (!diff || !diff.error && !diff.new.length && !diff.renamed.length && !diff.retired.length);
  return report;
}
