import { appendFileSync, closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfigReadOnly } from '../config.js';
import type { AshlrConfig } from '../types/config.js';
import { localDayKey } from '../cloud/budget.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { untrustedText, type HostMergeDeps } from '../fleet/host-merge.js';
import { DevinApiError, type DevinPrReview } from './client.js';
import { connectedClient, devinEnabled, recordDevinApiOutcome } from './service.js';
import { devinHome } from './store.js';
import { DEVIN_KEYCHAIN_ACCOUNT, DEVIN_KEYCHAIN_SERVICE } from './secret.js';
import { readPublishedDevinWeekly } from './weekly-capacity.js';

export interface DevinPrRef { repo: string; number: number; prUrl: string }
export function parseDevinPrRef(input: string, defaultRepo: string | null): DevinPrRef | null {
  const full = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)$/.exec(input);
  const repo = full?.[1] ?? defaultRepo;
  const n = full?.[2] ?? /^#?(\d+)$/.exec(input)?.[1];
  const number = Number(n);
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !Number.isSafeInteger(number) || number < 1) return null;
  return { repo, number, prUrl: `https://github.com/${repo}/pull/${number}` };
}
export function planDevinPrReview(ref: DevinPrRef, orgId: string | null) {
  return { method: 'POST', url: `https://api.devin.ai/v3/organizations/${orgId ?? '<org-id>'}/pr-reviews`, body: { pr_url: ref.prUrl }, auth: { header: `Authorization: Bearer <keychain:${DEVIN_KEYCHAIN_SERVICE}/${DEVIN_KEYCHAIN_ACCOUNT}>` } };
}
export function devinPrReviewKey(repo: string, number: number, headSha: string): string {
  return `${repo.toLowerCase()}#${number}@${headSha.toLowerCase()}`;
}
export type DevinPrReviewReason = 'disabled' | 'invalid-pr' | 'duplicate' | 'daily-cap' | 'missing-auth' | 'unknown-plan' | 'quota-exhausted' | 'request-failed';
interface ReviewRow {
  v: 1; key: string; repo: string; number: number; headSha: string; at: string; day: string;
  origin: 'fleet' | 'cli'; outcome: 'requested' | 'triggered' | 'failed' | 'quota-exhausted'; reason?: string; status?: string;
}
export interface DevinPrReviewDeps {
  connectedClient?: typeof connectedClient;
  config?: () => AshlrConfig['devin'];
  now?: () => Date;
  journalPath?: string;
  weeklyCapacity?: (now: number) => { remaining: number | null } | null;
}
export type DevinPrReviewResult = { ok: true; outcome: 'triggered'; key: string; review: DevinPrReview } | { ok: false; reason: DevinPrReviewReason; key: string; detail: string };
function journalRows(path: string): ReviewRow[] {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  try {
    if (fstatSync(fd).size > 8 * 1024 * 1024) throw new Error('Review journal exceeds read limit.');
    return readFileSync(fd, 'utf8').split('\n').flatMap(line => {
      try { const r = JSON.parse(line) as ReviewRow; return r.v === 1 && typeof r.key === 'string' && typeof r.day === 'string' ? [r] : []; } catch { return []; }
    });
  } finally { closeSync(fd); }
}
function append(path: string, row: ReviewRow): void {
  const fd = openSync(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { fchmodSync(fd, 0o600); appendFileSync(fd, JSON.stringify(row) + '\n'); } finally { closeSync(fd); }
}
export async function triggerDevinPrReviewOnce(input: { repo: string; number: number; headSha: string; origin: 'fleet' | 'cli' }, deps: DevinPrReviewDeps = {}): Promise<DevinPrReviewResult> {
  const key = devinPrReviewKey(input.repo, input.number, input.headSha);
  const refuse = (reason: DevinPrReviewReason, detail: string = reason): DevinPrReviewResult => ({ ok: false, reason, key, detail });
  try {
    const config = (deps.config ?? (() => loadConfigReadOnly().devin))();
    if (!devinEnabled(config) || config?.review?.maxPerDay === 0) return refuse('disabled');
    const ref = parseDevinPrRef(String(input.number), input.repo);
    if (!ref || !/^[a-fA-F0-9]{40,64}$/.test(input.headSha)) return refuse('invalid-pr');
    const now = (deps.now ?? (() => new Date()))();
    const day = localDayKey(now);
    const path = deps.journalPath ?? join(devinHome(), 'pr-reviews.jsonl');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const lock = acquireLocalStoreLock(path + '.lock');
    if (!lock) return refuse('request-failed', 'journal-unavailable');
    const row = (outcome: ReviewRow['outcome'], extra: Partial<ReviewRow> = {}): ReviewRow => ({ v: 1, repo: input.repo, number: input.number, headSha: input.headSha, origin: input.origin, key, at: now.toISOString(), day, outcome, ...extra });
    let connection: Awaited<ReturnType<typeof connectedClient>>;
    try {
      const rows = journalRows(path);
      if (rows.some(r => r.day === day && r.outcome === 'quota-exhausted')) return refuse('quota-exhausted');
      if (rows.some(r => r.key === key && r.outcome === 'requested')) return refuse('duplicate');
      const cap = config?.review?.maxPerDay ?? 5;
      if (!Number.isSafeInteger(cap) || cap < 0 || rows.filter(r => r.day === day && r.outcome === 'requested').length >= cap) return refuse('daily-cap');
      const plan = (deps.weeklyCapacity ?? readPublishedDevinWeekly)(now.getTime());
      if (!plan || plan.remaining === null || !Number.isFinite(plan.remaining)) return refuse('unknown-plan');
      if (plan.remaining <= 0) return refuse('quota-exhausted');
      connection = await (deps.connectedClient ?? connectedClient)();
      if ('error' in connection) return refuse('missing-auth');
      append(path, row('requested'));
    } finally { releaseLocalStoreLock(lock); }
    try {
      if ('error' in connection) return refuse('missing-auth');
      const review = await connection.client.triggerPrReview(connection.orgId, ref.prUrl);
      recordDevinApiOutcome(null);
      append(path, row('triggered', { status: review.status }));
      return { ok: true, outcome: 'triggered', key, review };
    } catch (error) {
      recordDevinApiOutcome(error);
      const quota = error instanceof DevinApiError && (error.status === 402 || /quota|on[-_ ]?demand|out_of_credits|insufficient_credit|billing|usage limit/i.test(`${error.errorCode ?? ''} ${error.message}`));
      append(path, row(quota ? 'quota-exhausted' : 'failed'));
      return refuse(quota ? 'quota-exhausted' : 'request-failed', error instanceof DevinApiError ? error.code : 'unknown');
    }
  } catch { return refuse('request-failed', 'unavailable'); }
}
export interface DevinReviewFindings { count: number; items: Array<{ path: string | null; line: number | null; body: string }> }
export async function readDevinReviewFindings(repo: string, number: number, headSha: string, host: HostMergeDeps): Promise<DevinReviewFindings | null> {
  try {
    const { token } = await host.token(repo);
    const items: DevinReviewFindings['items'] = [];
    let count = 0;
    for (const kind of ['comments', 'reviews']) {
      const reply = await host.transport({ method: 'GET', path: `/repos/${repo}/pulls/${number}/${kind}?per_page=100`, token });
      if (reply.status !== 200 || !Array.isArray(reply.body)) return null;
      for (const raw of reply.body) {
        if (raw?.user?.login !== 'devin-ai-integration[bot]' || raw.commit_id !== headSha || typeof raw.body !== 'string' || !raw.body.trim()) continue;
        count++;
        if (items.length < 20) items.push({ path: typeof raw.path === 'string' ? untrustedText(raw.path, 300, true) : null, line: Number.isSafeInteger(raw.line) ? raw.line : null, body: untrustedText(raw.body, 300, true) });
      }
    }
    return { count, items };
  } catch { return null; }
}
export interface DevinReviewSignal { state: 'planned' | 'triggered' | 'refused'; reason?: DevinPrReviewReason; findings?: DevinReviewFindings | null }
export async function fleetDevinReview(input: { repo: string; number: number; headSha: string }, host: HostMergeDeps): Promise<DevinReviewSignal> {
  const result = await triggerDevinPrReviewOnce({ ...input, origin: 'fleet' });
  const triggered = result.ok || (result.reason === 'duplicate' && journalRows(join(devinHome(), 'pr-reviews.jsonl')).some(r => r.key === result.key && r.outcome === 'triggered'));
  if (triggered) return { state: 'triggered', findings: await readDevinReviewFindings(input.repo, input.number, input.headSha, host) };
  return { state: 'refused', reason: result.ok ? undefined : result.reason };
}
