#!/usr/bin/env node
/* global require, module */
/* eslint @typescript-eslint/no-require-imports: off -- This entry point is explicitly CommonJS (.cjs). */
'use strict';

// Local outbox only. Delivery belongs to a separate consumer run through
// Phantom Secrets (`phantom exec`); credentials never belong in spool records.
const fs = require('node:fs');
const process = require('node:process');
const { Buffer } = require('node:buffer');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

const STAGES = Object.freeze(['S1', 'S2', 'S3']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const FIELDS = new Set(['stage', 'cycleId', 'repo', 'pool', 'tier', 'outcome']);

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !FIELDS.has(key))) throw new Error('invalid event');
  if (!STAGES.includes(input.stage)) throw new Error('invalid stage');
  for (const field of ['cycleId', 'repo', 'pool', 'tier']) {
    if (typeof input[field] !== 'string' || !IDENTIFIER.test(input[field]) ||
        input[field].split('/').some(part => part === '..' || part === '.')) throw new Error('invalid identity');
  }
  if (input.outcome !== undefined &&
      (input.stage !== 'S3' || !['success', 'failure', 'cancelled'].includes(input.outcome))) throw new Error('invalid outcome');
  // Copy only defined protocol fields. Never serialize arbitrary task content,
  // environment, command lines, error messages, or credential-bearing options.
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function spoolDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('unsafe spool');
}

/** Atomically publish one immutable record; no network, subprocess or key access. */
function emitCycle(input, options = {}) {
  const event = validate(input);
  const directory = path.resolve(options.spoolDir ?? path.join(os.homedir(), '.phantom', 'router', 'spool'));
  spoolDirectory(directory);
  const id = randomUUID();
  const record = { schema: 'phantom.router.cycle/v1', id, at: new Date().toISOString(), ...event };
  const temporary = path.join(directory, `.${id}.tmp`);
  const destination = path.join(directory, `${id}.json`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // link is an atomic, no-replace publication on the same filesystem.
    fs.linkSync(temporary, destination);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
  return { id, path: destination };
}

/** Observational hooks never change the router's decision or result. */
function createCycleHooks(identity, options = {}) {
  const snapshot = { ...identity };
  const settings = { ...options };
  const emit = stage => (extra = {}) => {
    try {
      if (!extra || typeof extra !== 'object' || Array.isArray(extra) ||
          Object.keys(extra).some(key => key !== 'outcome')) throw new Error('invalid hook input');
      const result = emitCycle({ ...snapshot, ...extra, stage }, settings);
      return { ok: true, id: result.id };
    } catch {
      return { ok: false, reason: 'cycle-spool-failed' };
    }
  };
  return Object.freeze({ S1: emit('S1'), S2: emit('S2'), S3: emit('S3') });
}

function main() {
  // A single bounded JSON event on stdin avoids task content in process args.
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    data += chunk;
    if (Buffer.byteLength(data) > 4096) {
      process.stderr.write('cycle_emit: invalid event\n');
      process.exit(1);
    }
  });
  process.stdin.on('end', () => {
    try {
      emitCycle(JSON.parse(data));
    } catch {
      process.stderr.write('cycle_emit: unable to spool event\n');
      process.exitCode = 1;
    }
  });
  process.stdin.on('error', () => {
    process.stderr.write('cycle_emit: unable to read event\n');
    process.exitCode = 1;
  });
}

module.exports = { STAGES, emitCycle, createCycleHooks };
if (require.main === module) main();
