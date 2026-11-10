import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { projectSecrets, type SecretsReading } from './secrets-model.js';

const exec = promisify(execFile);
/** No reveal, environment extraction, stderr forwarding or raw-error logging. */
export async function readWorkbenchSecrets(
  run: () => Promise<string> = async () => (await exec('phantom', ['list', '--json'], {
    encoding: 'utf8', timeout: 8_000, maxBuffer: 1_048_576,
    windowsHide: true,
  })).stdout,
): Promise<SecretsReading> {
  try { return projectSecrets(JSON.parse(await run())); }
  catch { return { v: 1, state: 'unknown', secrets: [] }; }
}
