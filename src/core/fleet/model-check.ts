/**
 * `phm models check`: every model the router can pick, read from the one registry
 * (model-verify.ts) plus the router's choices in models.json, compared with the confirmed
 * list from provider docs when a docs-watch job has written one. Read-only and offline.
 * The Models card and `GET /api/verse/fleet/control/models/check` return the same report.
 */
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { checkModelsAgainstDocs, loadVerifiedRegistry, MODEL_ALIASES, readDocsRecords, readRouterChoices, readText, selectVerifiedModel, type DocsModelRecord, type DocsVerdict, type ModelVerifyOptions, type VerifiedModelRegistryEntry } from './model-verify.js';

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
  /** What provider docs say. "unknown": no docs list, none for this provider, or the id is not an active registry entry. */
  docs: DocsVerdict;
  /** The model the docs say to move to, for a deprecated or retired one. */
  replacement: string | null;
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
  /** The top line, in plain words. */
  summary: string;
  /** True only when nothing needs doing: no stale or unconfirmed model, nothing the docs flag or add, and an empty diff. */
  ok: boolean;
  /** "unknown": the registry could not be read, so no model is listed and none is routable. */
  registry: 'ok' | 'unknown';
  /** "unknown": models.json could not be read, so lanes come from the registry alone. */
  router_choices: 'ok' | 'unknown';
  /** "unknown": no confirmed list from provider docs could be read, so models are checked against the registry only. */
  docs: 'ok' | 'unknown';
  /** The newest seen_at in the docs list. */
  docs_as_of: string | null;
  stale_after_days: typeof MODEL_CHECK_STALE_DAYS;
  counts: Record<ModelCheckState, number>;
  models: ModelCheckRow[];
  /** Models the docs call current that the registry lacks. */
  missing: DocsModelRecord[];
  diff: ModelCheckDiff | null;
  error: string | null;
}
export interface ModelCheckOptions extends ModelVerifyOptions { /** A provider release-notes page saved to disk. */ diffPath?: string }

const DAY = 86_400_000;
const NO_REGISTRY = 'The model registry could not be read, so every model is unknown and none is routable.';
const DOCS_REASON: Partial<Record<DocsVerdict, (use: string | null) => string>> = {
  retired: use => `Retired in provider docs. The router will not use it.${use ? ` Use ${use}.` : ''}`,
  unconfirmed: () => 'Not in provider docs. The router will not use it.',
  deprecated: use => `Deprecated in provider docs.${use ? ` Move to ${use}.` : ''}`,
};
const sorted = (ids: Iterable<string>) => [...new Set(ids)].sort();
const family = (id: string) => /^[a-z]+/.exec(id)?.[0] ?? '';
/** One spelling for ids that differ only by dots, colons or a date suffix. */
export const canonical = (id: string) => id.toLowerCase().replace(/[.:]/g, '-').replace(/-(?:\d{8}|latest)$/, '');

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
    schema: 'models.check.v1', version: 1, summary: NO_REGISTRY, ok: false, registry: 'unknown', router_choices: 'unknown', docs: 'unknown', docs_as_of: null,
    stale_after_days: MODEL_CHECK_STALE_DAYS, counts: { confirmed: 0, stale: 0, unconfirmed: 0 }, models: [], missing: [], diff: null, error: NO_REGISTRY,
  };
  let registry: VerifiedModelRegistryEntry[];
  try { registry = await loadVerifiedRegistry({ ...opts, now: () => now }); } catch { return report; }
  const used = new Map<string, string[]>();
  let macAuto = false;
  try {
    const choices = await readRouterChoices(opts);
    if (choices.some(choice => choice.model === 'auto')) {
      const runsDir = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
      macAuto = await lstat(join(runsDir, 'bin', 'dispatchd.py')).then(info => info.isFile() || info.isSymbolicLink(), () => false);
    }
    for (const { key, model } of choices)
      if (model && !MODEL_ALIASES.has(model)) used.set(model, [...used.get(model) ?? [], key.split('.')[0]!]);
    report.router_choices = 'ok';
  } catch { /* stays unknown */ }
  const entries = new Map(registry.map(entry => [entry.id, entry]));
  // Docs are judged against the models we route to; a model the registry already retired is neither checked nor "missing".
  const records = await readDocsRecords(opts);
  const docsInputs = registry.filter(entry => entry.status !== 'retired').map(({ id, provider }) => ({ id, provider }));
  const checkRecords = records?.filter(record => entries.get(record.id)?.status !== 'retired') ?? [];
  for (const [id, lanes] of used) {
    if (entries.has(id) || !lanes.includes('agy')) continue;
    const notice = checkRecords.find(record => record.partial && (record.id === id ||
      record.id === 'gemini-3.8-flash' && /^gemini-3\.8-flash-(?:low|medium|high|xhigh)$/.test(id)));
    if (!notice) continue;
    docsInputs.push({ id, provider: notice.provider });
    if (id !== notice.id) checkRecords.push({ ...notice, id });
  }
  const check = records && checkModelsAgainstDocs(docsInputs, checkRecords);
  const verdicts = new Map(check?.models.map(row => [row.id, row]));
  // A retired model is listed only while a lane still points at it.
  for (const id of sorted([...registry.filter(entry => entry.status !== 'retired').map(entry => entry.id), ...used.keys()])) {
    const entry = entries.get(id), confirmed = entry?.status === 'verified', docs = verdicts.get(id);
    const state: ModelCheckState = !confirmed ? 'unconfirmed' : now - Date.parse(entry.verified_at!) > MODEL_CHECK_STALE_DAYS * DAY ? 'stale' : 'confirmed';
    report.counts[state]++;
    report.models.push({
      id, provider: entry?.provider ?? null, lanes: sorted([...entry?.lanes ?? [], ...used.get(id) ?? []]),
      source_url: entry?.verified_source ?? null, confirmed_on: entry?.verified_at ?? null, state,
      routable: selectVerifiedModel([id], registry, records).model === id,
      docs: docs?.verdict ?? 'unknown', replacement: docs?.replacement ?? null,
      reason: !entry ? docs && DOCS_REASON[docs.verdict] ? DOCS_REASON[docs.verdict]!(docs.replacement) : 'Not in the registry. The router will not use it.'
        : entry.status === 'retired' ? 'Retired. The router will not use it.'
        : !confirmed ? 'Not confirmed by official docs. The router will not use it.'
        : docs && DOCS_REASON[docs.verdict] ? DOCS_REASON[docs.verdict]!(docs.replacement)
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
  report.summary = check?.summary ?? 'Provider docs are unknown: no confirmed list yet, so models are checked against the registry only.';
  if (macAuto) report.summary += ' Warning: auto is configured in the Mac dispatcher runs directory; it needs the Security re-pinned launcher before use.';
  if (check) Object.assign(report, { docs: 'ok', docs_as_of: records.reduce<string | null>((max, record) => max !== null && max > record.seen_at ? max : record.seen_at, null), missing: check.missing });
  report.ok = !report.counts.stale && !report.counts.unconfirmed && !(check && (check.counts.unconfirmed || check.counts.retired || check.counts.deprecated || check.missing.length)) && (!diff || !diff.error && !diff.new.length && !diff.renamed.length && !diff.retired.length);
  return report;
}
