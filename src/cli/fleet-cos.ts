/**
 * `ashlr fleet cos` — reach the chief-of-staff intake handler through the
 * fleet verb convention. Top-level `phm cos` registration and desktop/Verse
 * custom-sink wiring still require edits outside this scope (docs/COS.md);
 * this makes the existing ask/status handler reachable now.
 */
import { cmdCos } from './cos.js';

export async function cmdFleetCos(args: string[]): Promise<number> {
  return cmdCos(args);
}
