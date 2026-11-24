#!/usr/bin/env node
/* global Buffer, process, console */
// Content-hash reuse for the fast CI jobs.
//
// A prior green result is reused only when a receipt names this job and the
// exact input hash. A missing, malformed, or mismatched receipt is a miss:
// the caller runs the real check. This module never treats a miss as success.
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA = 'phantom-ci-green.v1';

export function hashParts(parts) {
  const hash = createHash('sha256');
  for (const part of parts) {
    const buf = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
    hash.update(String(buf.length));
    hash.update('\0');
    hash.update(buf);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function receiptFor(job, hash) {
  return `${JSON.stringify({ schema: SCHEMA, job, hash, result: 'success' })}\n`;
}

/** True only for a well-formed receipt of this job and this hash. */
export function proveReuse(text, job, hash) {
  if (typeof text !== 'string' || typeof job !== 'string' || !/^[0-9a-f]{64}$/.test(hash ?? '')) return false;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    && parsed.schema === SCHEMA && parsed.job === job && parsed.hash === hash && parsed.result === 'success'
    && Object.keys(parsed).length === 4;
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function announce(job, hash, receiptPath) {
  let reuse = false;
  if (job && hash && receiptPath) {
    try {
      reuse = proveReuse(readFileSync(receiptPath, 'utf8'), job, hash);
    } catch {
      reuse = false;
    }
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `reuse=${reuse ? 'true' : 'false'}\n`);
  console.log(reuse ? 'reuse' : 'miss');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const command = process.argv[2];
  const job = arg('--job');
  const hash = arg('--hash');
  const receipt = arg('--receipt');
  if (command === 'announce') {
    process.exitCode = announce(job, hash, receipt);
  } else if (command === 'verify') {
    let ok = false;
    try {
      ok = proveReuse(readFileSync(receipt ?? '', 'utf8'), job, hash);
    } catch {
      ok = false;
    }
    process.exitCode = ok ? 0 : 2;
  } else if (command === 'write') {
    if (!job || !/^[0-9a-f]{64}$/.test(hash ?? '') || !receipt) {
      console.error('refusing to write a green receipt without a job and a 64-hex hash');
      process.exitCode = 1;
    } else {
      mkdirSync(dirname(receipt), { recursive: true });
      writeFileSync(receipt, receiptFor(job, hash));
      process.exitCode = 0;
    }
  } else if (command === 'hash') {
    const parts = process.argv.slice(3).filter((value) => value !== '--');
    if (parts.length === 0) {
      console.error('hash needs at least one part');
      process.exitCode = 1;
    } else {
      const digest = hashParts(parts.map((value) => value.startsWith('@') ? readFileSync(value.slice(1)) : value));
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `hash=${digest}\n`);
      console.log(digest);
    }
  } else {
    console.error('usage: ci-green-reuse.mjs announce|verify|write|hash');
    process.exitCode = 2;
  }
}
