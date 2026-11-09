#!/usr/bin/env node
/**
 * A sample agent call through the Phantom router gateway. No dependencies.
 *
 *   phm router serve                      # in another terminal
 *   node examples/router-gateway/agent.mjs "List three risks of a shared API key."
 *
 * Env: ROUTER_URL (default http://127.0.0.1:18741/v1), ROUTER_MODEL (default auto),
 * ROUTER_TOKEN_FILE (default ~/.ashlr/router/token). The token is read from the
 * file and sent only to the loopback URL; it is never printed.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const base = process.env.ROUTER_URL ?? 'http://127.0.0.1:18741/v1';
const model = process.env.ROUTER_MODEL ?? 'auto';
const tokenFile = process.env.ROUTER_TOKEN_FILE
  ?? join(process.env.ASHLR_HOME ?? join(homedir(), '.ashlr'), 'router', 'token');
const prompt = process.argv.slice(2).join(' ').trim();

if (!prompt) {
  console.error('Usage: node examples/router-gateway/agent.mjs "<prompt>"');
  process.exit(2);
}
const host = new URL(base).hostname;
if (host !== '127.0.0.1' && host !== '[::1]') {
  console.error('ROUTER_URL must be a loopback address; the token never leaves this machine.');
  process.exit(2);
}

const token = readFileSync(tokenFile, 'utf8').trim();
const response = await fetch(`${base}/chat/completions`, {
  method: 'POST',
  redirect: 'error',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model,
    messages: [
      { role: 'system', content: 'Answer briefly and plainly.' },
      { role: 'user', content: prompt },
    ],
  }),
});
const body = await response.json();
if (!response.ok) {
  console.error(`Router gateway ${response.status}: ${body?.error?.message ?? 'request failed'}`);
  process.exit(1);
}
console.log(body.choices[0].message.content);
console.error(`[${body.phantom.seatId} · ${body.phantom.model} · ${body.phantom.attempts.length} attempt(s)]`);
