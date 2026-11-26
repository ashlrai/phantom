/**
 * Where each provider publishes model news, in one table, and a thin fetch that saves those
 * pages as `<folder>/<provider>.md` for offline radar. Live scans also receive each page
 * separately. Uses the bounded public GET in radar/fetch.ts: no credentials or redirects.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchRadarSource } from '../radar/fetch.js';
import type { ModelRadarDoc, ModelRadarFetchResult } from './model-radar.js';

export interface ModelRadarSource {
  provider: string; url: string;
  /** Whether the URL had existing repository evidence when added to the radar. */
  checked: boolean;
}
export const MODEL_RADAR_SOURCES: readonly ModelRadarSource[] = [
  { provider: 'anthropic', url: 'https://docs.claude.com/en/release-notes/overview', checked: true },
  { provider: 'anthropic', url: 'https://platform.claude.com/docs/en/models/overview', checked: true },
  { provider: 'openai', url: 'https://developers.openai.com/api/docs/models', checked: true },
  { provider: 'openai', url: 'https://developers.openai.com/api/docs/changelog', checked: false },
  { provider: 'xai', url: 'https://docs.x.ai/docs/release-notes', checked: true },
  { provider: 'xai', url: 'https://docs.x.ai/developers/models', checked: true },
  { provider: 'xai', url: 'https://docs.x.ai/developers/release-notes', checked: false },
  { provider: 'google', url: 'https://ai.google.dev/gemini-api/docs/changelog', checked: false },
  { provider: 'google', url: 'https://aistudio.google.com/docs/models', checked: false },
  { provider: 'google', url: 'https://aistudio.google.com/docs/latest-model', checked: false },
  { provider: 'google', url: 'https://antigravity.google/docs/models/', checked: false },
  { provider: 'google', url: 'https://antigravity.google/docs/cli/headless.md', checked: false },
  { provider: 'zai', url: 'https://docs.z.ai/release-notes/new-released', checked: true },
  { provider: 'zai', url: 'https://docs.z.ai/guides/overview/overview', checked: false },
  { provider: 'qwen', url: 'https://github.com/QwenLM/Qwen3/releases.atom', checked: true },
  { provider: 'devin', url: 'https://docs.devin.ai/release-notes/overview', checked: true },
  { provider: 'devin', url: 'https://docs.devin.ai/desktop/models', checked: false },
  { provider: 'devin', url: 'https://docs.devin.ai/cli/models', checked: false },
  { provider: 'devin', url: 'https://docs.devin.ai/cli/fusion', checked: false },
  { provider: 'cursor', url: 'https://cursor.com/docs/models-and-pricing', checked: false },
  { provider: 'cursor', url: 'https://cursor.com/docs/models/cursor-composer-2-5', checked: false },
  { provider: 'cursor', url: 'https://cursor.com/changelog', checked: false },
];

/** Save every page that answers. A provider with no page saved keeps its old file, and the radar reports what it finds there. */
export async function fetchModelRadarDocs(folder: string, fetchPage: (url: string) => Promise<string> = url =>
  fetchRadarSource({ id: 'model-radar', product: 'Model release notes', url, kind: 'page', verified: true }),
  onSaved?: (doc: ModelRadarDoc) => void,
  now = Date.now): Promise<ModelRadarFetchResult[]> {
  await mkdir(folder, { recursive: true });
  const results: ModelRadarFetchResult[] = [], pages = new Map<string, ModelRadarDoc[]>();
  for (const { provider, url } of MODEL_RADAR_SOURCES) {
    const text = await fetchPage(url).catch(() => null);
    results.push({ provider, url, saved: text !== null });
    if (text !== null) pages.set(provider, [...pages.get(provider) ?? [], {
      provider, text, source_url: url, retrieved_on: new Date(now()).toISOString().slice(0, 10),
    }]);
  }
  for (const [provider, docs] of pages) {
    const path = join(folder, `${provider}.md`), temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, docs.map(doc => doc.text).join('\n'), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
    docs.forEach(doc => onSaved?.(doc));
  }
  return results;
}
