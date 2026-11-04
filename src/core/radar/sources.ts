/** Public, unauthenticated Radar inputs. No request headers are configurable. */
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { z } from 'zod';

export const radarIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);

/** Metadata must remain printable when shown in a terminal or report. */
export function isRadarText(value: string): boolean {
  for (const char of value) if (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) return false;
  return true;
}

/** Queries are deliberately disallowed, including encoded credential parameters. */
export function isPublicRadarUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return isRadarText(value) && value === value.trim() && !/[\\\s]/u.test(value) && url.protocol === 'https:' &&
      !url.username && !url.password && !url.search && !url.hash && !value.includes('?') && !value.includes('#') &&
      (!url.port || url.port === '443') && !isIP(url.hostname.replace(/^\[|\]$/g, '')) &&
      /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(url.hostname) && url.hostname.includes('.') &&
      !/(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/i.test(url.hostname);
  } catch { return false; }
}

export const radarSourceSchema = z.object({
  id: radarIdSchema,
  product: z.string().trim().min(1).max(160).refine(isRadarText),
  url: z.string().refine(isPublicRadarUrl, 'Expected a public HTTPS URL without credentials, query or fragment'),
  kind: z.enum(['page', 'atom', 'npm', 'pypi', 'json']),
  verified: z.boolean(),
}).strict();
export type RadarSource = z.infer<typeof radarSourceSchema>;
export const radarSourcesSchema = z.array(radarSourceSchema).min(1).max(200).superRefine((sources, ctx) => {
  if (new Set(sources.map(source => source.id)).size !== sources.length) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate Radar source id' });
  }
});

/** Explicit paths support source checkouts without depending on the current directory. */
export async function loadRadarSources(path: URL | string = new URL('../../../radar/sources.json', import.meta.url)): Promise<RadarSource[]> {
  try {
    const raw = await readFile(path, 'utf8');
    if (Buffer.byteLength(raw) > 256 * 1024) throw new Error();
    return radarSourcesSchema.parse(JSON.parse(raw));
  } catch { throw new Error('Radar source catalogue unavailable or invalid'); }
}
