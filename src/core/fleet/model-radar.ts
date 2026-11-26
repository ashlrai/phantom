/**
 * `phm models radar`: read saved provider release notes, one file per provider, and say which
 * model ids are new, retired or renamed against the one registry (model-verify.ts). It proposes
 * a registry patch and never applies it: a new id is proposed as "unverified", so the router
 * keeps refusing it until `phm models verify` confirms it from the provider's own docs.
 * Offline. model-radar-fetch.ts saves the pages this reads.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, checkModels } from './model-check.js';
import { homeFile, loadVerifiedRegistry, MODEL_SOURCE_HOSTS, readRouterChoices, readText, type ModelVerifyOptions, type VerifiedModelRegistryEntry } from './model-verify.js';

interface ProviderRule {
  /** Marks a word as this provider's, e.g. "claude". Tested on the lower-cased word. */
  family: RegExp;
  /** The exact shape of an API model id, lower case as written. Null: unknown, so every id stays low. */
  exact: RegExp | null;
}
/** The one table of id shapes. Only a full match of `exact` is high confidence. */
export const MODEL_RADAR_PROVIDERS: Readonly<Record<string, ProviderRule>> = {
  anthropic: { family: /^claude(?![a-z])/, exact: /^claude-(?:opus|sonnet|haiku|fable|mythos)-\d+(?:-\d+)?(?:-\d{8})?$/ },
  openai: { family: /^(?:gpt(?![a-z])|o\d)/, exact: /^(?:gpt-\d+(?:\.\d+)?(?:-[a-z]+){0,2}|o\d(?:-[a-z]+)?)(?:-\d{4}-\d{2}-\d{2})?$/ },
  xai: { family: /^grok(?![a-z])/, exact: /^grok-\d+(?:\.\d+)?(?:-[a-z]+){0,3}$/ },
  google: { family: /^gemini(?![a-z])/, exact: /^gemini-(?:\d+(?:\.\d+)?(?:-[a-z]+){1,3}(?:-\d{2}-\d{2,4})?|pro-orchestrator(?:-[a-z]+)?)$/ },
  zai: { family: /^glm(?![a-z])/, exact: /^glm-\d+(?:\.\d+)?[a-z]?(?:-[a-z]+){0,2}$/ },
  qwen: { family: /^qwen(?![a-z])/, exact: /^qwen\d+(?:\.\d+)?(?:(?:-[a-z]+){1,3}|:\d+b(?:-[a-z0-9]+)?)$/ },
  devin: { family: /^(?:devin|swe)(?![a-z])/, exact: /^swe-\d+(?:-\d+)?(?:-[a-z]+)*$/ },
  cursor: { family: /^(?:cursor(?:-composer)?|composer)(?![a-z])/, exact: null },
};
const ALIASES: Readonly<Record<string, string>> = { claude: 'anthropic', cognition: 'devin', gemini: 'google', 'x.ai': 'xai', 'z.ai': 'zai', 'z-ai': 'zai' };
/** The registry's provider name for a file stem or a spoken name ("Z.ai", "Cognition"). */
export const radarProvider = (name: string): string => { const key = name.trim().toLowerCase(); return ALIASES[key] ?? key; };

