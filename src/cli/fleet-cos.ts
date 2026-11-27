/**
 * `ashlr fleet cos` — reach the chief-of-staff intake handler through the
 * fleet verb convention. Top-level `phm cos` registration and desktop/Verse
 * custom-sink wiring still require edits outside this scope (docs/COS.md);
 * this makes the existing ask/status handler reachable now. The usage line
 * names the fleet spelling — `phm cos` is not a dispatched command.
 */
import { cmdCos } from './cos.js';

const usage = 'Usage: phm fleet cos ask "<text>" --channel <cli|desktop|telegram|email|mobile|page> --json; phm fleet cos status <id> --json';

export async function cmdFleetCos(args: string[]): Promise<number> {
  return cmdCos(args, usage);
}
