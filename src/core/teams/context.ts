/**
 * Shared, company-agnostic context with context-window efficiency.
 *
 * Entries are scoped (org/team/project/person + Locus owner scope) and carry
 * provenance. Retrieval scores entries lexically against the query, filters by
 * scope (client:<x> context is only ever returned to client:<x> requests), then
 * compresses: sentence-level dedupe + query-relevance selection under a token
 * budget, following the ashlr-core-efficiency "compact, cited" contract.
 */
import { validOwnerScope, type OwnerScope, type TeamActor } from './protocol.js';
import { appendEvent, readEvents } from './store.js';

export interface ContextScope { project?: string; person?: string; owner: OwnerScope }
export interface ContextEntry { id: string; scope: ContextScope; title: string; text: string; source: string; author: string; ts: string; tags: string[]; importance: number; supersedes: string[]; observedAt: string }
export interface ContextPack { query: string; budgetTokens: number; usedTokens: number; items: { id: string; title: string; source: string; author: string; ts: string; excerpt: string; score: number }[]; omitted: number; rawTokens: number; compressionRatio: number }

const MAX_TEXT = 20_000;
export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);
const STOP = new Set('the a an and or of to in on for is are be with as at by it this that from we our you your'.split(' '));
const terms = (s: string): string[] => (s.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []).filter((t) => !STOP.has(t));

function scopeVisible(entry: ContextScope, req: ContextScope): boolean {
  if (entry.owner.startsWith('client:') || req.owner.startsWith('client:')) {
    if (entry.owner !== req.owner) return false;
  } else if (entry.owner === 'personal' && req.owner !== 'personal') return false;
  if (entry.project && req.project && entry.project !== req.project) return false;
  if (entry.person && entry.person !== req.person) return false;
  return true;
}

export function addContext(team: string, actor: TeamActor, input: { title: string; text: string; source: string; scope: ContextScope; tags?: string[]; importance?: number; supersedes?: string[]; observedAt?: string }): { id: string; tokens: number } {
  if (!validOwnerScope(input.scope?.owner)) throw new Error('scope.owner must be personal, company or client:<name>.');
  if (!input.title?.trim() || !input.text?.trim() || !input.source?.trim()) throw new Error('title, text and source (provenance) are required.');
  const text = input.text.slice(0, MAX_TEXT);
  const ev = appendEvent(team, actor, 'context.added', { title: input.title.slice(0, 200), text, source: input.source.slice(0, 500), scope: { owner: input.scope.owner, ...(input.scope.project ? { project: input.scope.project } : {}), ...(input.scope.person ? { person: input.scope.person } : {}) }, tags: (input.tags ?? []).slice(0, 16), importance: Math.min(Math.max(input.importance ?? 0.5, 0), 1), supersedes: (input.supersedes ?? []).slice(0, 20), ...(input.observedAt && !Number.isNaN(Date.parse(input.observedAt)) ? { observedAt: input.observedAt } : {}) });
  return { id: ev.id, tokens: estimateTokens(text) };
}

export function listContext(team: string): ContextEntry[] {
  return readEvents(team).filter((e) => e.type === 'context.added').map((e) => ({
    id: e.id, scope: e.payload.scope as ContextScope, title: String(e.payload.title), text: String(e.payload.text), source: String(e.payload.source), author: e.actor.id, ts: e.ts, tags: (e.payload.tags as string[]) ?? [],
    importance: typeof e.payload.importance === 'number' ? e.payload.importance : 0.5,
    supersedes: Array.isArray(e.payload.supersedes) ? e.payload.supersedes as string[] : [],
    observedAt: typeof e.payload.observedAt === 'string' ? e.payload.observedAt : e.ts,
  }));
}

export function compressText(text: string, query: string[], budgetTokens: number, seen: Set<string>): string {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const q = new Set(query);
  const scored = sentences.map((s, i) => {
    const key = s.toLowerCase().replace(/\s+/g, ' ');
    const hits = terms(s).filter((t) => q.has(t)).length;
    return { s, i, key, score: hits * 2 + (i === 0 ? 1 : 0) };
  }).filter((x) => { if (seen.has(x.key)) return false; seen.add(x.key); return true; });
  const picked: typeof scored = [];
  let used = 0;
  for (const x of [...scored].sort((a, b) => b.score - a.score || a.i - b.i)) {
    const t = estimateTokens(x.s) + 1;
    if (used + t > budgetTokens) continue;
    picked.push(x); used += t;
  }
  return picked.sort((a, b) => a.i - b.i).map((x) => x.s).join(' ');
}