export type RadarConfidence = 'high' | 'low';
/** One provider's release notes. Null text: the file could not be read. */
type RadarEvidence = { source_url?: string; retrieved_on?: string };
export interface ModelRadarDoc extends RadarEvidence { provider: string; text: string | null }
export interface ModelRadarItem extends RadarEvidence {
  provider: string;
  /** The model id exactly as the doc writes it. */
  id: string;
  /** The doc line it came from, trimmed to 200 characters. */
  line: string; line_number: number;
  /** "high": the id fully matches the provider's exact id shape. "low": anything else; never in the patch. */
  confidence: RadarConfidence;
}
export interface ModelRadarRename extends ModelRadarItem { /** The registry id it replaces. `id` is the new one. */ from: string }
export interface ModelRadarProvider {
  provider: string;
  /** "unknown": no saved file, an unreadable one, or a provider with no id table. "empty": a file with no text. */
  doc: 'read' | 'empty' | 'unknown';
  in_registry: boolean;
  /** Where `phm models verify` can confirm an id. Null: unknown, so it cannot be verified yet. */
  doc_site: string | null;
  note: string | null;
}
export interface ModelRadarScan {
  new_models: ModelRadarItem[]; retired_models: ModelRadarItem[]; renamed: ModelRadarRename[];
  /** Routable-or-pending registry models of the providers that were read, with no change found. */
  unchanged_count: number;
  providers: ModelRadarProvider[];
}
/** High-confidence changes only, as unapplied registry operations. */
export interface ModelRegistryPatch {
  schema: 'models.registry-patch.v1'; version: 1; applied: false;
  add: VerifiedModelRegistryEntry[];
  retire: Array<{ provider: string; id: string }>;
  rename: Array<{ provider: string; from: string; to: string }>;
}
export interface ModelRadarReport extends ModelRadarScan {
  schema: 'models.radar.v1'; version: 1;
  /** One line: "2 new, 1 retired, 0 renamed", then what is low confidence or unknown. */
  summary: string;
  /** True only when every provider was read and nothing high-confidence is waiting. */
  ok: boolean;
  registry: 'ok' | 'unknown';
  /** The folder that was read. Null: none. */
  from: string | null;
  patch: ModelRegistryPatch;
  /** What `--fetch` saved just before this read. Null: no fetch was asked for, so the files are as old as they are. */
  fetch: ModelRadarFetchResult[] | null;
  router_choices: 'ok' | 'unknown';
  lane_notices: Array<{ lane: string; id: string; status: 'deprecated' | 'retired' | 'mentioned'; replacement: string | null; evidence?: ModelRadarItem }>;
  proposals?: { filed: string[]; existing: string[]; failed: number };
  error: string | null;
}
export interface ModelRadarFetchResult { provider: string; url: string; saved: boolean }
export interface ModelRadarOptions extends ModelVerifyOptions {
  /** Folder of saved release notes. Default: $ASHLR_HOME/model-radar. */
  from?: string;
  /** The result of a fetch into that folder, to report beside what was read. */
  fetched?: ModelRadarFetchResult[];
  /** Individual pages saved in this invocation, with their unmixed provenance. */
  freshDocs?: readonly ModelRadarDoc[];
}

