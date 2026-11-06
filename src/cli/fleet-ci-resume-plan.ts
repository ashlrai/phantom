import { open } from 'node:fs/promises';
import {
  awaitCiReceipt, CI_RECEIPT_AWAIT_DEFAULT_POLL_MS, CI_RECEIPT_AWAIT_MAX_POLL_MS,
  CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS, CI_RECEIPT_AWAIT_MIN_POLL_MS,
} from '../core/fleet/ci-receipt-await.js';
import { artifactNameField, discoverCiReceiptPrior } from '../core/fleet/ci-receipt-discovery.js';
import { CiResumeInputsError, parseCiResumeManifest, planCiResumeInputs } from '../core/fleet/ci-resume-inputs.js';
import { fetchCiResumeReceipts } from '../core/fleet/ci-resume-receipts.js';
import { isAwaitMs } from '../core/fleet/needs-mason-answer-await.js';
import type { GitRunner } from '../core/verse/git-ops.js';

const USAGE = 'usage: ashlr fleet ci-resume-plan --repo owner/name --run ID --attempt N (--artifact-id ID [--archive file.zip] | --artifact-name NAME [--await-ms N [--poll-ms N]]) --manifest file.json --base HEX --head HEX [--json]';
const VALUE_FLAGS = ['--repo', '--run', '--attempt', '--artifact-id', '--artifact-name', '--await-ms', '--poll-ms', '--manifest', '--base', '--head', '--archive'];
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const REV = /^[0-9a-f]{4,64}$/i;
const MAX_BYTES = 1024 * 1024;
const id = (v: string | undefined): number | null =>
  v && /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null;
const boundedMs = (v: string | undefined, max: number): number | null =>
  v !== undefined && /^\d+$/.test(v) && isAwaitMs(Number(v), max) ? Number(v) : null;

/** Exactly one way to obtain the receipts: an explicit artifact id, or a named artifact discovered immediately or awaited for a bounded time. */
type Acquisition =
  | { mode: 'id'; artifactId: number; archive: string | undefined }
  | { mode: 'name'; artifactName: string; timeoutMs: number | null; pollMs: number };

/** Null on any mixed, missing, duplicated or out-of-bounds combination; checked before any remote work. */
function acquisition(values: Map<string, string>): Acquisition | null {
  const byId = values.has('--artifact-id');
  if (byId === values.has('--artifact-name')) return null;
  if (byId) {
    const artifactId = id(values.get('--artifact-id'));
    if (artifactId === null || values.has('--await-ms') || values.has('--poll-ms')) return null;
    return { mode: 'id', artifactId, archive: values.get('--archive') };
  }
  // --archive names a local file, which has no meaning while waiting on a remote artifact.
  const artifactName = artifactNameField(values.get('--artifact-name'));
  const timeoutMs = values.has('--await-ms') ? boundedMs(values.get('--await-ms'), CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS) : null;
  const pollMs = values.has('--poll-ms')
    ? boundedMs(values.get('--poll-ms'), CI_RECEIPT_AWAIT_MAX_POLL_MS) : CI_RECEIPT_AWAIT_DEFAULT_POLL_MS;
  if (artifactName === null || (values.has('--await-ms') && timeoutMs === null)
    || (values.has('--poll-ms') && timeoutMs === null) || pollMs === null || pollMs < CI_RECEIPT_AWAIT_MIN_POLL_MS
    || values.has('--archive')) return null;
  return { mode: 'name', artifactName, timeoutMs, pollMs };
}

export interface FleetCiResumePlanDeps {
  gh?: GitRunner;
  git?: GitRunner;
  cwd?: string;
  /** Monotonic milliseconds for the --artifact-name wait; production uses performance.now. */
  now?: () => number;
  /** Resolves after ms or as soon as the signal aborts; production uses a real timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Cancels the --artifact-name wait; the --artifact-id path performs no waiting. */
  signal?: AbortSignal;
}

