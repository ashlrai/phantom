/**
 * Receipt-artifact binder for the RESUME-FROM-FAILURE order: given an explicit
 * repository, run, attempt and artifact id, read the run's identity, artifact
 * metadata and the attempt's actual jobs through `gh api`, fetch only that one
 * artifact's archive, and return the receipts.json inside it as a validated
 * CiResumePrior document for `fleet ci-resume-inputs --prior`.
 *
 * This is evidence ingestion, not authority: no checks, statuses or workflows
 * are touched, no git objects are read, and receipts' inputsDigest values are
 * preserved verbatim from the producer — never recomputed from today's tree.
 * Reuse is decided solely by the planner reproducing each digest at --base.
 */
import { lstat, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { defaultGitRunner, type GitRunner } from '../verse/git-ops.js';
import { parseCiResumePrior, type CiResumePrior } from './ci-resume-inputs.js';
import {
  artifactNameField,
  asRecord as record,
  CI_LIST_MAX_BYTES as LIST_MAX_BYTES,
  CI_META_MAX_BYTES as META_MAX_BYTES,
  CI_SHA40_RE as SHA40,
  CiResumeInputsError,
  failCiResume as fail,
  parseGhJsonOutput as jsonOut,
  parseSlurpedPages as slurpRows,
  runGhApi as api,
} from './ci-receipt-shared.js';

const DOWNLOAD_MAX_BYTES = 256 * 1024;
const ARCHIVE_MAX_BYTES = 16 * 1024 * 1024;
const RECEIPTS_MAX_BYTES = 1024 * 1024;
const MAX_ZIP_ENTRIES = 64;
const RECEIPTS_MEMBER = 'receipts.json';
const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LH_SIG = 0x04034b50;

interface RunMeta { headSha: string; latestAttempt: number }
function runMeta(value: unknown, repo: string, run: number, attempt: number): RunMeta {
  const m = record(value) ?? fail('run metadata is malformed');
  const repository = record(m['repository']);
  if (m['id'] !== run || typeof repository?.['full_name'] !== 'string'
    || repository['full_name'].toLowerCase() !== repo.toLowerCase()) {
    fail('run metadata does not match the requested repository or run');
  }
  if (typeof m['head_sha'] !== 'string' || !SHA40.test(m['head_sha'])
    || !Number.isSafeInteger(m['run_attempt']) || (m['run_attempt'] as number) < 1) {
    fail('run metadata is malformed');
  }
  if (m['status'] !== 'completed') fail(`run ${run} is not completed`);
  const latestAttempt = m['run_attempt'] as number;
  if (attempt > latestAttempt) fail(`attempt ${attempt} is not part of run ${run}`);
  return { headSha: m['head_sha'].toLowerCase(), latestAttempt };
}

function artifactMeta(value: unknown, run: number, artifactId: number): { name: string; size: number } {
  const a = record(value) ?? fail('artifact metadata is malformed');
  const workflowRun = record(a['workflow_run']);
  if (a['id'] !== artifactId || workflowRun?.['id'] !== run) fail('artifact does not belong to the requested run');
  if (a['expired'] !== false) fail('artifact is expired or has unknown expiry');
  if (!Number.isSafeInteger(a['size_in_bytes']) || (a['size_in_bytes'] as number) < 0
    || (a['size_in_bytes'] as number) > ARCHIVE_MAX_BYTES) fail('artifact size is out of bounds');
  const name = artifactNameField(a['name']);
  if (name === null) fail('artifact metadata is malformed');
  return { name, size: a['size_in_bytes'] as number };
}

function attemptJobs(rows: Record<string, unknown>[], run: number, attempt: number, headSha: string): Map<number, string | null> {
  const jobs = new Map<number, string | null>();
  for (const j of rows) {
    if (!Number.isSafeInteger(j['id']) || j['run_id'] !== run || typeof j['name'] !== 'string' || !j['name']
      || j['status'] !== 'completed'
      || (j['conclusion'] !== null && typeof j['conclusion'] !== 'string')
      || (j['run_attempt'] !== undefined && j['run_attempt'] !== attempt)
      || (typeof j['head_sha'] === 'string' && j['head_sha'].toLowerCase() !== headSha)) {
      fail('attempt jobs evidence is malformed or belongs to another run or attempt');
    }
    const id = j['id'] as number;
    if (jobs.has(id)) fail('attempt jobs evidence lists a job id twice');
    jobs.set(id, j['conclusion'] as string | null);
  }
  if (jobs.size === 0) fail(`attempt ${attempt} has no jobs evidence`);
  return jobs;
}

/** `gh run download --name` merges same-named artifacts; anything but a single match is ambiguous. */
function requireUniqueArtifactName(rows: Record<string, unknown>[], artifactId: number, name: string): void {
  const matches = rows.filter((a) => {
    if (!Number.isSafeInteger(a['id']) || typeof a['name'] !== 'string' || !a['name']) fail('run artifacts evidence is malformed');
    return a['name'] === name;
  });
  if (matches.length !== 1 || matches[0]!['id'] !== artifactId) fail('artifact name is ambiguous in this run; pass --archive');
}

/**
 * Bounded whole-file read: lstat refuses symlinks and non-files before open,
 * fstat re-verifies the opened inode, and the size cap applies before reading.
 */
async function readBoundedFile(path: string, maxBytes: number, label: string): Promise<Buffer> {
  let info;
  try { info = await lstat(path); } catch { fail(`${label} cannot be read`); }
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    fail(`${label} must be a regular file of at most ${maxBytes} bytes`);
  }
  const fh = await open(path, 'r').catch(() => fail(`${label} cannot be read`));
  try {
    const opened = await fh.stat();
    if (!opened.isFile() || opened.size > maxBytes) fail(`${label} must be a regular file of at most ${maxBytes} bytes`);
    return await fh.readFile();
  } finally { await fh.close(); }
}