const RENAME = /\b(?:renamed|is now|now called|formerly|rebranded)\b/i;
const RETIRE = /\b(?:retir\w*|sunset\w*|shut(?:s|ting)? down|discontinued|end[- ]of[- ]life|no longer available|removed)\b/i;
const DEPRECATE = /\bdeprecat\w*/i;
const active = (entry: VerifiedModelRegistryEntry) => entry.status !== 'retired';
const order = <T extends { provider: string; id: string }>(items: Iterable<T>): T[] =>
  [...items].sort((a, b) => a.provider.localeCompare(b.provider) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** Ids on one line. Tags and links are dropped first, so a URL slug is never read as an id. */
function candidates(line: string, rule: ProviderRule): Array<{ id: string; exact: boolean }> {
  const words = [...line.replace(/<[^>]*>/g, ' ').replace(/https?:\/\/\S+/g, ' ').matchAll(/[A-Za-z0-9][A-Za-z0-9._:-]*/g)]
    .map(match => match[0].replace(/[._:-]+$/, '').replace(/\.(?:md|html?|json|txt)$/, ''));
  const found: Array<{ id: string; exact: boolean }> = [];
  words.forEach((word, i) => {
    if (!rule.family.test(word.toLowerCase())) return;
    if (rule.exact?.test(word)) { found.push({ id: word, exact: true }); return; }
    if (/\d/.test(word)) { found.push({ id: word, exact: false }); return; }
    // A bare family word starts a marketing name such as "Claude Opus 7". Never exact.
    const end = [i + 2, i + 1].find(j => /^\d/.test(words[j] ?? ''));
    if (end) found.push({ id: words.slice(i, end + 1).join(' '), exact: false });
  });
  return found;
}

/**
 * Pure: release notes plus the registry in, the changes out. Equal inputs give equal output.
 * A line that says an id was retired or renamed is the only evidence used; an id the notes
 * simply do not mention is unchanged, because release notes never list every model.
 */
export function scanModelReleaseNotes(docs: readonly ModelRadarDoc[], registry: readonly VerifiedModelRegistryEntry[]): ModelRadarScan {
  const fresh = new Map<string, ModelRadarItem>(), retired = new Map<string, ModelRadarItem>(), renamed = new Map<string, ModelRadarRename>();
  const put = <T extends ModelRadarItem>(map: Map<string, T>, item: T) => {
    const key = `${item.provider}\n${item.id}`, had = map.get(key);
    if (!had || had.confidence === 'low' && item.confidence === 'high') map.set(key, item);
  };
  const rows = new Map<string, ModelRadarProvider>();
  for (const doc of [...Object.keys(MODEL_RADAR_PROVIDERS).map(provider => ({ provider, text: undefined })), ...docs]) {
    const provider = radarProvider(doc.provider), rule = MODEL_RADAR_PROVIDERS[provider];
    const mine = registry.filter(entry => entry.provider === provider), had = rows.get(provider);
    const state = !rule || doc.text === null || doc.text === undefined ? 'unknown' : doc.text.trim() ? 'read' : 'empty';
    if (had?.doc === 'read' && state !== 'read') continue;
    rows.set(provider, {
      provider, doc: state, in_registry: mine.length > 0, doc_site: MODEL_SOURCE_HOSTS[provider]?.[0] ?? null,
      note: !rule ? 'No id shapes are known for this provider, so nothing was read.'
        : doc.text === undefined ? 'No saved release notes.' : doc.text === null ? 'Could not read the saved release notes.'
        : state === 'empty' ? 'The saved release notes are empty.'
        : !mine.length ? 'No model from this provider is in the registry yet, so every id here is new.' : null,
    });
    if (state !== 'read') continue;
    const known = new Map(mine.map(entry => [entry.id, entry])), spelled = new Map(mine.map(entry => [canonical(entry.id), entry]));
    doc.text!.split(/\r?\n/).forEach((raw, index) => {
      const found = candidates(raw, rule!);
      if (!found.length) return;
      const at = { provider, ...('source_url' in doc ? { source_url: doc.source_url, retrieved_on: doc.retrieved_on } : {}),
        line: raw.replace(/[^\x20-\x7E\u00A0-\uFFFF]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200), line_number: index + 1 };
      const leaving = RETIRE.test(raw), fading = DEPRECATE.test(raw);
      const old = found.flatMap(item => known.has(item.id) && active(known.get(item.id)!) ? [item.id] : []);
      const unknown = found.filter(item => !known.has(item.id) && !known.has(item.id.toLowerCase()));
      if (RENAME.test(raw) && old.length === 1 && unknown.length === 1) {
        put(renamed, { ...at, id: unknown[0]!.id, from: old[0]!, confidence: unknown[0]!.exact ? 'high' : 'low' });
        return;
      }
      // Two registry ids on one retirement line: one is usually the replacement, so a person decides.
      if (leaving || fading) for (const id of old) put(retired, { ...at, id, confidence: leaving && old.length === 1 ? 'high' : 'low' });
      for (const item of unknown) {
        const same = spelled.get(canonical(item.id.replace(/ /g, '-')));
        // "Claude Opus 5.5" is the display name of claude-opus-5-5, not news.
        if (same && (!active(same) || item.id.includes(' ') || item.id !== item.id.toLowerCase())) continue;
        if (same) put(renamed, { ...at, id: item.id, from: same.id, confidence: 'low' });
        else put(fresh, { ...at, id: item.id, confidence: item.exact && !leaving && !fading ? 'high' : 'low' });
      }
    });
  }
  for (const item of renamed.values()) fresh.delete(`${item.provider}\n${item.id}`);
  const changed = new Set([...retired.values()].map(item => `${item.provider}\n${item.id}`).concat([...renamed.values()].map(item => `${item.provider}\n${item.from}`)));
  return {
    new_models: order(fresh.values()), retired_models: order(retired.values()), renamed: order(renamed.values()),
    unchanged_count: registry.filter(entry => active(entry) && rows.get(entry.provider)?.doc === 'read' && !changed.has(`${entry.provider}\n${entry.id}`)).length,
    providers: order([...rows.values()].map(row => ({ ...row, id: '' }))).map(({ id: _id, ...row }) => row),
  };
}

/** The registry rows the scan proposes. Low-confidence items are left out, and a new id is "unverified": not routable. */
export function proposeRegistryPatch(scan: ModelRadarScan): ModelRegistryPatch {
  const high = <T extends ModelRadarItem>(items: T[]) => items.filter(item => item.confidence === 'high');
  return {
    schema: 'models.registry-patch.v1', version: 1, applied: false,
    add: high(scan.new_models).map(({ id, provider }) => ({ id, provider, verified_source: null, verified_at: null, status: 'unverified' })),
    retire: high(scan.retired_models).map(({ provider, id }) => ({ provider, id })),
    rename: high(scan.renamed).map(({ provider, from, id }) => ({ provider, from, to: id })),
  };
}

export function radarSummary(scan: ModelRadarScan): string {
  const low = [...scan.new_models, ...scan.retired_models, ...scan.renamed].filter(item => item.confidence === 'low').length;
  const unknown = scan.providers.filter(row => row.doc !== 'read').length;
  return `${scan.new_models.length} new, ${scan.retired_models.length} retired, ${scan.renamed.length} renamed`
    + (low ? `; ${low} low confidence, left out of the patch` : '') + (unknown ? `; ${unknown} of ${scan.providers.length} providers unknown` : '');
}

/** Read the saved release notes (`<provider>.md`, `.markdown`, `.txt` or `.html`) and the registry, and report. Changes nothing. */
export async function runModelRadar(opts: ModelRadarOptions = {}): Promise<ModelRadarReport> {
  const from = homeFile('model-radar', opts.from, opts);
  const report = (scan: ModelRadarScan, error: string | null, registry: 'ok' | 'unknown' = 'ok'): ModelRadarReport => {
    const patch = proposeRegistryPatch(scan);
    return {
      schema: 'models.radar.v1', version: 1, summary: registry === 'ok' ? radarSummary(scan) : error!, registry, from,
      // A provider whose pages all failed to save was read from an older file, so it is not known to be current.
      ok: !error && scan.providers.every(row => row.doc === 'read') && !patch.add.length && !patch.retire.length && !patch.rename.length
        && (opts.fetched ?? []).every(page => page.saved || opts.fetched!.some(other => other.provider === page.provider && other.saved)),
      ...scan, patch, fetch: opts.fetched ?? null, router_choices: 'unknown', lane_notices: [], error,
    };
  };
  let registry: VerifiedModelRegistryEntry[];
  try { registry = await loadVerifiedRegistry(opts); }
  catch { return report(scanModelReleaseNotes([], []), 'The model registry could not be read, so nothing can be compared.', 'unknown'); }
  const names = from === null ? [] : await readdir(from).then(list => list.sort(), () => []);
  const docs: ModelRadarDoc[] = [];
  for (const name of names) {
    const stem = /^(.+)\.(?:md|markdown|txt|html?)$/i.exec(name)?.[1];
    if (stem && !opts.freshDocs?.some(doc => doc.provider === radarProvider(stem))) {
      docs.push({ provider: stem, text: await readText(join(from!, name), 8 * 1024 * 1024).catch(() => null) });
    }
  }
  docs.unshift(...opts.freshDocs ?? []);
  const result = report(scanModelReleaseNotes(docs, registry), docs.length ? null
    : 'No saved release notes were found. Save one file per provider (anthropic.md, openai.md, ...) and pass --from <folder>, or run: phm models radar --fetch');
  const [checked, choices] = await Promise.all([checkModels(opts), readRouterChoices(opts).catch(() => [])]);
  result.router_choices = checked.router_choices;
  const checkedById = new Map(checked.models.map(row => [row.id, row]));
  const unregistered = choices.flatMap(({ model }) => {
    if (!model || checkedById.get(model)?.provider) return [];
    const provider = Object.keys(MODEL_RADAR_PROVIDERS).find(key => MODEL_RADAR_PROVIDERS[key]!.exact?.test(model));
    return provider ? [{ provider, id: model, verified_source: null, verified_at: null, status: 'unverified' as const }] : [];
  });
  const notices = new Map([
    ...result.retired_models,
    ...(unregistered.length ? scanModelReleaseNotes(docs, unregistered).retired_models : []),
  ].map(item => [item.id, item]));
  for (const { key, model } of choices) {
    if (!model) continue;
    const row = checkedById.get(model), notice = notices.get(model);
    if (row?.docs === 'deprecated' || row?.docs === 'retired') {
      result.lane_notices.push({ lane: key, id: model, status: row.docs, replacement: row.replacement });
    } else if (notice) {
      result.lane_notices.push({ lane: key, id: model, status: 'mentioned', replacement: null, evidence: notice });
    }
  }
  if (result.lane_notices.length) result.ok = false;
  return result;
}
