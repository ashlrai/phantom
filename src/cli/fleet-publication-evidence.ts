/** Read stable releases, drafts, prereleases and PRs merged after publication. */
import { isAbsolute } from 'node:path';
import { readReleases, releaseRepo, type ReadPublicationEvidenceOptions, type PublicationEvidenceV1 } from '../core/release/publication-evidence.js';
import { publicationEvidenceLine } from '../core/release/publication-evidence-shape.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm fleet publication-evidence [--repo <enrolled-name>] [--root <absolute-dir>] [--json]
Read-only GitHub publication evidence: stable releases, drafts, prereleases and PRs merged after publication.
Missing evidence stays unknown; merged-after-publication is timing, not proof of shipped contents.`;

/** Read-only; flags are validated before any read. */
export async function cmdFleetPublicationEvidence(args: string[], read: (opts: ReadPublicationEvidenceOptions) => Promise<PublicationEvidenceV1> = readReleases): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  const opts: ReadPublicationEvidenceOptions = {}; let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], value = args[i + 1];
    if (arg === '--json' && !json) json = true;
    else if ((arg === '--repo' || arg === '--root') && opts[arg.slice(2) as 'repo' | 'root'] === undefined && value && !value.startsWith('-')) {
      opts[arg.slice(2) as 'repo' | 'root'] = value; i++;
    } else { console.error(usage); return 2; }
  }
  if (opts.repo !== undefined && !releaseRepo(opts.repo)) { console.error('Unknown enrolled repository'); return 2; }
  if (opts.root !== undefined && (!isAbsolute(opts.root) || [...opts.root].some(char => char.charCodeAt(0) < 32))) { console.error('--root must be an absolute directory'); return 2; }
  let report: PublicationEvidenceV1;
  try { report = sanitizePublicJson(await read(opts)) as PublicationEvidenceV1; } catch { console.error('Publication evidence could not be read.'); return 1; }
  console.log(json ? JSON.stringify(report) : report.repos.map(publicationEvidenceLine).join('\n'));
  return 0;
}
