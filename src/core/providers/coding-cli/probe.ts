/**
 * Availability and model probes. Availability is a binary plus a status or
 * version check. Model verification is a separate minimal exec: a name that
 * only appears in a CLI cache is not accepted.
 */

import { scrubAdapterEnv } from './env.js';
import {
  adapterById,
  grokOutputIsMetered,
  interpretLogin,
  interpretModelProbe,
  type CodingCliAdapter,
} from './adapters.js';
import type { CodingCliCatalog, TierCandidate } from './catalog.js';
import type { BillingClass } from '../../routing/billing-class.js';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CliRunner {
  run(bin: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<CliResult>;
}

export interface Availability {
  id: string;
  binaryPresent: boolean;
  loggedIn: 'in' | 'out' | 'unknown' | 'not-applicable';
  billing: BillingClass;
  /** True when grok (or a peer) reported API-key billing on the status probe. */
  meteredConfirmed: boolean;
  detail: string;
}

export interface ModelProbe {
  backend: string;
  candidate: string;
  accountStatus: 'accepted' | 'rejected';
  /** True when the runner was invoked. A cache hit must not set this. */
  execCalled: boolean;
}

function combined(result: CliResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

export async function probeAvailability(
  adapter: CodingCliAdapter,
  runner: CliRunner,
  env: NodeJS.ProcessEnv,
): Promise<Availability> {
  const scrubbed = scrubAdapterEnv(env);
  if (!adapter.bin || adapter.versionArgs.length === 0) {
    return {
      id: adapter.id,
      binaryPresent: false,
      loggedIn: 'not-applicable',
      billing: adapter.billing,
      meteredConfirmed: false,
      detail: adapter.id === 'devin' ? 'Devin has no local binary in this adapter.' : 'No binary is configured.',
    };
  }
  const version = await runner.run(adapter.bin, adapter.versionArgs, scrubbed);
  if (version.code !== 0 || version.stdout.trim() === '') {
    return {
      id: adapter.id,
      binaryPresent: false,
      loggedIn: 'unknown',
      billing: adapter.billing,
      meteredConfirmed: false,
      detail: 'version check failed',
    };
  }
  if (!adapter.statusArgs) {
    return {
      id: adapter.id,
      binaryPresent: true,
      loggedIn: 'unknown',
      billing: adapter.billing,
      meteredConfirmed: false,
      detail: 'binary present; login was not probed',
    };
  }
  const status = await runner.run(adapter.bin, adapter.statusArgs, scrubbed);
  const text = combined(status);
  const meteredConfirmed = adapter.id === 'grok' && grokOutputIsMetered(text);
  const billing: BillingClass = meteredConfirmed ? 'metered' : adapter.billing;
  return {
    id: adapter.id,
    binaryPresent: true,
    loggedIn: adapter.id === 'grok' ? (status.code === 0 ? 'in' : 'out') : interpretLogin(text, status.code),
    billing,
    meteredConfirmed,
    detail: meteredConfirmed ? 'status output reports XAI_API_KEY billing' : 'status probe finished',
  };
}

/**
 * Verify one catalog candidate with the adapter's minimal exec. Refuses to
 * treat a cache listing as acceptance even when the candidate string matches.
 */
export async function probeModel(
  catalog: CodingCliCatalog,
  candidate: TierCandidate,
  runner: CliRunner,
  env: NodeJS.ProcessEnv,
): Promise<ModelProbe> {
  const adapter = adapterById(catalog, candidate.backend);
  if (!adapter?.bin || !adapter.verifyArgs) {
    return { backend: candidate.backend, candidate: candidate.candidate, accountStatus: 'rejected', execCalled: false };
  }
  const result = await runner.run(adapter.bin, adapter.verifyArgs(candidate.candidate), scrubAdapterEnv(env));
  return {
    backend: candidate.backend,
    candidate: candidate.candidate,
    accountStatus: interpretModelProbe(combined(result), result.code),
    execCalled: true,
  };
}
