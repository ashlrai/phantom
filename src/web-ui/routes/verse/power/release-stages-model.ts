/** Pure view model for the update panel's release stages; no React. */
export interface ReleaseStagesView {
  tag: string | null;
  stages: ReadonlyArray<{ stage: string; status: string; version: string | null; reason: string | null }>;
}
export interface ReleaseStageRow { label: string; state: 'ok' | 'missing' | 'unknown'; text: string }

const SHOWN_ASSETS = 4;

/** Reads the server response defensively; anything unexpected is "unknown". */
export function readReleaseStages(value: unknown): ReleaseStagesView | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (row.schema !== 'verse.release-stages.v1' || !Array.isArray(row.stages)) return null;
  const stages = row.stages.flatMap((s): ReleaseStagesView['stages'] => {
    if (!s || typeof s !== 'object') return [];
    const x = s as Record<string, unknown>;
    if (typeof x.stage !== 'string' || typeof x.status !== 'string') return [];
    return [{ stage: x.stage, status: x.status, version: typeof x.version === 'string' ? x.version : null, reason: typeof x.reason === 'string' ? x.reason : null }];
  });
  return { tag: typeof row.tag === 'string' && row.tag ? row.tag : null, stages };
}

const stageOf = (r: ReleaseStagesView, name: string) => r.stages.find(s => s.stage === name);

function missingAssets(reason: string | null): string[] | null {
  const m = /missing or invalid:\s*(.+)$/u.exec(reason ?? '');
  return m ? m[1]!.split(',').map(x => x.trim()).filter(Boolean) : null;
}

export function releaseStageRows(response: ReleaseStagesView, _installedVersion: string | null): ReleaseStageRow[] {
  const tag = response.tag;
  if (!tag) {
    return [{ label: 'Published', state: 'unknown', text: 'Newest release unknown' },
      { label: 'Update feed', state: 'unknown', text: 'Update feed unknown' },
      { label: 'Installer assets', state: 'unknown', text: 'Installer assets unknown' }];
  }
  const published = stageOf(response, 'published');
  const feed = stageOf(response, 'feed-ready');
  const rows: ReleaseStageRow[] = [{ label: 'Published', state: 'ok', text: `${tag} published` }];
  if (feed?.status === 'observed') rows.push({ label: 'Update feed', state: 'ok', text: `Feed serves ${tag}` });
  else rows.push({ label: 'Update feed', state: 'missing', text: `Feed does not serve ${tag} yet${feed?.reason ? ` (${feed.reason})` : ''}` });
  if (published?.status === 'observed') rows.push({ label: 'Installer assets', state: 'ok', text: 'All 7 assets present' });
  else {
    const missing = missingAssets(published?.reason ?? null);
    if (!missing) rows.push({ label: 'Installer assets', state: 'unknown', text: published?.reason ?? 'Installer assets unknown' });
    else {
      const more = missing.length - SHOWN_ASSETS;
      rows.push({ label: 'Installer assets', state: 'missing', text: `Missing: ${missing.slice(0, SHOWN_ASSETS).join(', ')}${more > 0 ? ` and ${more} more` : ''}` });
    }
  }
  return rows;
}

function core(version: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** The newest published tag is newer than what is installed and the update feed does not serve it. */
export function newerUninstallable(response: ReleaseStagesView, installedVersion: string | null): { tag: string } | null {
  if (!response.tag || !installedVersion) return null;
  const tag = core(response.tag), have = core(installedVersion);
  if (!tag || !have) return null;
  const at = tag.findIndex((n, i) => n !== have[i]);
  const newer = at >= 0 && tag[at]! > have[at]!;
  if (!newer || stageOf(response, 'feed-ready')?.status === 'observed') return null;
  return { tag: response.tag };
}
