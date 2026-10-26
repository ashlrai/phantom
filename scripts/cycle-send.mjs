#!/usr/bin/env node
/** Run only beneath `phantom exec --`; credentials are never serialized to disk. */
import { validateEvent } from './cycle-collect.mjs';
import { readFileSync, appendFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function sendSpool(spool, { key, request = globalThis.fetch } = {}) {
  // Telemetry must never block a pipeline when the vault has no project key.
  if (!key) return { sent: 0, unavailable: true };
  const lock = openSync(`${spool}.send.lock`, 'wx', 0o600);
  try {
    const events = readFileSync(spool, 'utf8').split('\n').filter(Boolean).map(line => validateEvent(JSON.parse(line)));
    let sent = new Set();
    try { sent = new Set(readFileSync(`${spool}.sent`, 'utf8').split('\n').filter(Boolean)); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read delivery receipts'); }
    if ([...sent].some(id => !/^[a-f\d]{32}$/.test(id))) throw new Error('Invalid delivery receipts');
    let count = 0;
    for (const event of events) {
      const id = event.properties?.$insert_id;
      if (event.event !== 'cycle_stage' || event.properties.schema !== 'cycle_stage.v1' || !/^[a-f\d]{32}$/.test(id)) throw new Error('Invalid spooled event');
      if (sent.has(id)) continue;
      let response;
      try {
        response = await request('https://us.i.posthog.com/capture/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: key, event: event.event, timestamp: event.timestamp, properties: { ...event.properties, distinct_id: event.distinct_id } }), signal: globalThis.AbortSignal.timeout(15_000), redirect: 'error' });
      } catch { throw new Error('Capture transport failed'); }
      if (!response.ok) throw new Error(`Capture status ${response.status}`);
      // A crash before this append is safe: the remote insert id is deterministic.
      appendFileSync(`${spool}.sent`, `${id}\n`, { mode: 0o600, flush: true });
      sent.add(id);
      count++;
    }
    return { sent: count, unavailable: false };
  } finally { closeSync(lock); unlinkSync(`${spool}.send.lock`); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--spool') throw new Error('Expected --spool file');
    console.log(JSON.stringify(await sendSpool(resolve(process.argv[3]), { key: process.env.POSTHOG_PROJECT_KEY })));
  } catch { console.error('cycle-send: delivery failed; spool retained'); process.exitCode = 1; }
}
