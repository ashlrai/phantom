/** Aggregate-only org metadata. Never project member identities, private usage or join records. */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { readTelemetryFile } from '../resources/telemetry.js';
import { joinsDir, orgFile, validateOrg, type Org } from './org.js';

type Source = 'available' | 'missing' | 'unavailable' | 'invalid';
export interface CompanyOrgView {
  schema: 'company.org.v1'; generatedAt: string;
  sources: { org: Source; joins: Source };
  members: number | null; contributingMembers: number | null; contributingLanes: number | null;
}
const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const recordSchema = z.object({
  v: z.literal(1), member: id, machine: id, joinedAt: z.string().datetime(),
  lanes: z.array(z.object({ lane: id, share: z.number().min(0).max(100) })).max(16),
});

export async function readCompanyOrg(options: { file?: string; dir?: string; now?: number } = {}): Promise<CompanyOrgView> {
  const now = options.now ?? Date.now();
  const view: CompanyOrgView = {
    schema: 'company.org.v1', generatedAt: new Date(now).toISOString(),
    sources: { org: 'unavailable', joins: 'unavailable' },
    members: null, contributingMembers: null, contributingLanes: null,
  };
  const text = await readTelemetryFile(options.file ?? orgFile());
  // Missing and unreadable org files both mean unknown membership, never an empty company.
  if (text === null) return view;
  let org: Org;
  try {
    if (Buffer.byteLength(text) > 256 * 1024) throw new Error('oversized');
    org = validateOrg(parse(text));
  } catch { view.sources.org = 'invalid'; return view; }
  view.sources.org = 'available';
  view.members = org.members.length;
  const dir = options.dir ?? joinsDir();
  let names: string[];
  try { names = (await readdir(dir)).filter(name => name.endsWith('.json')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return view;
    names = [];
    view.sources.joins = 'missing';
  }
  if (names.length > 2048) { view.sources.joins = 'invalid'; return view; }
  const members = new Set<string>(), lanes = new Set<string>();
  for (const name of names) {
    try {
      const raw = await readTelemetryFile(join(dir, name));
      if (raw === null) { view.sources.joins = 'unavailable'; return view; }
      const record = recordSchema.parse(JSON.parse(raw));
      if (new Set(record.lanes.map(lane => lane.lane)).size !== record.lanes.length) throw new Error('duplicate lane');
      const member = org.members.find(member => member.id === record.member);
      if (!member || !member.machines.some(machine => machine.id === record.machine) ||
        name !== `${record.member}.${record.machine}.json` || Date.parse(record.joinedAt) > now) continue;
      for (const contribution of record.lanes) {
        const declared = member.contributions.find(lane => lane.lane === contribution.lane);
        if (declared && contribution.share > 0 && contribution.share <= declared.share) {
          members.add(member.id); lanes.add(contribution.lane);
        }
      }
    } catch { view.sources.joins = 'invalid'; return view; }
  }
  if (view.sources.joins !== 'missing') view.sources.joins = 'available';
  view.contributingMembers = members.size;
  view.contributingLanes = lanes.size;
  return view;
}
