/** Offline documentation freshness check; this does not prove account access. */
import { constants } from 'node:fs';
import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

export type ModelStatus = 'verified' | 'unverified' | 'retired';
export interface VerifiedModelRegistryEntry {
  id: string; provider: string; status: ModelStatus; verified_source: string | null; verified_at: string | null;
  /** Fleet lanes recorded as able to run this model. Absent means unknown, never "none". */
  lanes?: string[];
}
export interface ModelVerifyIssue { key: string; model: string | null; reason: 'unregistered' | 'stale' | 'invalid-model' | 'unverified' | 'retired' }
export interface ModelVerifyReport { schema: 'fleet.model-verify.v1'; issues: ModelVerifyIssue[]; error?: string }
export interface ModelVerifyOptions {
  runsDir?: string; registryPath?: string | URL; now?: () => number;
  /** This machine's verification records. Default: $ASHLR_HOME/model-registry.json, or none when registryPath is set. */
  localRegistryPath?: string | null;
  /** The confirmed list from provider docs. Default: $ASHLR_HOME/model-docs.json, or none when registryPath is set. */
  docsPath?: string | null;
}
/** Launcher shorthands that are not model IDs. */
export const MODEL_ALIASES: ReadonlySet<string> = new Set(['haiku', 'sonnet', 'opus', 'auto', 'fast', 'strong']);
const DAY = 86_400_000;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Refuse pipes/symlinks and cap reads even if a file grows during inspection. */
export async function readText(path: string | URL, max = 1024 * 1024): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > max) throw new Error('invalid source');
    const buffer = Buffer.alloc(max + 1);
    let size = 0, count: number;
    do { count = (await file.read(buffer, size, buffer.length - size, null)).bytesRead; size += count; }
    while (count && size <= max);
    if (size > max) throw new Error('source too large');
    return buffer.subarray(0, size).toString('utf8');
  } finally { await file.close(); }
}
const readJson = async (path: string | URL): Promise<unknown> => JSON.parse(await readText(path));
/** The router's choices in models.json, in file order. Effort and mode rows are launcher settings, not model IDs. Throws when unreadable. */
export async function readRouterChoices(opts: ModelVerifyOptions = {}): Promise<Array<{ key: string; model: string | null }>> {
  const models = await readJson(join(opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), 'models.json'));
  if (!object(models)) throw new Error('invalid model sources');
  return Object.keys(models).filter(key => key !== 'effort' && !key.startsWith('effort.') && !key.startsWith('mode.'))
    .map(key => ({ key, model: typeof models[key] === 'string' ? models[key].trim() : null }));
}

export async function verifyFleetModels(opts: ModelVerifyOptions = {}): Promise<ModelVerifyReport> {
  const choices = await readRouterChoices(opts);
  const now = (opts.now ?? Date.now)();
  const entries = new Map((await loadVerifiedRegistry({ ...opts, now: () => now })).map(row => [row.id, row]));
  const issues: ModelVerifyIssue[] = [];
  for (const { key, model } of choices) {
    if (!model) { issues.push({ key, model: null, reason: 'invalid-model' }); continue; }
    if (MODEL_ALIASES.has(model)) continue;
    const entry = entries.get(model);
    if (!entry) issues.push({ key, model, reason: 'unregistered' });
    else if (entry.status !== 'verified') issues.push({ key, model, reason: entry.status });
    else if (now - Date.parse(entry.verified_at!) > 30 * DAY) issues.push({ key, model, reason: 'stale' });
  }
  return { schema: 'fleet.model-verify.v1', issues };
}