export function retrieveContext(team: string, req: { query: string; scope: ContextScope; budgetTokens?: number; limit?: number; now?: number; halfLifeDays?: number }): ContextPack {
  if (!validOwnerScope(req.scope?.owner)) throw new Error('scope.owner must be personal, company or client:<name>.');
  const budget = Math.min(Math.max(req.budgetTokens ?? 1200, 100), 16_000);
  const q = terms(req.query);
  const all = listContext(team);
  const superseded = new Set(all.flatMap((e) => e.supersedes));
  const visible = all.filter((e) => !superseded.has(e.id) && scopeVisible(e.scope, req.scope));
  const now = req.now ?? Date.now();
  const halfLifeMs = (req.halfLifeDays ?? 14) * 86_400_000;
  const docs = visible.map((e) => ({ e, toks: terms(`${e.title} ${e.title} ${e.tags.join(' ')} ${e.text}`) }));
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d.toks)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length || 1;
  const ranked = docs.map((d) => {
    let score = 0;
    for (const t of q) { const tf = d.toks.filter((x) => x === t).length; if (tf) score += (1 + Math.log(tf)) * Math.log(1 + N / (df.get(t) ?? 1)); }
    const relevance = score / Math.sqrt(1 + d.toks.length / 200);
    // Evidence score = relevance × recency decay × importance (0.5 neutral).
    const age = Math.max(0, now - Date.parse(d.e.observedAt));
    const recency = Math.pow(0.5, age / halfLifeMs);
    const weight = (0.25 + 0.75 * recency) * (0.5 + d.e.importance);
    return { e: d.e, score: (q.length ? relevance : 1) * weight };
  }).filter((r) => r.score > 0 || q.length === 0).sort((a, b) => b.score - a.score || b.e.ts.localeCompare(a.e.ts));
  const limit = Math.min(req.limit ?? 8, 25);
  const seen = new Set<string>();
  const items: ContextPack['items'] = [];
  let used = 0; let raw = 0;
  for (const r of ranked.slice(0, limit)) {
    raw += estimateTokens(r.e.text);
    const remaining = budget - used - 30;
    if (remaining < 20) break;
    const share = Math.max(40, Math.floor(remaining / Math.max(1, Math.min(limit, ranked.length) - items.length)));
    const excerpt = compressText(r.e.text, q, Math.min(share, remaining), seen);
    if (!excerpt) continue;
    used += estimateTokens(excerpt) + 30;
    items.push({ id: r.e.id, title: r.e.title, source: r.e.source, author: r.e.author, ts: r.e.ts, excerpt, score: Math.round(r.score * 1000) / 1000 });
  }
  return { query: req.query, budgetTokens: budget, usedTokens: used, items, omitted: Math.max(0, ranked.length - items.length), rawTokens: raw, compressionRatio: raw ? Math.round((used / raw) * 100) / 100 : 1 };
}

/**
 * Task-scoped context compilation: constitution header (stable, cacheable
 * prefix) + evidence pack compiled for this task, rebuilt per task.
 */
export function compileTaskContext(team: string, task: { title: string; detail?: string; scope: ContextScope; budgetTokens?: number }, constitution: string): { prefix: string; pack: ContextPack; text: string; tokens: number } {
  const budget = task.budgetTokens ?? 2000;
  const alwaysAsk = constitution.match(/## Always ask[^\n]*\n([\s\S]*?)(?:\n## |$)/)?.[1]?.trim() ?? '';
  const version = constitution.match(/^version:\s*(\d+)/m)?.[1] ?? '?';
  const prefix = `Phantom constitution v${version} applies. Always ask before:\n${alwaysAsk}`;
  const pack = retrieveContext(team, { query: `${task.title} ${task.detail ?? ''}`, scope: task.scope, budgetTokens: Math.max(100, budget - estimateTokens(prefix)) });
  const body = pack.items.map((i) => `- ${i.title} [${i.source}, ${i.ts.slice(0, 10)}]: ${i.excerpt}`).join('\n');
  const text = `${prefix}\n\nTask: ${task.title}\n\nEvidence:\n${body || '(none)'}`;
  return { prefix, pack, text, tokens: estimateTokens(text) };
}