/**
 * Read exactly one member of a ZIP held in memory — central directory walk and
 * a bounded node:zlib inflate; no member is ever written to a path, so an
 * absolute or parent-traversing entry name rejects the archive outright.
 */
function readZipMember(buf: Buffer, member: string, maxBytes: number): Buffer {
  const scanFrom = Math.max(0, buf.length - (22 + 0xffff));
  let eocd = -1;
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0 || eocd + 22 + buf.readUInt16LE(eocd + 20) !== buf.length) fail('archive is not a bounded zip');
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) fail('multi-disk archives are unsupported');
  const onDisk = buf.readUInt16LE(eocd + 8); const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12); const cdOff = buf.readUInt32LE(eocd + 16);
  if (onDisk === 0xffff || total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) fail('zip64 archives are unsupported');
  if (onDisk !== total || total > MAX_ZIP_ENTRIES || cdOff + cdSize > eocd) fail('archive central directory is out of bounds');
  let p = cdOff;
  const matches: { method: number; crc: number; csize: number; usize: number; lhoff: number }[] = [];
  for (let k = 0; k < total; k++) {
    if (p + 46 > cdOff + cdSize || buf.readUInt32LE(p) !== CD_SIG) fail('archive central directory is malformed');
    const flags = buf.readUInt16LE(p + 8); const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16); const csize = buf.readUInt32LE(p + 20); const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28); const elen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32);
    const lhoff = buf.readUInt32LE(p + 42);
    const end = p + 46 + nlen + elen + clen;
    if (nlen === 0 || end > cdOff + cdSize || (flags & 1) !== 0) fail('archive entry is unsafe or malformed');
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (name.includes('\0') || name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name)
      || name.split(/[\\/]/).some((s) => s === '..')) fail('archive entry path is unsafe');
    if (name === member) matches.push({ method, crc, csize, usize, lhoff });
    p = end;
  }
  if (p !== cdOff + cdSize) fail('archive central directory is malformed');
  if (matches.length === 0) fail(`archive has no ${member} member`);
  if (matches.length > 1) fail(`archive has duplicate ${member} members`);
  const e = matches[0]!;
  if (e.usize > maxBytes || e.csize > ARCHIVE_MAX_BYTES) fail(`${member} member is oversize`);
  if (e.lhoff + 30 > buf.length || buf.readUInt32LE(e.lhoff) !== LH_SIG) fail(`${member} member is malformed`);
  const start = e.lhoff + 30 + buf.readUInt16LE(e.lhoff + 26) + buf.readUInt16LE(e.lhoff + 28);
  if (start + e.csize > buf.length) fail(`${member} member is malformed`);
  const data = buf.subarray(start, start + e.csize);
  let out: Buffer;
  try {
    if (e.method === 0) { if (e.csize !== e.usize) fail(`${member} member is malformed`); out = Buffer.from(data); }
    else if (e.method === 8) out = inflateRawSync(data, { maxOutputLength: maxBytes });
    else fail(`${member} member uses an unsupported compression`);
  } catch (error) {
    if (error instanceof CiResumeInputsError) throw error;
    fail(`${member} member could not be inflated`);
  }
  if (out.length !== e.usize || (crc32(out) >>> 0) !== e.crc) fail(`${member} member failed integrity checks`);
  return out;
}