/** Exact provider hosts: a URL or a successful fetch alone never verifies an ID. */
export const MODEL_SOURCE_HOSTS: Readonly<Record<string, readonly string[]>> = {
  openai: ['learn.chatgpt.com', 'developers.openai.com', 'platform.openai.com'],
  anthropic: ['platform.claude.com'], xai: ['docs.x.ai'], zai: ['docs.z.ai'],
  qwen: ['qwenlm.github.io', 'qwen.readthedocs.io'],
};
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/, LANE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;
function sourceHostError(provider: string, source: string): string | null {
  let url: URL | null = null;
  try { url = new URL(source); } catch { /* reported below */ }
  const hosts = MODEL_SOURCE_HOSTS[provider];
  if (!hosts) return `No official doc site is recorded for provider "${provider}". Known providers: ${Object.keys(MODEL_SOURCE_HOSTS).join(', ')}.`;
  return url && url.protocol === 'https:' && !url.username && !url.password && !url.port && hosts.includes(url.hostname)
    ? null : `The source must be an https page on ${hosts.join(' or ')}.`;
}
function parseEntry(row: unknown, now: number): VerifiedModelRegistryEntry {
  if (!object(row) || typeof row.id !== 'string' || !MODEL_ID.test(row.id) || typeof row.provider !== 'string' || !row.provider.trim()
    || typeof row.status !== 'string' || !['verified', 'unverified', 'retired'].includes(row.status)) throw new Error('Invalid registry entry');
  if (row.lanes !== undefined && (!Array.isArray(row.lanes) || row.lanes.length > 32
    || row.lanes.some(lane => typeof lane !== 'string' || !LANE.test(lane)))) throw new Error('Invalid lanes');
  if (row.verified_source !== null && (typeof row.verified_source !== 'string' || sourceHostError(row.provider, row.verified_source))) throw new Error('Invalid model source');
  if (row.verified_at !== null) {
    if (typeof row.verified_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.verified_at)) throw new Error('Invalid verification date');
    const date = Date.parse(row.verified_at);
    if (!Number.isFinite(date) || date > now || new Date(date).toISOString().slice(0, 10) !== row.verified_at) throw new Error('Invalid verification date');
  }
  if (row.status !== 'unverified' && (!row.verified_at || !row.verified_source)) throw new Error('Missing verification evidence');
  return row as unknown as VerifiedModelRegistryEntry;
}
const byId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
/** A path under $ASHLR_HOME. Null when a test registry is injected and no path was set, so tests never read the real home. */
export function homeFile(name: string, set: string | null | undefined, opts: ModelVerifyOptions): string | null {
  if (set !== undefined) return set;
  if (opts.registryPath) return null;
  const home = process.env.ASHLR_HOME;
  return join(home && isAbsolute(home) ? home : join(homedir(), '.ashlr'), name);
}
const localPath = (opts: ModelVerifyOptions) => homeFile('model-registry.json', opts.localRegistryPath, opts);
/** Verified records written by `phm models verify`. A missing or damaged file adds nothing; bad rows are dropped. */
async function readLocalRecords(path: string | null, now: number): Promise<VerifiedModelRegistryEntry[]> {
  const raw = path === null ? [] : await readJson(path).catch(() => []);
  return (Array.isArray(raw) ? raw : []).flatMap(row => {
    try { const entry = parseEntry(row, now); return entry.status === 'verified' ? [entry] : []; } catch { return []; }
  });
}
/** The one registry: the shipped list, plus newer verification records made on this machine. */
export async function loadVerifiedRegistry(opts: ModelVerifyOptions = {}): Promise<VerifiedModelRegistryEntry[]> {
  const raw = await readJson(opts.registryPath ?? new URL('../../../docs/model-registry.json', import.meta.url));
  const now = (opts.now ?? Date.now)();
  if (!Array.isArray(raw) || !Number.isFinite(now)) throw new Error('Invalid registry');
  const entries = new Map<string, VerifiedModelRegistryEntry>();
  for (const row of raw) {
    const entry = parseEntry(row, now);
    if (entries.has(entry.id)) throw new Error('Invalid registry entry');
    entries.set(entry.id, entry);
  }
  for (const local of await readLocalRecords(localPath(opts), now)) {
    const shipped = entries.get(local.id);
    // A local record never revives a retired model, changes a provider, or replaces newer shipped evidence.
    if (shipped && (shipped.status === 'retired' || shipped.provider !== local.provider || (shipped.verified_at ?? '') > local.verified_at!)) continue;
    entries.set(local.id, { ...shipped, ...local, ...(local.lanes ?? shipped?.lanes ? { lanes: local.lanes ?? shipped?.lanes } : {}) });
  }
  return [...entries.values()].sort(byId);
}

