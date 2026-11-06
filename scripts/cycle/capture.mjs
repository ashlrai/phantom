// Runs only under `phantom exec`; the project key is read here, never by collect.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateEvent } from './collect.mjs';
export { validateEvent } from './collect.mjs';


export async function capture(event, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  validateEvent(event);
  const key = env.POSTHOG_PROJECT_KEY;
  const receipt = { sent: false, insert_id: event.properties.$insert_id };
  // The caller already persisted the key-free event before starting this child.
  if (!key || key.startsWith('phm_')) return receipt;
  try {
    const response = await fetchImpl('https://us.i.posthog.com/capture/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: key, ...event }),
      signal: globalThis.AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    if (!response.ok) {
      console.error(`Cycle capture HTTP ${response.status}`);
      return receipt;
    }
    return { ...receipt, sent: true };
  } catch {
    // Never interpolate fetch errors: they may embed the key or request body.
    console.error('Cycle capture failed');
    return receipt;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const receipt = await capture(JSON.parse(readFileSync(0, 'utf8')));
    console.log(`CYCLE_RECEIPT ${JSON.stringify(receipt)}`);
  } catch {
    console.error('Invalid cycle capture input');
    process.exitCode = 1;
  }
}
