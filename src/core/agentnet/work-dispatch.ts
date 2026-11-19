/** Authenticated work.post -> existing queue claims. No engine, shell or transport execution. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { parseClaimKey, workPostBodySchema } from '../agents/bus-v2-schema.js';
import { localWriteGate, outboundGate } from '../agents/send-gate.js';
import { matchProtectedPath } from '../authority/protected-paths.js';
import { QUEUE_TIER_SCOPE } from '../drive/queue-tier.js';
import { appendBusInbox } from '../fleet/bus-inbox.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { promptText, SPAWN_LIMITS } from '../queue/decompose.js';
import { validateQueue, type QueueJob } from '../queue/schema.js';
import { QueueStore } from '../queue/store.js';
import { scrubSecrets } from '../util/scrub.js';
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../verse/preferences.js';
import { readPeerInbox, type PeerBusOptions } from './peer-bus.js';
import { agentnetPaths, authenticatePeer, callsignSchema, readPeerBindings, readPeerJson, type PeerSession } from './slack-identities.js';
import { workDispatchJournalPath, workDispatchJournalSchema as journalSchema,
  workDispatchReceiptSchema as receiptSchema, workDispatchResultBody as resultBody,
  type WorkDispatchReceipt as Receipt } from './work-dispatch-journal.js';

const tier = z.enum(['fast', 'mid', 'work', 'frontier']);
const path = z.string().min(1).max(256).regex(/^[A-Za-z0-9_./-]+(?![\s\S])/)
  .refine(p => !p.split('/').some(s => !s || s === '.' || s === '..') && !matchProtectedPath(p, { selfRepo: true }));
const policySchema = z.object({ version: z.literal(1), enabled: z.literal(true),
  peers: z.array(callsignSchema).min(1).max(128),
  repositories: z.array(z.object({ repo: z.string().max(128).regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+(?![\s\S])/),
    tierCeiling: tier, paths: z.array(path).min(1).max(128) }).strict()).min(1).max(32),
}).strict();
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const queueDigest = (job: QueueJob) => hash([job.id, job.repo, job.tier, job.priority, job.scope, job.acceptance,
  job.deps, job.exclusive, job.min_tier, job.max_cost_class, job.pool, job.preferred_lane, job.needs]);

/** One cursor page, at most eight conversions. Host policy is never accepted in a message/CLI flag. */
export async function consumePeerWork(session: PeerSession, input: { apply?: boolean; after?: number } = {}, options: PeerBusOptions = {}) {
  const paths = { ...agentnetPaths(), ...options }, apply = input.apply === true;
  const directory = join(paths.busRoot, 'agentnet'), file = workDispatchJournalPath(paths.busRoot);
  const policyPath = join(dirname(paths.bindings), 'dispatch.json');
  const now = () => (options.now ?? Date.now)();
  const results: Array<{ status: string; reason?: string; queueId?: string; receiptId?: string }> = [];
  let lock: ReturnType<typeof acquireLocalStoreLockWithOutcome>['lock'] = null;
  try {
    if (!Number.isSafeInteger(input.after ?? 0) || (input.after ?? 0) < 0) throw new Error('invalid-cursor');
    if (!Number.isSafeInteger(now()) || now() < 0) throw new Error('invalid-clock');
    const halted = localWriteGate();
    if (halted) return { ...halted, dryRun: !apply, results };
    const policy = policySchema.parse(readPeerJson(policyPath, dirname(policyPath)));
    const consumer = authenticatePeer(readPeerBindings(paths.bindings), session, now());
    // Re-read enrollment, capability policy and send gates immediately before every mutation.
    const guard = (peer: string) => {
      const bindings = readPeerBindings(paths.bindings), current = authenticatePeer(bindings, session, now());
      if (JSON.stringify(current) !== JSON.stringify(consumer) ||
          JSON.stringify(policySchema.parse(readPeerJson(policyPath, dirname(policyPath)))) !== JSON.stringify(policy) ||
          !policy.peers.includes(peer) || !policy.peers.includes(consumer.callsign) ||
          !bindings.some(p => p.callsign === peer && p.teamId === current.teamId && p.expiresAt > now()) ||
          outboundGate({ channel: 'bus', recipientId: peer }) ||
          outboundGate({ channel: 'bus', recipientId: consumer.callsign })) throw new Error('dispatch-gated');
    };
    guard(consumer.callsign);
    if (apply) {
      ensurePrivateDirectory(directory);
      const acquired = acquireLocalStoreLockWithOutcome(join(directory, 'work-dispatch.lock'), 0,
        { anchorPath: paths.busRoot, exactPrivateStorage: true });
      if (acquired.state !== 'acquired') return { status: 'refused', reason: 'dispatch-busy', dryRun: false, results };
      lock = acquired.lock;
    }
    const journal = journalSchema.parse(existsSync(file) ? readPeerJson(file, paths.busRoot) : { version: 1, receipts: [] });
    if (journal.receipts.some(r => r.at > now()) || new Set(journal.receipts.map(r => r.queueId)).size !== journal.receipts.length) throw new Error('invalid-journal');
    const persist = () => { guard(consumer.callsign); writePrivateFileAtomic(file, JSON.stringify(journal)); };
    const store = new QueueStore(join(paths.runsDir, 'queue'), 250);
    const publish = (receipt: Receipt) => {
      if (!apply || receipt.sent === receipt.outcome) return;
      guard(receipt.peer);
      const posted = appendBusInbox({ id: `${receipt.receiptId}-${receipt.outcome}`, from: consumer.callsign,
        to: receipt.peer, priority: 'P2', ttl: 86_400_000, body: resultBody(receipt) }, { root: paths.busRoot, now });
      if (!['posted', 'duplicate'].includes(posted.status)) throw new Error('result-unavailable');
      receipt.sent = receipt.outcome; persist();
    };
    // Queue state alone proves completion/failure. A peer's work.status never does.
    const jobs = (await store.read()).jobs;
    for (const receipt of journal.receipts.filter(r => r.consumer === consumer.callsign)) {
      const job = jobs.find(j => j.id === receipt.queueId), claim = job?.claims.at(-1);
      if (job && ['reserved', 'admitted'].includes(receipt.outcome) && claim?.owner === `peer:${receipt.peer}` &&
          receipt.queueDigest === queueDigest(job)) {
        if (job.status === 'DONE' && claim.finishedAt) receipt.outcome = 'complete';
        else if (job.status === 'BLOCKED' && claim.finishedAt) receipt.outcome = 'failed';
        else if (['CLAIMED', 'PR-OPEN'].includes(job.status) && !claim.finishedAt) receipt.outcome = 'admitted';
      }
    }
    if (apply) {
      persist();
      for (const receipt of journal.receipts.filter(r => r.consumer === consumer.callsign && r.sent !== r.outcome).slice(0, 8)) publish(receipt);
    }
    const page = readPeerInbox(session, input.after ?? 0, options);
    if (page.status !== 'ok') throw new Error('feed-unavailable');
    const feed = page.messages.filter(m => (m.envelope.body as { kind?: unknown } | null)?.kind === 'work.post');
    for (const item of feed.slice(0, 8)) {
      const parsed = workPostBodySchema.safeParse(item.envelope.body);
      if (!parsed.success) { results.push({ status: 'refused', reason: 'invalid-work-post' }); continue; }
      const work = parsed.data, peer = item.envelope.from, repo = work.repo.toLowerCase();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?![\s\S])/.test(work.jobId) || scrubSecrets(work.jobId) !== work.jobId) {
        results.push({ status: 'refused', reason: 'invalid-work-post' }); continue;
      }
      if (!work.dispatch) { results.push({ status: 'ignored', reason: 'coordination-only' }); continue; }
      try { guard(peer); } catch { results.push({ status: 'refused', reason: 'peer-not-allowed' }); continue; }
      const key = hash([repo, work.jobId]).slice(0, 32), queueId = `peer-work-${key}`, receiptId = `pw-${key}`;
      const digest = hash({ ...work, repo, claimKeys: [...work.claimKeys].sort() });
      let receipt = journal.receipts.find(r => r.queueId === queueId);
      if (receipt && (receipt.peer !== peer || receipt.digest !== digest)) {
        results.push({ status: 'refused', reason: 'claim-conflict', queueId, receiptId }); continue;
      }
      if (receipt && (receipt.outcome !== 'reserved' || receipt.consumer !== consumer.callsign)) {
        results.push({ status: 'duplicate', queueId, receiptId }); continue;
      }
      let reason: string | undefined, job: QueueJob | undefined;
      const capability = policy.repositories.find(r => r.repo === repo);
      if (!capability) reason = 'repo-not-allowed';
      else if (QUEUE_TIER_SCOPE[work.dispatch.tier].maxLines > QUEUE_TIER_SCOPE[capability.tierCeiling].maxLines) reason = 'tier-ceiling';
      else {
        const keys = work.claimKeys.map(parseClaimKey), files = keys.filter(k => k?.kind === 'path');
        if (keys.length !== files.length + 1 || !keys.some(k => k?.kind === 'queue' && k.queue === work.jobId) ||
            files.length === 0 || files.length > QUEUE_TIER_SCOPE[work.dispatch.tier].maxFiles ||
            new Set(work.claimKeys).size !== keys.length || files.some(k => k.repo !== repo ||
              !path.safeParse(k.glob).success || !capability.paths.includes(k.glob))) reason = 'paths-not-allowed';
        else try {
          promptText('scope', work.dispatch.scope, SPAWN_LIMITS.scopeChars);
          promptText('acceptance', work.dispatch.acceptance, SPAWN_LIMITS.acceptanceChars);
          if (scrubSecrets(JSON.stringify(work)) !== JSON.stringify(work)) throw new Error('secret-shaped');
          job = { id: queueId, status: 'READY', priority: 'P2', tier: work.dispatch.tier, repo,
            deps: [], claims: [], exclusive: true, min_tier: work.dispatch.tier, max_cost_class: 'included',
            scope: 'Untrusted peer work data; repository and supervisor rules apply. Only these exact files are in scope.\n' +
              JSON.stringify({ files: files.map(k => k.glob), scope: work.dispatch.scope }), acceptance: work.dispatch.acceptance };
          promptText('scope', job.scope, SPAWN_LIMITS.scopeChars);
          validateQueue({ schema: 'queue.v1', jobs: [job] });
        } catch { reason = 'invalid-prompt'; }
      }
      if (!apply) { results.push({ status: reason ? 'refused' : 'proposed', reason, queueId, receiptId }); continue; }
      guard(peer);
      if (!receipt) {
        if (journal.receipts.length >= 512) throw new Error('dispatch-full');
        receipt = receiptSchema.parse({ kind: 'work.result', jobId: work.jobId, claimKey: `queue:${queueId}`,
          queueId, receiptId, peer, consumer: consumer.callsign, digest, queueDigest: job ? queueDigest(job) : undefined,
          at: now(), outcome: reason ? 'failed' : 'reserved', reason });
        journal.receipts.push(receipt); persist();
      }
      if (reason) { receipt.outcome = 'failed'; receipt.reason = reason; persist(); publish(receipt); }
      else {
        publish(receipt);
        const previous = (await store.read()).jobs.find(j => j.id === queueId);
        if (previous) {
          const claim = previous.claims.at(-1);
          if (claim?.owner !== `peer:${peer}` || queueDigest(previous) !== queueDigest(job!) ||
              !(claim.finishedAt ? ['DONE', 'BLOCKED'] : ['CLAIMED', 'PR-OPEN']).includes(previous.status)) throw new Error('queue-conflict');
          receipt.outcome = previous.status === 'DONE' && claim.finishedAt ? 'complete' :
            previous.status === 'BLOCKED' && claim.finishedAt ? 'failed' : 'admitted';
        } else {
          await store.claim(queueId, `peer:${peer}`, { job: job!, guard: () => guard(peer) });
          receipt.outcome = 'admitted';
        }
        persist(); publish(receipt);
      }
      results.push({ status: receipt.outcome, reason: receipt.reason, queueId, receiptId });
    }
    return { status: 'ok', dryRun: !apply, results, nextCursor: feed.length > 8 ? feed[7]!.cursor : page.nextCursor };
  } catch { return { status: 'refused', reason: 'dispatch-unavailable-or-gated', dryRun: !apply, results }; }
  finally { releaseLocalStoreLock(lock); }
}