/** Fetch bound evidence and produce an advisory plan; never acts on CI. */
export async function cmdFleetCiResumePlan(args: string[], deps: FleetCiResumePlanDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(`${USAGE}\nAdvisory only; this does not authorize CI reuse.`); return 0; }
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (!VALUE_FLAGS.includes(arg) || values.has(arg) || !args[i + 1] || args[i + 1]!.startsWith('-')) {
      process.stderr.write(`${USAGE}\n`); return 2;
    }
    values.set(arg, args[++i]!);
  }
  const repo = values.get('--repo') ?? ''; const run = id(values.get('--run')); const attempt = id(values.get('--attempt'));
  if (values.has('--artifact-name') && values.has('--archive') && !values.has('--artifact-id')) {
    process.stderr.write(`ci-resume-plan: --archive requires --artifact-id; it cannot be used with --artifact-name\n${USAGE}\n`); return 2;
  }
  const acquire = acquisition(values); const manifestFile = values.get('--manifest');
  const base = values.get('--base') ?? ''; const head = values.get('--head') ?? '';
  if (!REPO.test(repo) || repo.split('/')[0]!.endsWith('-') || repo.split('/')[0]!.includes('--')
    || repo.endsWith('/.') || repo.endsWith('/..') || run === null || attempt === null || acquire === null
    || !manifestFile || !REV.test(base) || !REV.test(head)) {
    process.stderr.write(`Invalid arguments. ${USAGE}\n`); return 2;
  }
  try {
    // Read at most one byte beyond the limit even if the file grows during the read.
    const file = await open(manifestFile, 'r').catch(() => { throw new CiResumeInputsError('manifest file cannot be read'); });
    let raw: Buffer;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_BYTES) throw new CiResumeInputsError('manifest file must be a regular file of at most 1 MiB');
      const buf = Buffer.alloc(MAX_BYTES + 1); let used = 0;
      while (used < buf.length) {
        const { bytesRead } = await file.read(buf, used, buf.length - used, null);
        if (!bytesRead) break;
        used += bytesRead;
      }
      if (used > MAX_BYTES) throw new CiResumeInputsError('manifest file exceeds 1 MiB');
      raw = buf.subarray(0, used);
    } finally { await file.close(); }
    let value: unknown;
    try { value = JSON.parse(raw.toString('utf8')); } catch { throw new CiResumeInputsError('manifest file cannot be read as JSON'); }
    const manifest = parseCiResumeManifest(value);
    if (manifest.repo.toLowerCase() !== repo.toLowerCase()) throw new CiResumeInputsError('manifest repo does not match the requested repository');
    // Both acquisition modes return the same validated, bound prior; only how the artifact is found differs.
    const { prior, diagnostics } = acquire.mode === 'id'
      ? await fetchCiResumeReceipts({ repo, run, attempt, artifactId: acquire.artifactId, ...(acquire.archive !== undefined ? { archive: acquire.archive } : {}), gh: deps.gh })
      : acquire.timeoutMs === null
        ? await discoverCiReceiptPrior({ repo, run, attempt, artifactName: acquire.artifactName, gh: deps.gh })
        : await awaitCiReceipt({ repo, run, attempt, artifactName: acquire.artifactName, timeoutMs: acquire.timeoutMs, pollMs: acquire.pollMs, signal: deps.signal },
        { gh: deps.gh, now: deps.now, sleep: deps.sleep });
    if (prior.repo.toLowerCase() !== manifest.repo.toLowerCase()) throw new CiResumeInputsError('receipts repo does not match manifest');
    const plan = await planCiResumeInputs({ manifest: value, prior, base, head, cwd: deps.cwd ?? process.cwd(), git: deps.git });
    for (const line of diagnostics) process.stderr.write(`ci-resume-plan: ${line}\n`);
    if (json) console.log(JSON.stringify(plan));
    else {
      console.log(`Advisory plan for ${plan.repo}: ${plan.summary.reuse} reusable, ${plan.summary.rerun} to rerun`);
      for (const job of plan.jobs) console.log(`  ${job.job}: ${job.decision} - ${job.reasons.join(', ')}${job.changedCoveredPaths.length ? ` (${job.changedCoveredPaths.join(', ')})` : ''}`);
      for (const path of plan.unmappedChangedPaths) console.log(`  unmapped change: ${path}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof CiResumeInputsError) { process.stderr.write(`ci-resume-plan: ${error.message}\n`); return 1; }
    throw error;
  }
}
