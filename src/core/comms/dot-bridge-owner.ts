/** Resolves the Dot bridge owner from live evidence only: the one live advisory
 * claim on the Hub repo that names the `dot-handoff` surface. Landed history is
 * deliberately not read (no git log reader), and nothing is ever invented. */
import { readSurfaceOwner, type SurfaceOwnerReport } from '../fleet/surface-owner.js';

export async function resolveDotBridgeOwner(
  read: (surface: string) => Promise<SurfaceOwnerReport | null> = (s) => readSurfaceOwner(s, {}),
): Promise<string | null> {
  try {
    const report = await read('dot-handoff');
    if (!report || report.ownerSource !== 'advisory-claim' || report.owner === 'UNKNOWN') return null;
    return report.owner;
  } catch {
    return null;
  }
}
