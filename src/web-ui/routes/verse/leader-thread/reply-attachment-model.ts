/**
 * Screenshots in the Leader pane's reply box, the pure half. An attached image travels as the same
 * `[screenshot: <path>]` line the older Leader composer writes (leader/composer-attachment.ts), so the thread
 * shows it as a thumbnail and every reader of the inbox sees one format. The draft is the only state: a
 * marker in it is an attachment, and taking the marker out detaches it.
 */
import { splitScreenshotMarkers } from './thread-screenshots.js';

/** The reply box's own `maxLength`; an attachment that would pass it is refused rather than cut. */
export const REPLY_BOX_MAX = 6000;

export interface DraftShot {
  /** The stored file name, `<16 hex>.<png|jpg|webp>`. */
  name: string;
  /** The whole marker as it stands in the draft. */
  raw: string;
}

export function shotMarker(path: string): string {
  return `[screenshot: ${path}]`;
}

/** The screenshots a draft carries, in order, each marker once. */
export function draftShots(draft: string): DraftShot[] {
  const seen = new Set<string>(), out: DraftShot[] = [];
  for (const part of splitScreenshotMarkers(draft)) {
    if (part.kind !== 'shot' || seen.has(part.raw)) continue;
    seen.add(part.raw);
    out.push({ name: part.name, raw: part.raw });
  }
  return out;
}

export type AddShotResult = { text: string; error?: undefined } | { error: string; text?: undefined };

/** The draft with the screenshot's line at its end; unchanged when it already carries that file. */
export function addShotLine(draft: string, path: string, max = REPLY_BOX_MAX): AddShotResult {
  const line = shotMarker(path);
  if (draft.includes(line)) return { text: draft };
  const next = draft.trim() === '' ? line : `${draft.replace(/\s+$/, '')}\n${line}`;
  if (next.length > max) return { error: `The message is too long to add the screenshot (limit ${max.toLocaleString('en-US')} characters).` };
  return { text: next };
}

/** The draft without that marker; a line the marker had to itself goes with it. */
export function removeShotLine(draft: string, raw: string): string {
  if (raw === '') return draft;
  return draft.split('\n').flatMap(line => {
    if (!line.includes(raw)) return [line];
    const rest = line.split(raw).join('');
    return rest.trim() === '' ? [] : [rest];
  }).join('\n');
}

/** True when a drag or paste carries files at all (an image or not), so the drop can be claimed. */
export function carriesFiles(data: Pick<DataTransfer, 'types'> | null | undefined): boolean {
  return Array.from(data?.types ?? []).includes('Files');
}
