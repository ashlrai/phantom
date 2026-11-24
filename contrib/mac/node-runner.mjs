#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { accessSync, constants as F, statSync, lstatSync, realpathSync, mkdirSync, openSync, closeSync, fstatSync, readSync, writeSync, fsyncSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { connect } from 'node:net';
import { get } from 'node:http';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';
import { createHash } from 'node:crypto';

const PROTOCOL = 'phm-node-worker/v1';
const JOB_DIR = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/;
const READY_KEY = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/;
const LIMIT = 16 * 1024;
const home = homedir();
const root = join(home, '.ashlr-runs');
const fail = code => { throw new Error(code); };

export function deriveJobDirectoryId(key, attempt) {
  if (!READY_KEY.test(key) || !/^[0-9]{1,16}$/.test(attempt) || !Number.isSafeInteger(Number(attempt))) fail('invalid-request');
  const full = `${key}.${attempt}`;
  if (JOB_DIR.test(full)) return full;
  const hash = createHash('sha256').update(full).digest('hex').slice(0, 16);
  const suffix = `-${hash}.${attempt}`;
  const id = `${key.slice(0, 120 - suffix.length)}${suffix}`;
  if (!JOB_DIR.test(id)) fail('invalid-request');
  return id;
}

export function providerBinaryCandidates() {
  return [...new Set(['/opt/homebrew/bin', '/usr/local/bin',
    ...(isAbsolute(home) ? [join(home, '.local/bin'), join(home, '.npm-global/bin')] : []),
    dirname(process.execPath)].filter(isAbsolute).map(dir => join(dir, 'codex')))];
}

function resolveCodex() {
  return providerBinaryCandidates().find(path => {
    try { if (!statSync(path).isFile()) return false; accessSync(path, F.X_OK); return true; }
    catch { return false; }
  });
}