export interface ModelRegistryRow {
  id: string; provider: string;
  /** Empty means unknown. */
  lanes: string[];
  /** True only for status "verified"; the router refuses everything else. */
  verified: boolean; status: ModelStatus; source_url: string | null; verified_on: string | null;
  unverified: boolean;
  /** Verified over 30 days ago. Still routable; check the docs again. */
  stale: boolean;
  /** Plain words for anything that needs attention, else null. */
  reason: string | null;
}
export interface ModelRegistryList { schema: 'models.registry.v1'; entries: ModelRegistryRow[] }
/** What `phm models`, the Models panel and agents all read. Sorted by id; no clock fields, so equal inputs give equal JSON. */
export async function listModelRegistry(opts: ModelVerifyOptions = {}): Promise<ModelRegistryList> {
  const now = (opts.now ?? Date.now)();
  const entries = (await loadVerifiedRegistry({ ...opts, now: () => now })).map((entry): ModelRegistryRow => {
    const verified = entry.status === 'verified', stale = verified && now - Date.parse(entry.verified_at!) > 30 * DAY;
    return {
      id: entry.id, provider: entry.provider, lanes: [...entry.lanes ?? []].sort(), verified, status: entry.status,
      source_url: entry.verified_source, verified_on: entry.verified_at, unverified: !verified, stale,
      reason: entry.status === 'retired' ? 'Retired. The router will not use it.'
        : !verified ? 'Not confirmed by official docs. The router will not use it.'
        : stale ? 'Verified over 30 days ago. Check the docs again.' : null,
    };
  });
  return { schema: 'models.registry.v1', entries };
}

/** A refusal the caller can show as is. */
export class ModelVerifyRefusal extends Error {}
export interface MarkModelVerifiedInput { id: string; source: string; provider?: string; lanes?: string[] }
/**
 * Mark one model verified after reading its official doc page: the page must be on the
 * provider's own doc site and must mention the exact id. Anything else changes nothing.
 */
