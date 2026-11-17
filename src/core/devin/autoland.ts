import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { killSwitchOn } from '../sandbox/policy.js';
import { scrubSecrets } from '../util/scrub.js';
import { ensurePrivateDirectory, readPrivateFileTailCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import type { DevinClient, DevinSelf } from './client.js';
import { defaultLandJobId, DEVIN_LAND_LEDGER_FILE, landDevinSession, type CommandRunner, type DevinLandRequest, type DevinLandResult } from './land.js';
import { devinHome } from './store.js';

export interface DevinAutolandRequest { apply: boolean; cap?: number }
type Api = Pick<DevinClient, 'getSelf' | 'listSessions' | 'listSessionAttachments' | 'terminateSession' | 'archiveSession'>;
export interface DevinAutolandDeps {
  api?: () => Promise<{ client: Api; orgId: string } | { error: string }>;
  getSelf?: () => Promise<DevinSelf>;
  land?: (request: DevinLandRequest) => Promise<DevinLandResult>;
  run?: CommandRunner;
  now?: () => Date;
  killActive?: () => boolean;
  home?: string;
  signal?: AbortSignal;
}
export interface DevinAutolandDecision {
  v: 1; kind: 'devin-autoland'; at: string; passId: string; mode: 'apply' | 'dry-run';
  sessionId?: string; decision: string; reason: string; job?: string; pr?: string; supersededPr?: string; repo?: string;
  commitCount?: number; bundleAttachmentId?: string; error?: string;
  autoMerge?: DevinLandResult['autoMerge'];
  counts?: Record<'not-ours' | 'already-archived' | 'not-finished', number>;
}
export interface DevinAutolandResult {
  v: 1; ok: boolean; mode: 'apply' | 'dry-run'; passId: string; decisions: DevinAutolandDecision[]; landed: number;
}
export function setDevinAutolandPaused(paused: boolean): void {
  const dir = devinHome();
  if (paused) { ensurePrivateDirectory(dir); writePrivateFileAtomic(join(dir, 'autoland.paused'), 'paused\n'); }
  else rmSync(join(dir, 'autoland.paused'), { force: true });
}
function rows(path: string): Record<string, unknown>[] {
  return (readPrivateFileTailCapped(path, 2 * 1024 * 1024)?.text ?? '').split('\n').flatMap(line => {
    try { const row: unknown = JSON.parse(line); return row && typeof row === 'object' && !Array.isArray(row) ? [row as Record<string, unknown>] : []; } catch { return []; }
  });
}
const runCommand: CommandRunner = (cmd, args, opts) => new Promise(resolve => {
  execFile(cmd, [...args], { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout, stderr }));
});
const errorMessage = (error: unknown): string => scrubSecrets(error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error.').replace(/\s+/g, ' ').trim().slice(0, 300);

export async function runDevinAutoland(request: DevinAutolandRequest, deps: DevinAutolandDeps = {}): Promise<DevinAutolandResult> {
  const result: DevinAutolandResult = { v: 1, ok: true, mode: request.apply ? 'apply' : 'dry-run', passId: randomUUID(), decisions: [], landed: 0 };
  const dir = devinHome();
  const now = deps.now ?? (() => new Date());
  const counts = { 'not-ours': 0, 'already-archived': 0, 'not-finished': 0 };
  const decide = (decision: string, reason: string, fields: Partial<DevinAutolandDecision> = {}) => {
    const row: DevinAutolandDecision = { v: 1, kind: 'devin-autoland', at: now().toISOString(), passId: result.passId, mode: result.mode, decision, reason, ...fields };
    result.decisions.push(row);
    if (request.apply) { ensurePrivateDirectory(dir); appendFileSync(join(dir, 'autoland.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 }); }
  };
  try {
    if ((deps.killActive ?? killSwitchOn)()) { decide('killed', 'The global KILL switch is active.'); return result; }
    if (existsSync(join(dir, 'autoland.paused'))) { decide('paused', 'Autoland is paused.'); return result; }
    const cap = request.cap ?? 3;
    if (!Number.isInteger(cap) || cap < 1 || cap > 10) throw new Error('Cap must be an integer from 1 to 10.');
    const api = await (deps.api ?? (async () => (await import('./service.js')).connectedClient()))();
    if ('error' in api) throw new Error('Devin is not connected.');
    const { client, orgId } = api;
    const self = await (deps.getSelf ?? (() => client.getSelf()))();
    const identity = self.identity;
    if (!identity || !(identity.principal === 'service_user' ? identity.serviceUserId : identity.userId)) {
      result.ok = false; decide('no-identity', 'The key has no usable principal identity.'); return result;
    }
    const journal = rows(join(dir, 'autoland.jsonl'));
    const landings = rows(join(dir, DEVIN_LAND_LEDGER_FILE));
    let attempts = 0;
    let after: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 5; page++) {
      deps.signal?.throwIfAborted();
      const sessions = await client.listSessions(orgId, { first: 100, ...(after ? { after } : {}) });
      for (const session of sessions.items) {
        deps.signal?.throwIfAborted();
        const sessionId = session.sessionId;
        if (seen.has(sessionId)) continue;
        seen.add(sessionId);
        const fields = { sessionId };
        if (!(identity.principal === 'service_user' ? session.serviceUserId === identity.serviceUserId : session.userId === identity.userId)) { counts['not-ours']++; continue; }
        const prior = landings.filter(row => row['sessionId'] === sessionId && typeof row['pr'] === 'string');
        if (session.isArchived && (session.status === 'exit' || !prior.length)) { counts['already-archived']++; continue; }
        if (!(session.status === 'exit' || session.status === 'suspended' || (session.status === 'running' && ['finished', 'waiting_for_user', 'waiting_for_approval'].includes(session.statusDetail ?? '')))) { counts['not-finished']++; continue; }
        try {
          const attachments = await client.listSessionAttachments(orgId, sessionId);
          const bundle = attachments.filter(a => a.source === 'devin' && a.name.endsWith('.bundle')).at(-1);
          if (!bundle || !attachments.some(a => a.source === 'devin' && a.name.endsWith('.pr.md'))) { decide('missing-attachments', 'A bundle and PR description are required.', fields); continue; }
          const detail = { ...fields, bundleAttachmentId: bundle.attachmentId };
          const history = journal.filter(row => row['sessionId'] === sessionId);
          const last = prior.at(-1);
          const recorded = [...history].reverse().find(row => row['decision'] === 'landed' && row['pr'] === last?.['pr']);
          const cleanup = async () => {
            deps.signal?.throwIfAborted();
            if (!request.apply) { decide('would-archive', 'Would terminate if needed, then archive the session.', detail); return; }
            try {
              if (session.status !== 'exit') await client.terminateSession(orgId, sessionId);
              await client.archiveSession(orgId, sessionId);
              decide('archived', 'The landed session was terminated and archived.', detail);
            } catch (error) { result.ok = false; decide('archive-failed', 'Session cleanup failed; the next pass will retry.', { ...detail, error: errorMessage(error) }); }
          };
          let settledCloseForNewBundle = false;
          const closeState = [...history].reverse().find(row => ['pending-supersede', 'superseded', 'supersede-gave-up'].includes(String(row['decision'])));
          if (closeState?.['decision'] === 'pending-supersede' || closeState?.['decision'] === 'supersede-gave-up') {
            const oldPr = String(closeState['supersededPr'] ?? '');
            const newPr = String(closeState['pr'] ?? '');
            const repo = String(closeState['repo'] ?? 'phantom');
            const pair = (row: Record<string, unknown>) => row['supersededPr'] === oldPr && row['pr'] === newPr;
            const failures = history.filter(row => row['decision'] === 'pending-supersede' && pair(row)).length;
            const lastFail = Date.parse(String([...history].reverse().find(row => row['decision'] === 'pending-supersede' && pair(row))?.['at']));
            if (closeState['decision'] === 'supersede-gave-up' || failures >= 5) {
              decide('supersede-gave-up', 'Five superseded-PR close failures; leaving the session unarchived for review.', { ...detail, pr: newPr, supersededPr: oldPr, repo });
              result.ok = false;
              continue;
            }
            if (failures && now().getTime() < lastFail + Math.min(15 * 60_000 * 2 ** (failures - 1), 86400_000)) {
              decide('supersede-backoff', 'Waiting before retrying the superseded-PR close.', { ...detail, pr: newPr, supersededPr: oldPr, repo });
              continue;
            }
            if (!request.apply) { decide('would-close-superseded', 'Would retry closing the superseded PR before archiving.', { ...detail, pr: newPr, supersededPr: oldPr, repo }); continue; }
            const closed = await (deps.run ?? runCommand)('gh', ['pr', 'close', oldPr, '--repo', `ashlrai/${repo}`, '--comment', `Superseded by ${newPr} (later bundle from Devin session ${sessionId}).`], { cwd: deps.home ?? homedir(), env: process.env, timeoutMs: 30_000 }).catch(error => ({ code: 1, stderr: errorMessage(error) }));
            if (closed.code === 0) {
              decide('superseded', 'The old PR was closed.', { ...detail, pr: newPr, supersededPr: oldPr, repo });
              if (!recorded?.['bundleAttachmentId'] || recorded['bundleAttachmentId'] === bundle.attachmentId) { await cleanup(); continue; }
              settledCloseForNewBundle = true;
            } else {
              result.ok = false;
              decide('pending-supersede', 'The old PR could not be closed; the next pass will retry.', { ...detail, pr: newPr, supersededPr: oldPr, repo, error: errorMessage(closed.stderr || 'gh pr close failed.') });
              continue;
            }
          }
          if (last && !settledCloseForNewBundle && (!recorded?.['bundleAttachmentId'] || recorded['bundleAttachmentId'] === bundle.attachmentId)) { decide('already-landed', 'This bundle already has a landing.', detail); await cleanup(); continue; }
          let failures = 0;
          let lastFail = 0;
          for (const row of [...history].reverse()) {
            if (row['bundleAttachmentId'] !== bundle.attachmentId) continue;
            if (row['decision'] === 'landed') break;
            if (row['decision'] === 'gave-up') { failures = 5; break; }
            if (row['decision'] === 'land-failed') { failures++; lastFail ||= Date.parse(String(row['at'])); }
          }
          if (failures >= 5) { decide('gave-up', 'Five landing failures; waiting for a new bundle.', detail); continue; }
          if (failures && now().getTime() < lastFail + Math.min(15 * 60_000 * 2 ** (failures - 1), 86400_000)) { decide('backoff', 'Waiting before retrying the failed bundle.', detail); continue; }
          if (attempts >= cap) { decide('cap-reached', 'The pass has reached its landing attempt cap.', detail); continue; }
          attempts++;
          deps.signal?.throwIfAborted();
          const job = `${defaultLandJobId(sessionId)}${prior.length ? `-r${prior.length + 1}` : ''}${failures ? `-a${failures + 1}` : ''}`;
          let landed: DevinLandResult;
          try { landed = await (deps.land ?? (req => landDevinSession(req, { ...(deps.home ? { home: deps.home } : {}) })))({ sessionId, apply: request.apply, bundle: bundle.name, job }); }
          catch (error) { decide('land-failed', 'The landing failed.', { ...detail, error: errorMessage(error) }); result.ok = false; continue; }
          if (!landed.ok) { result.ok = false; decide('land-failed', 'The landing failed; inspect the landing separately.', { ...detail, error: errorMessage(landed.error) }); continue; }
          const pr = landed.publish?.pr ?? undefined;
          decide(request.apply ? 'landed' : 'would-land', request.apply ? 'The bundle was landed.' : 'The bundle can be landed.', { ...detail, job, ...(pr ? { pr } : {}), ...(landed.commitCount !== undefined ? { commitCount: landed.commitCount } : {}), ...(landed.autoMerge ? { autoMerge: landed.autoMerge } : {}) });
          if (request.apply) {
            result.landed++;
            deps.signal?.throwIfAborted();
            if (last && pr) {
              const closed = await (deps.run ?? runCommand)('gh', ['pr', 'close', String(last['pr']), '--repo', `ashlrai/${landed.repo ?? 'phantom'}`, '--comment', `Superseded by ${pr} (later bundle from Devin session ${sessionId}).`], { cwd: deps.home ?? homedir(), env: process.env, timeoutMs: 30_000 }).catch(error => ({ code: 1, stderr: errorMessage(error) }));
              if (closed.code === 0) decide('superseded', 'The old PR was closed.', { ...detail, pr, supersededPr: String(last['pr']), repo: landed.repo ?? 'phantom' });
              else {
                result.ok = false;
                decide('pending-supersede', 'The old PR could not be closed; the next pass will retry.', { ...detail, pr, supersededPr: String(last['pr']), repo: landed.repo ?? 'phantom', error: errorMessage(closed.stderr || 'gh pr close failed.') });
                continue;
              }
            }
          }
          await cleanup();
        } catch (error) { result.ok = false; decide('session-failed', 'The session could not be processed.', { ...fields, error: errorMessage(error) }); }
      }
      if (!sessions.hasNextPage || !sessions.endCursor || sessions.endCursor === after) break;
      after = sessions.endCursor;
    }
  } catch (error) {
    result.ok = false;
    try { decide('pass-failed', 'Autoland could not complete the pass.', { error: errorMessage(error) }); } catch { /* Persistence is unavailable. */ }
  }
  if (Object.values(counts).some(Boolean)) {
    try { decide('scanned', `Skipped ${counts['not-ours']} foreign, ${counts['already-archived']} archived and ${counts['not-finished']} unfinished sessions.`, { counts }); } catch { result.ok = false; }
  }
  return result;
}