/** Cross-bind the producer's receipts to the fetched run, attempt and job evidence. */
function bindReceipts(prior: CiResumePrior, repo: string, run: number, attempt: number, meta: RunMeta,
  jobs: Map<number, string | null>): void {
  if (prior.repo.toLowerCase() !== repo.toLowerCase()) fail('receipts repo does not match the requested repository');
  if (prior.receipts.length === 0) fail('receipts.json contains no receipts');
  const seenJob = new Set<string>(); const seenId = new Set<number>();
  for (const r of prior.receipts) {
    if (r.run !== run) fail(`receipt for ${r.job} names run ${r.run}, not run ${run}`);
    if (r.attempt !== attempt) fail(`receipt for ${r.job} names attempt ${r.attempt}, not attempt ${attempt}`);
    if (r.headSha !== meta.headSha) fail(`receipt for ${r.job} does not match the run head sha`);
    if (r.jobId === null || !jobs.has(r.jobId)) fail(`receipt for ${r.job} names a job outside attempt ${attempt}`);
    if (jobs.get(r.jobId) !== r.conclusion) fail(`receipt for ${r.job} conclusion does not match the actual job`);
    if (seenJob.has(r.job) || seenId.has(r.jobId)) fail('receipts contain duplicates');
    seenJob.add(r.job); seenId.add(r.jobId);
  }
}

export interface CiResumeReceiptsFetch {
  /** The validated, normalized CiResumePrior document — printable as-is for --prior. */
  prior: CiResumePrior;
  /** Human-readable evidence lines for stderr; stdout stays the document only. */
  diagnostics: string[];
}

/**
 * Fetch one explicitly selected receipts artifact and bind it to live run
 * evidence. Throws CiResumeInputsError on any unavailable, ambiguous or
 * mismatched evidence; a failure never yields a prior document.
 */
export async function fetchCiResumeReceipts(opts: {
  repo: string; run: number; attempt: number; artifactId: number; archive?: string; gh?: GitRunner;
}): Promise<CiResumeReceiptsFetch> {
  const gh = opts.gh ?? defaultGitRunner;
  const diagnostics: string[] = [];
  const meta = runMeta(
    jsonOut(await api(gh, ['api', `repos/${opts.repo}/actions/runs/${opts.run}`], META_MAX_BYTES, 'run metadata'), 'run metadata'),
    opts.repo, opts.run, opts.attempt);
  const artifact = artifactMeta(
    jsonOut(await api(gh, ['api', `repos/${opts.repo}/actions/artifacts/${opts.artifactId}`], META_MAX_BYTES, 'artifact metadata'), 'artifact metadata'),
    opts.run, opts.artifactId);
  const jobs = attemptJobs(slurpRows(
    jsonOut(await api(gh, ['api', '--paginate', '--slurp',
      `repos/${opts.repo}/actions/runs/${opts.run}/attempts/${opts.attempt}/jobs?per_page=100`], LIST_MAX_BYTES, 'attempt jobs'), 'attempt jobs'),
    'jobs', 'attempt jobs'), opts.run, opts.attempt, meta.headSha);
  diagnostics.push(`run ${opts.run} attempt ${opts.attempt} head ${meta.headSha.slice(0, 12)}: ${jobs.size} jobs`);
  let raw: Buffer;
  if (opts.archive !== undefined) {
    raw = readZipMember(await readBoundedFile(opts.archive, ARCHIVE_MAX_BYTES, 'archive file'), RECEIPTS_MEMBER, RECEIPTS_MAX_BYTES);
    diagnostics.push(`archive ${opts.archive}: ${RECEIPTS_MEMBER} (${raw.length} bytes)`);
  } else {
    requireUniqueArtifactName(slurpRows(
      jsonOut(await api(gh, ['api', '--paginate', '--slurp',
        `repos/${opts.repo}/actions/runs/${opts.run}/artifacts?per_page=100`], LIST_MAX_BYTES, 'run artifacts'), 'run artifacts'),
      'artifacts', 'run artifacts'), opts.artifactId, artifact.name);
    const dir = await mkdtemp(join(tmpdir(), 'ci-resume-dl-'));
    try {
      await api(gh, ['run', 'download', String(opts.run), '--repo', opts.repo, '--name', artifact.name, '--dir', dir],
        DOWNLOAD_MAX_BYTES, 'artifact download');
      raw = await readBoundedFile(join(dir, RECEIPTS_MEMBER), RECEIPTS_MAX_BYTES, `downloaded ${RECEIPTS_MEMBER}`);
    } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
    diagnostics.push(`artifact ${opts.artifactId} "${artifact.name}" (${artifact.size} bytes): ${RECEIPTS_MEMBER} (${raw.length} bytes)`);
  }
  let value: unknown;
  try { value = JSON.parse(raw.toString('utf8')); } catch { fail(`${RECEIPTS_MEMBER} is not valid JSON`); }
  const prior = parseCiResumePrior(value);
  bindReceipts(prior, opts.repo, opts.run, opts.attempt, meta, jobs);
  diagnostics.push(`${prior.receipts.length} receipts bound to ${jobs.size} jobs; digests preserved from producer`);
  return { prior, diagnostics };
}
