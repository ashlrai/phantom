/**
 * Where each provider publishes model news, in one table, and a thin fetch that saves those
 * pages as `<folder>/<provider>.md` for `phm models radar` to read. A daily upkeep job runs
 * `phm models radar --fetch --json`. Uses the bounded public GET in radar/fetch.ts: no
 * credentials, no redirects. Tests never call the fetch.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchRadarSource } from '../radar/fetch.js';
import type { ModelRadarFetchResult } from './model-radar.js';

export interface ModelRadarSource {
  provider: string; url: string;
  /** True: the URL is already in radar/sources.json or cited as evidence in docs/model-registry.json. False: not yet fetched by us, so treat it as unknown until a run saves it. */
  checked: boolean;
}
export const MODEL_RADAR_SOURCES: readonly ModelRadarSource[] = [
  { provider: 'anthropic', url: 'https://docs.claude.com/en/release-notes/overview', checked: true },
  { provider: 'anthropic', url: 'https://platform.claude.com/docs/en/models/overview', checked: true },
  { provider: 'openai', url: 'https://developers.openai.com/api/docs/models', checked: true },
  { provider: 'openai', url: 'https://developers.openai.com/api/docs/changelog', checked: false },
  { provider: 'xai', url: 'https://docs.x.ai/docs/release-notes', checked: true },
  { provider: 'xai', url: 'https://docs.x.ai/developers/models', checked: true },
  { provider: 'google', url: 'https://ai.google.dev/gemini-api/docs/changelog', checked: false },
  { provider: 'zai', url: 'https://docs.z.ai/release-notes/new-released', checked: true },
  { provider: 'qwen', url: 'https://github.com/QwenLM/Qwen3/releases.atom', checked: true },
  { provider: 'devin', url: 'https://docs.devin.ai/release-notes/overview', checked: true },
];

/** Save every page that answers. A provider with no page saved keeps its old file, and the radar reports what it finds there. */
export async function fetchModelRadarDocs(folder: string, fetchPage: (url: string) => Promise<string> = url =>
  fetchRadarSource({ id: 'model-radar', product: 'Model release notes', url, kind: 'page', verified: true })): Promise<ModelRadarFetchResult[]> {
  await mkdir(folder, { recursive: true });
  const results: ModelRadarFetchResult[] = [], pages = new Map<string, string[]>();
  for (const { provider, url } of MODEL_RADAR_SOURCES) {
    const text = await fetchPage(url).catch(() => null);
    results.push({ provider, url, saved: text !== null });
    if (text !== null) pages.set(provider, [...pages.get(provider) ?? [], text]);
  }
  for (const [provider, texts] of pages) {
    const path = join(folder, `${provider}.md`), temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, texts.join('\n'), { mode: 0o600 });
    await rename(temporary, path);
  }
  return results;
}
