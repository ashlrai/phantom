#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

const usage = `Usage: node scripts/agent-wait-handoff.mjs JOB_ID [--phm-bin PATH] [--deadline-ms MS] [--interval-ms MS]
Poll phm fleet job JOB_ID --json for published evidence, then read --notes --json once.
Defaults: phm, 300000 ms deadline, 1000 ms interval. Deadline: 1..600000 ms; interval: 100..60000 ms.
Output is a fleet.handoff.wait.v1 JSON object. Publication is not proof of merge.
At most 1000 detail commands and one notes command; each child stream is capped at 256 KiB.
Exit 0 only for published evidence with readable notes; exit 1 for incomplete results, 2 for invalid arguments.
Example: node scripts/agent-wait-handoff.mjs JOB1 --phm-bin /path/to/phm --deadline-ms 300000 --interval-ms 1000`;

function parse(args) {
  let job;
  const opts = { '--phm-bin': 'phm', '--deadline-ms': '300000', '--interval-ms': '1000' };
  const seen = new Set();
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      if (help) return null;
      help = true;
    } else if (Object.hasOwn(opts, arg)) {
      if (seen.has(arg) || !args[i + 1] || args[i + 1].startsWith('--')) return null;
      seen.add(arg);
      opts[arg] = args[++i];
    } else if (!job && /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(arg) && !/[\r\n]/.test(arg)) {
      job = arg;
    } else return null;
  }
  const number = (value, min, max) => /^[0-9]+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
  if ((!job && !help) || opts['--phm-bin'].includes('\0') || !number(opts['--deadline-ms'], 1, 600000) || !number(opts['--interval-ms'], 100, 60000)) return null;
  return { help, job, bin: opts['--phm-bin'], deadline: Number(opts['--deadline-ms']), interval: Number(opts['--interval-ms']) };
}

// Both streams are capped. Never return stderr or exception text: they may contain credentials.
function readChild(bin, args, remaining, signal) {
  return new Promise(resolve => {
    execFile(bin, args, { encoding: 'utf8', maxBuffer: 256 * 1024, timeout: Math.max(1, Math.ceil(remaining)), killSignal: 'SIGKILL', signal }, (error, stdout) => {
      let data = null;
      try { data = JSON.parse(stdout); } catch { /* invalid output is reported by code only */ }
      let code = null;
      if (error) {
        if (signal.aborted) code = 'cancelled';
        else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') code = 'output_limit';
        else if (error.killed) code = 'child_timeout';
        else if (error.code === 'ENOENT') code = 'executable_not_found';
        else code = 'child_failed';
      }
      resolve({ data, code });
    });
  });
}

async function main(options) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  const end = performance.now() + options.deadline;
  const result = { schema: 'fleet.handoff.wait.v1', job: options.job, status: 'deadline', detail: null, notes: null, error: null, commands: 0 };
  const validDetail = data => data && typeof data === 'object' && !Array.isArray(data) && data.schema === 'fleet.job.v1' && data.job === options.job && typeof data.state === 'string';
  const validNotes = data => data && typeof data === 'object' && !Array.isArray(data) && data.v === 1 && data.job === options.job && data.kind === 'notes' && typeof data.state === 'string';
  try {
    while (!controller.signal.aborted && performance.now() < end) {
      if (result.commands >= 1000) { result.status = 'command_limit'; break; }
      result.commands++;
      const detail = await readChild(options.bin, ['fleet', 'job', options.job, '--json'], end - performance.now(), controller.signal);
      if (validDetail(detail.data)) result.detail = detail.data;
      if (detail.code) result.error = { stage: 'detail', code: detail.code };
      else if (!validDetail(detail.data)) result.error = { stage: 'detail', code: 'invalid_response' };
      if (!detail.code && validDetail(detail.data) && detail.data.state === 'published' && performance.now() < end && !controller.signal.aborted) {
        result.commands++;
        const notes = await readChild(options.bin, ['fleet', 'job', options.job, '--notes', '--json'], end - performance.now(), controller.signal);
        if (validNotes(notes.data)) result.notes = notes.data;
        if (notes.code && !(notes.code === 'child_failed' && validNotes(notes.data) && ['missing', 'unreadable'].includes(notes.data.state))) {
          result.error = { stage: 'notes', code: notes.code };
          result.status = 'notes_error';
        } else if (!validNotes(notes.data)) {
          result.error = { stage: 'notes', code: 'invalid_response' };
          result.status = 'notes_error';
        } else if (notes.data.state === 'ok' && !notes.code) result.status = 'complete';
        else if (notes.data.state === 'missing') result.status = 'notes_missing';
        else if (notes.data.state === 'unreadable') result.status = 'notes_unreadable';
        else { result.error = { stage: 'notes', code: 'invalid_response' }; result.status = 'notes_error'; }
        break;
      }
      const remaining = end - performance.now();
      if (remaining > 0 && !controller.signal.aborted) {
        try { await sleep(Math.min(options.interval, remaining), undefined, { signal: controller.signal }); } catch { /* cancelled */ }
      }
    }
    if (controller.signal.aborted) result.status = 'cancelled';
    else if (performance.now() >= end && result.status !== 'complete' && result.status !== 'notes_missing' && result.status !== 'notes_unreadable') result.status = 'deadline';
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === 'complete' ? 0 : 1;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

const options = parse(process.argv.slice(2));
if (!options) { process.stderr.write(`error: invalid arguments\n${usage}\n`); process.exitCode = 2; }
else if (options.help) console.log(usage);
else process.exitCode = await main(options);