export async function markModelVerified(input: MarkModelVerifiedInput, opts: ModelVerifyOptions & { fetch?: typeof fetch } = {}): Promise<ModelRegistryRow> {
  const now = (opts.now ?? Date.now)(), path = localPath(opts), { id, source } = input;
  if (typeof id !== 'string' || !MODEL_ID.test(id)) throw new ModelVerifyRefusal('That is not a valid model id.');
  if (typeof source !== 'string' || !source) throw new ModelVerifyRefusal('Give the official doc page with --source <url>.');
  if (path === null) throw new ModelVerifyRefusal('This registry is read-only.');
  const known = (await loadVerifiedRegistry({ ...opts, now: () => now })).find(entry => entry.id === id);
  const provider = known?.provider ?? input.provider;
  if (!provider) throw new ModelVerifyRefusal(`${id} is not in the registry. To add it, name its provider: --provider <${Object.keys(MODEL_SOURCE_HOSTS).join('|')}>.`);
  if (input.provider && input.provider !== provider) throw new ModelVerifyRefusal(`${id} is registered under provider ${provider}.`);
  if (known?.status === 'retired') throw new ModelVerifyRefusal(`${id} is retired and cannot be verified here.`);
  if (input.lanes?.some(lane => !LANE.test(lane))) throw new ModelVerifyRefusal('A lane name is not valid.');
  const hostError = sourceHostError(provider, source);
  if (hostError) throw new ModelVerifyRefusal(hostError);
  const { checkModelDoc } = await import('./model-docs-verify.js');
  const found = await checkModelDoc(id, source, { fetch: opts.fetch });
  if (found !== 'confirmed') throw new ModelVerifyRefusal(found === 'unknown'
    ? `Could not read ${source}, so ${id} stays as it was.` : `${source} does not mention ${id}, so it stays as it was.`);
  const lanes = input.lanes?.length ? [...new Set(input.lanes)].sort() : known?.lanes;
  const record: VerifiedModelRegistryEntry = { id, provider, verified_source: source, verified_at: new Date(now).toISOString().slice(0, 10), status: 'verified', ...(lanes ? { lanes } : {}) };
  const records = [...(await readLocalRecords(path, now)).filter(row => row.id !== id), record].sort(byId);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${now}.tmp`;
  await writeFile(temporary, `${JSON.stringify(records, null, 1)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
  return (await listModelRegistry({ ...opts, now: () => now })).entries.find(row => row.id === id)!;
}

export type DocsModelStatus = 'current' | 'deprecated' | 'retired';
/** One model as a provider's docs or changelog describe it. A docs-watch job writes these; nothing here fetches them. */
export interface DocsModelRecord {
  provider: string; id: string; status: DocsModelStatus;
  /** The model the docs say to move to, when they name one. */
  replacement?: string | null;
  source_url: string;
  /** ISO date or timestamp. The newest record for a model wins. */
  seen_at: string;
}
/** A registry entry as the docs check reads it. Lanes, capabilities and added_at are carried, never judged. */
export interface RegistryModelInput { provider: string; id: string; lanes?: readonly string[]; capabilities?: readonly string[]; added_at?: string | null }
/** "unknown": the docs list has no record at all for this provider, so nothing can be said. */
export type DocsVerdict = 'confirmed' | 'deprecated' | 'retired' | 'unconfirmed' | 'unknown';
export interface DocsCheckRow { provider: string; id: string; lanes: string[]; verdict: DocsVerdict; replacement: string | null; source_url: string | null; seen_at: string | null }
export interface DocsCheckResult {
  /** One plain sentence, for the top of `phm models check` and the Models card. */
  summary: string;
  counts: Record<DocsVerdict, number>;
  /** One row per registry entry, sorted by provider then id. */
  models: DocsCheckRow[];
  /** Current models in the docs that the registry lacks. */
  missing: DocsModelRecord[];
}
const docsKey = (row: { provider: string; id: string }) => `${row.provider}\n${row.id}`;
const byProviderId = (a: { provider: string; id: string }, b: { provider: string; id: string }) => docsKey(a) < docsKey(b) ? -1 : docsKey(a) > docsKey(b) ? 1 : 0;
const some = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
/**
 * Compare the registry with what provider docs confirm. Pure: both lists are passed in,
 * and equal inputs give equal output. The CLI, the Models card and the router all use it.
 */
export function checkModelsAgainstDocs(registry: readonly RegistryModelInput[], docs: readonly DocsModelRecord[]): DocsCheckResult {
  const latest = new Map<string, DocsModelRecord>();
  for (const record of docs) if (record.seen_at > (latest.get(docsKey(record))?.seen_at ?? '')) latest.set(docsKey(record), record);
  const covered = new Set(docs.map(record => record.provider));
  const counts: Record<DocsVerdict, number> = { confirmed: 0, deprecated: 0, retired: 0, unconfirmed: 0, unknown: 0 };
  const models = [...registry].sort(byProviderId).map((entry): DocsCheckRow => {
    const record = latest.get(docsKey(entry));
    const verdict: DocsVerdict = !record ? covered.has(entry.provider) ? 'unconfirmed' : 'unknown' : record.status === 'current' ? 'confirmed' : record.status;
    counts[verdict]++;
    return { provider: entry.provider, id: entry.id, lanes: [...entry.lanes ?? []].sort(), verdict, replacement: record?.replacement ?? null, source_url: record?.source_url ?? null, seen_at: record?.seen_at ?? null };
  });
  const have = new Set(registry.map(docsKey));
  const missing = [...latest.values()].filter(record => record.status === 'current' && !have.has(docsKey(record))).sort(byProviderId);
  const routed = (count: number) => some(count, 'model we route to is', 'models we route to are');
  const parts = [
    counts.unconfirmed ? `${routed(counts.unconfirmed)} not in any provider's docs` : '',
    counts.retired ? `${routed(counts.retired)} retired` : '',
    counts.deprecated ? `${routed(counts.deprecated)} deprecated` : '',
    counts.unknown ? `${some(counts.unknown, 'model', 'models')} could not be checked (no docs list for the provider)` : '',
    missing.length ? `${some(missing.length, 'new model shipped and is', 'new models shipped and are')} missing` : '',
  ].filter(Boolean);
  const summary = parts.length ? parts.join('; ') : registry.length ? `${registry.length === 1 ? 'The 1 model we route to is' : `All ${registry.length} models we route to are`} confirmed by provider docs` : 'No models are registered';
  return { summary: `${summary}.`, counts, models, missing };
}

export const MODEL_DOCS_SCHEMA = 'models.docs.v1';
/**
 * The confirmed list a docs-watch job writes: {schema: "models.docs.v1", version: 1, records: DocsModelRecord[]}.
 * Null means unknown (no file, or another shape), and callers then skip the docs check. A row that is
 * malformed or whose source is not on the provider's own doc site is dropped.
 */
export async function readDocsRecords(opts: ModelVerifyOptions = {}): Promise<DocsModelRecord[] | null> {
  const path = homeFile('model-docs.json', opts.docsPath, opts);
  const raw = path === null ? null : await readJson(path).catch(() => null);
  if (!object(raw) || raw.schema !== MODEL_DOCS_SCHEMA || raw.version !== 1 || !Array.isArray(raw.records)) return null;
  return raw.records.flatMap((row): DocsModelRecord[] => {
    if (!object(row)) return [];
    const { provider, id, status, replacement = null, source_url, seen_at } = row;
    return typeof provider === 'string' && typeof id === 'string' && MODEL_ID.test(id)
      && (status === 'current' || status === 'deprecated' || status === 'retired')
      && (replacement === null || typeof replacement === 'string' && MODEL_ID.test(replacement))
      && typeof source_url === 'string' && !sourceHostError(provider, source_url)
      && typeof seen_at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(seen_at) && Number.isFinite(Date.parse(seen_at))
      ? [{ provider, id, status, replacement, source_url, seen_at }] : [];
  });
}

/**
 * Preserve the lane's offered order. Stale evidence requests review, not retirement.
 * With a docs list, a verified model that provider docs call retired, or do not name, is skipped too;
 * docs can only take a model away, never make an unverified one routable.
 */
export function selectVerifiedModel(models: readonly string[], registry: readonly VerifiedModelRegistryEntry[], docs?: readonly DocsModelRecord[] | null): { model: string | null; reason: string | null } {
  const skipped: string[] = [];
  const refused = new Map<string, string>();
  for (const row of docs?.length ? checkModelsAgainstDocs(registry, docs).models : []) {
    if (row.verdict === 'retired') refused.set(row.id, 'retired in provider docs');
    else if (row.verdict === 'unconfirmed') refused.set(row.id, 'not in provider docs');
  }
  for (const model of [...new Set(models)]) {
    const listed = registry.find(entry => entry.id === model)?.status ?? 'unverified';
    const status = listed === 'verified' ? refused.get(model) ?? listed : listed;
    if (status === 'verified') return { model, reason: skipped.length ? `${skipped.join(' ')} Using verified model ${model} on the same lane.` : null };
    skipped.push(`Skipped ${model}: ${status}.`);
  }
  return { model: null, reason: `${skipped.join(' ')} No verified model is available on this lane.`.trim() };
}

export async function verifyModelRegistry(opts: ModelVerifyOptions = {}) {
  const now = (opts.now ?? Date.now)();
  const entries = await loadVerifiedRegistry({ ...opts, now: () => now });
  const results = entries.map(({ id, provider, status, verified_source, verified_at }) => ({
    id, provider, status, verified_source, verified_at,
    age_days: verified_at === null ? null : Math.floor((now - Date.parse(verified_at)) / DAY),
    needs_recheck: verified_at === null || now - Date.parse(verified_at) > 14 * DAY,
  }));
  const report = { schema: 'models.verify.v1' as const, results, current_choices: [] as Array<{ key: string; model: string | null; status: ModelStatus }>, ok: false, error: null as string | null };
  try {
    report.current_choices = (await readRouterChoices(opts)).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
      .map(({ key, model }) => ({ key, model, status: entries.find(entry => entry.id === model)?.status ?? 'unverified' }));
    report.ok = report.current_choices.every(choice => choice.status === 'verified');
  } catch { report.error = 'Cannot read or validate models.json; current router choices are unknown.'; }
  return report;
}
