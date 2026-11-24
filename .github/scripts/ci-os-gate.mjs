#!/usr/bin/env node
/* global process, console */
// Aggregate one OS's jobs. Skipped (path gate) and success pass.
// Failure and cancellation fail. Anything else fails closed.
import { fileURLToPath } from 'node:url';

export function osGateDecision(needs) {
  if (!needs || typeof needs !== 'object' || Array.isArray(needs)) {
    return { ok: false, reason: 'OS gate needs are missing' };
  }
  const names = Object.keys(needs);
  if (names.length === 0) return { ok: false, reason: 'OS gate needs are empty' };
  for (const name of names) {
    const result = needs[name]?.result ?? 'missing';
    if (result === 'success' || result === 'skipped') continue;
    return { ok: false, reason: `${name} concluded ${result}` };
  }
  return { ok: true, reason: names.map((name) => `${name}=${needs[name].result}`).join(', ') };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let needs;
  try {
    needs = JSON.parse(process.env.GATE_NEEDS ?? '');
  } catch {
    needs = null;
  }
  const decision = osGateDecision(needs);
  if (!decision.ok) {
    console.error(decision.reason);
    process.exitCode = 1;
  } else {
    console.log(`OS gate passed: ${decision.reason}`);
  }
}