function privateDirectory(path) {
  try { lstatSync(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (realpathSync(parent) !== parent) fail('unsafe-directory');
    mkdirSync(path, { mode: 0o700 });
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || realpathSync(path) !== resolve(path) ||
      (stat.mode & 0o777) !== 0o700 || (process.getuid && stat.uid !== process.getuid())) fail('unsafe-directory');
  return path;
}

function writeResult(jobId, pack, result) {
  const results = privateDirectory(join(privateDirectory(root), 'node-results'));
  const body = JSON.stringify({ schemaVersion: 1, jobId, pack, completedAt: new Date().toISOString(), result }) + '\n';
  const fd = openSync(join(results, `${jobId}.json`), F.O_WRONLY | F.O_CREAT | F.O_EXCL | F.O_NOFOLLOW, 0o600);
  try {
    const bytes = Buffer.from(body);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  return `node-results:${jobId}`;
}

function readTask(key) {
  let fd;
  try {
    fd = openSync(join(root, 'node-tasks', `${key}.txt`), F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > LIMIT) fail('task-unavailable');
    const bytes = Buffer.alloc(LIMIT + 1);
    let size = 0;
    while (size < bytes.length) {
      const n = readSync(fd, bytes, size, bytes.length - size, null);
      if (!n) break;
      size += n;
    }
    const task = bytes.subarray(0, size).toString('utf8');
    if (size > LIMIT || !task.trim()) fail('task-unavailable');
    return task;
  } catch { fail('task-unavailable'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function codexFileArgv(scratch) {
  return ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', scratch, '-'];
}

function embeddedTask(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join() !== 'sha256,text' || typeof value.text !== 'string' ||
      !value.text.trim() || Buffer.byteLength(value.text) > LIMIT ||
      Buffer.from(value.text).toString('utf8') !== value.text ||
      createHash('sha256').update(value.text).digest('hex') !== value.sha256) fail('invalid-request');
  return value.text;
}

async function codexFile(jobId, taskKey, receipt, taskText) {
  const task = taskText ?? readTask(taskKey);
  const binary = resolveCodex();
  if (receipt !== undefined && receipt !== binary) fail('receipt-mismatch');
  if (!binary) fail('binary-unavailable');
  const scratch = join(root, 'node-work', jobId);
  let created = false;
  try {
    try {
      privateDirectory(root);
      privateDirectory(join(root, 'node-work'));
      mkdirSync(scratch, { mode: 0o700 });
      created = true;
      privateDirectory(scratch);
      if (readdirSync(scratch).length) fail('scratch-unavailable');
    } catch { fail('scratch-unavailable'); }
    let tail = Buffer.alloc(0);
    await new Promise((resolveRun, reject) => {
      let child;
      try {
        child = spawn(binary, codexFileArgv(scratch), { cwd: scratch, shell: false,
          env: { PATH: process.env.PATH, HOME: home }, stdio: ['pipe', 'pipe', 'ignore'] });
      } catch { reject(new Error('codex-spawn-failed')); return; }
      let timedOut = false;
      const kill = () => child.kill('SIGKILL');
      process.on('SIGTERM', kill);
      process.on('SIGINT', kill);
      const timer = setTimeout(() => { timedOut = true; kill(); }, 25 * 60_000);
      const cleanup = () => {
        clearTimeout(timer);
        process.off('SIGTERM', kill);
        process.off('SIGINT', kill);
      };
      child.stdout.on('data', chunk => {
        tail = Buffer.concat([tail, chunk]);
        if (tail.length > 48 * 1024) tail = tail.subarray(tail.length - 48 * 1024);
      });
      child.on('error', () => { cleanup(); reject(new Error('codex-spawn-failed')); });
      child.on('close', code => {
        cleanup();
        if (timedOut) reject(new Error('codex-timeout'));
        else if (code !== 0) reject(new Error('codex-exit-nonzero'));
        else resolveRun();
      });
      child.stdin.on('error', () => {});
      child.stdin.end(task);
    });
    try { return { resultRef: writeResult(jobId, 'codex-file', { codex: 'ok', output: tail.toString('utf8') }), codex: 'ok' }; }
    catch { fail('result-write-failed'); }
  } finally { if (created) rmSync(scratch, { recursive: true, force: true }); }
}

function ping() {
  return new Promise(resolvePing => {
    const socket = connect({ host: '127.0.0.1', port: 8000 });
    const timer = setTimeout(() => done(false), 1000);
    const done = ok => { clearTimeout(timer); socket.destroy(); resolvePing(ok); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function models() {
  return new Promise((resolveModels, reject) => {
    let size = 0;
    const chunks = [];
    const req = get('http://127.0.0.1:8000/v1/models', { agent: false }, res => {
      res.on('error', reject);
      res.on('data', chunk => {
        size += chunk.length;
        if (size > LIMIT) req.destroy(new Error('omlx-unavailable'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200 || size > LIMIT) fail('omlx-unavailable');
          JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolveModels();
        } catch { reject(new Error('omlx-unavailable')); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('omlx-unavailable')), 1500);
    req.on('error', reject);
    req.on('close', () => clearTimeout(timer));
  });
}

async function readRequest() {
  const chunks = [];
  let size = 0;
  const timer = setTimeout(() => process.stdin.destroy(new Error('invalid-request')), 5000);
  try {
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 128 * 1024) fail('invalid-request');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { fail('invalid-request'); }
  finally { clearTimeout(timer); }
}

async function main() {
  const [verb, ...args] = process.argv.slice(2);
  if (verb === 'packs' && !args.length) {
    const packs = ['shell-check'];
    if (resolveCodex()) packs.push('codex-file');
    if (await ping()) packs.push('omlx-ping');
    return { protocol: PROTOCOL, packs };
  }
  if (!['run', 'codex-file', 'shell-check', 'omlx-ping'].includes(verb) ||
      (verb === 'run' ? args.length !== 0 : args.length > 1)) { process.exitCode = 2; return; }
  let pack = verb;
  let id = args[0] ?? (verb === 'codex-file' ? '' : `${verb}-${Date.now()}`);
  let receipt;
  let taskText;
  if (verb === 'run') {
    const request = await readRequest();
    if (request?.protocol !== PROTOCOL || !request.job || typeof request.job.id !== 'string' ||
        !Array.isArray(request.job.secrets) || request.job.secrets.length ||
        !['codex-file', 'shell-check', 'omlx-ping'].includes(request.job.pack)) fail('invalid-request');
    pack = request.job.pack;
    id = request.job.id;
    receipt = request.providerBinaries?.codex;
    if (request.claim !== undefined && request.claim?.jobId !== id) fail('invalid-request');
    if (request.job.task !== undefined) {
      if (pack !== 'codex-file') fail('invalid-request');
      taskText = embeddedTask(request.job.task);
    }
    if (id.startsWith('ready:') && taskText === undefined) fail('invalid-request');
  }
  let taskKey = id;
  if (verb === 'run' && pack === 'codex-file' && id.startsWith('ready:')) {
    const match = /^ready:([^:]+):([0-9]+)$/.exec(id);
    if (!match || !READY_KEY.test(match[1])) fail('invalid-request');
    taskKey = match[1];
    id = deriveJobDirectoryId(taskKey, match[2]);
  }
  if (!JOB_DIR.test(id)) fail('invalid-request');
  if (receipt !== undefined && receipt !== resolveCodex()) fail('receipt-mismatch');
  if (pack === 'codex-file') return codexFile(id, taskKey, receipt, taskText);
  if (pack === 'omlx-ping') {
    try { await models(); } catch { fail('omlx-unavailable'); }
  }
  try { return { resultRef: writeResult(id, pack, { [pack]: 'ok' }) }; }
  catch { fail('result-write-failed'); }
}

const errors = new Set(['invalid-request', 'binary-unavailable', 'receipt-mismatch', 'scratch-unavailable',
  'task-unavailable', 'codex-spawn-failed', 'codex-timeout', 'codex-exit-nonzero', 'result-write-failed', 'omlx-unavailable']);
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) try {
  const reply = await main();
  if (reply) console.log(JSON.stringify(reply));
} catch (error) {
  console.log(JSON.stringify({ codex: 'error', packError: errors.has(error.message) ? error.message : 'invalid-request' }));
  process.exitCode = 1;
}
