#!/usr/bin/env node
import { spawn } from 'node:child_process';

const HELP = `Usage: node scripts/agent-artifact-pack.mjs --job ID --upstream ID [--upstream ID ...] [--byte-budget N] [--phm-bin PATH]

Read upstream fleet job notes and build a fair, cited context pack. IDs follow
fleet job rules; at most 20 distinct upstreams are accepted. The byte budget
defaults to 65536 and must be 1..65536. --phm-bin defaults to phm.
Output is JSON: {v, jobId, pack, bytes, report, acquisition}. Acquisition
contains one entry per upstream with its notes state, size and truncation, or
a sanitized failure code. Exit 1 means partial or failed acquisition/packing;
exit 2 means invalid arguments. Child stderr is never emitted. Each child has
a 3-second deadline and the entire operation has a 20-second deadline.
Example: node scripts/agent-artifact-pack.mjs --job NEXT --upstream FIRST --upstream SECOND --byte-budget 8192 --phm-bin phm
`;
const MAX_CHILD = 512 * 1024;
const MAX_SNAPSHOT = 1024 * 1024;
const CHILD_MS = 3000;
const TOTAL_MS = 20000;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/;

function argumentsFor(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return null;
  const values = { job: undefined, upstream: [], budget: 65536, bin: 'phm' };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--job', '--upstream', '--byte-budget', '--phm-bin'].includes(flag) ||
        (flag !== '--upstream' && seen.has(flag))) throw new Error();
    seen.add(flag);
    const value = args[++i];
    if (!value || value.startsWith('-') || value.includes('\0')) throw new Error();
    if (flag === '--job') values.job = value;
    if (flag === '--upstream') values.upstream.push(value);
    if (flag === '--phm-bin') values.bin = value;
    if (flag === '--byte-budget') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65536) throw new Error();
      values.budget = Number(value);
    }
  }
  if (!values.job || !idPattern.test(values.job) || /[\r\n]/.test(values.job) ||
      values.upstream.length < 1 || values.upstream.length > 20 ||
      new Set(values.upstream).size !== values.upstream.length ||
      values.upstream.some(id => !idPattern.test(id) || /[\r\n]/.test(id) || id === values.job)) throw new Error();
  return values;
}

let active;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true;
  active?.kill('SIGKILL');
});

function child(bin, args, input, deadline) {
  return new Promise(resolve => {
    if (interrupted) return resolve({ code: 'cancelled' });
    const remaining = deadline - Date.now();
    if (remaining <= 0) return resolve({ code: 'timeout' });
    let proc;
    try { proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { return resolve({ code: 'spawn_failed' }); }
    active = proc;
    let failure;
    let size = 0;
    const chunks = [];
    const stop = code => { failure ??= code; proc.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('timeout'), Math.min(CHILD_MS, remaining));
    proc.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_CHILD) stop('output_limit');
      else chunks.push(chunk);
    });
    // Drain stderr without retaining or echoing potentially sensitive content.
    proc.stderr.resume();
    proc.stdin.on('error', () => {});
    proc.on('error', () => { failure ??= 'spawn_failed'; });
    proc.on('close', (status, signal) => {
      clearTimeout(timer);
      if (active === proc) active = undefined;
      resolve({ code: interrupted ? 'cancelled' : failure ?? (signal ? 'child_signal' : undefined),
        status, text: Buffer.concat(chunks).toString('utf8') });
    });
    proc.stdin.end(input);
  });
}

function parse(text) {
  try { return JSON.parse(text); } catch { return null; }
}
function notesResult(jobId, result) {
  if (result.code) return { jobId, state: 'unknown', code: result.code };
  const data = parse(result.text);
  if (!data || data.v !== 1 || data.job !== jobId || data.kind !== 'notes' ||
      typeof data.state !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(data.state) ||
      !(data.bytes === null || (Number.isSafeInteger(data.bytes) && data.bytes >= 0)) ||
      typeof data.truncated !== 'boolean' || typeof data.text !== 'string') {
    return { jobId, state: 'unknown', code: 'invalid_response' };
  }
  const entry = { jobId, state: data.state, bytes: data.bytes, truncated: data.truncated };
  if (data.state !== 'ok') return { ...entry, code: ['missing', 'unreadable'].includes(data.state) ? data.state : 'unknown_state' };
  if (result.status !== 0) return { ...entry, code: 'child_exit' };
  if (!data.text.trim()) return { ...entry, code: 'empty_notes' };
  return { ...entry, text: data.text };
}

async function main(options) {
  const deadline = Date.now() + TOTAL_MS;
  const snapshot = { node: { jobId: options.job, upstreamJobIds: options.upstream }, tasks: [], outputs: [], byteBudget: options.budget };
  const acquisition = [];
  for (const jobId of options.upstream) {
    const result = await child(options.bin, ['fleet', 'job', jobId, '--notes', '--json'], undefined, deadline);
    const { text, ...entry } = notesResult(jobId, result);
    if (text !== undefined) {
      snapshot.outputs.push({ jobId, text });
      if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT) {
        snapshot.outputs.pop();
        entry.code = 'snapshot_limit';
      }
    }
    acquisition.push(entry);
  }
  if (interrupted) return { exit: 130, output: { v: 1, jobId: options.job, acquisition, error: 'cancelled' } };
  const result = await child(options.bin, ['knowledge', 'context-pack', '--stdin', '--json', '--report', '--fair-upstream'], JSON.stringify(snapshot), deadline);
  const data = parse(result.text);
  const valid = !result.code && result.status === 0 && data && data.v === 1 && data.jobId === options.job &&
    typeof data.pack === 'string' && Number.isSafeInteger(data.bytes) &&
    data.bytes === Buffer.byteLength(data.pack) && data.bytes <= options.budget &&
    data.report && typeof data.report === 'object' && !Array.isArray(data.report) &&
    Array.isArray(data.report.fairUpstreamMissingOutputJobIds);
  if (!valid) return { exit: interrupted ? 130 : 1, output: { v: 1, jobId: options.job, acquisition,
    error: result.code ?? (result.status !== 0 ? 'child_exit' : 'invalid_response') } };
  const partial = acquisition.some(entry => entry.code) || data.report.fairUpstreamMissingOutputJobIds.length > 0 || !data.pack;
  return { exit: partial ? 1 : 0, output: { v: 1, jobId: options.job, pack: data.pack, bytes: data.bytes, report: data.report, acquisition } };
}

let options;
try { options = argumentsFor(process.argv.slice(2)); }
catch { process.stderr.write('error: invalid arguments; use --help\n'); process.exitCode = 2; }
if (options === null) process.stdout.write(HELP);
else if (options) {
  const result = await main(options);
  process.stdout.write(`${JSON.stringify(result.output)}\n`);
  process.exitCode = result.exit;
}
