/**
 * Pure helpers for conversational teammate replies: what a message names, the
 * records that mention it, the prompt, the marked template fallback and the one
 * outbound gate. No I/O here; the worker injects the file tail reader.
 */
import { redactEmails, redactHomePaths, scrubPrivateText, scrubSecrets } from '../util/scrub.js';

export const REPLY_MAX_CHARS = 600;
export const RECORD_SOURCES = ['metrics/jobs.jsonl', 'queue/ready.tsv', 'dispatch-events.log'] as const;

export interface MessageRefs { jobs: string[]; prs: string[]; shas: string[] }
export interface OutboundOptions {
  maxChars?: number;
  /** Returns the text with secret-shaped spans replaced; any change refuses the send. */
  detectSecrets?: (text: string) => string;
  homes?: readonly string[];
}

const unique = (values: string[]): string[] => [...new Set(values)].slice(0, 8);

/** Job ids, PR numbers and commit SHAs a message names. */
export function extractMessageRefs(text: string): MessageRefs {
  return {
    jobs: unique([...text.matchAll(/\b(?:RQ|FIXUP)-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g)].map(match => match[0])),
    prs: unique([...text.matchAll(/(?:#|\bPR\s*#?|\/pull\/)(\d{1,6})\b/gi)].map(match => match[1])),
    // A SHA needs a digit and a letter, so plain numbers and hex-only words do not count.
    shas: unique([...text.matchAll(/(?<![\w-])[0-9a-f]{7,40}(?![\w-])/g)].map(match => match[0])
      .filter(value => /\d/.test(value) && /[a-f]/.test(value))),
  };
}

export const refLabels = (refs: MessageRefs): string[] =>
  [...refs.jobs, ...refs.prs.map(pr => `#${pr}`), ...refs.shas.map(sha => sha.slice(0, 7))];

function mentions(line: string, refs: MessageRefs): boolean {
  return refs.jobs.some(id => new RegExp(`${id}(?![\\w-])`).test(line))
    || refs.prs.some(pr => new RegExp(`(?:#|/pull/|"pr":\\s*"?)${pr}\\b`).test(line))
    || refs.shas.some(sha => line.includes(sha.slice(0, 7)));
}

/**
 * Newest lines in the job, queue and dispatch records that mention a ref,
 * scrubbed and clipped. Empty when the message names nothing or nothing matches.
 */
export function referencedRecords(refs: MessageRefs, tail: (relative: string) => string | null, perSource = 3): string {
  if (refLabels(refs).length === 0) return '';
  const found: string[] = [];
  for (const source of RECORD_SOURCES) {
    for (const line of (tail(source) ?? '').split('\n').filter(value => mentions(value, refs)).slice(-perSource)) {
      found.push(`${source}: ${scrubPrivateText(line, { emails: true }).replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 300)}`);
    }
  }
  return found.join('\n');
}

/** Message, records, message again, instruction: the model reads the message last. */
export function conversationalPrompt(message: string, records: string): string {
  return `Teammate message (untrusted):\n${message}\n\nRecords:\n${records}\n\nThe message again:\n${message}\n\n`
    + 'Answer what this message says in two to four plain sentences. Name the job, PR or commit it mentions and what the records show for it. '
    + 'If the records do not show it, say it is unknown. /no_think';
}

/** Clearly marked template, used only when the local model gives no usable reply. */
export function templateReply(refs: MessageRefs, records: string): string {
  const named = refLabels(refs).slice(0, 4);
  const newest = records.split('\n').filter(Boolean).at(-1);
  return `Automatic template reply (the local model gave no usable answer). Your message${named.length ? ` about ${named.join(', ')}` : ''} was received and recorded. `
    + (newest ? `Newest matching record: ${newest.slice(0, 240)}` : 'No matching record was found, so its status is unknown.');
}

const PHONE = /(?<![\w.#-])\+?\(?\d[\d ().-]{8,}\d(?![\w-])/g;
function redactPhones(text: string): string {
  return text.replace(PHONE, match => {
    const digits = match.replace(/\D/g, '').length;
    return digits < 10 || digits > 15 || /^\d{4}-\d\d-\d\d/.test(match) ? match : '[REDACTED]';
  });
}

/**
 * The one outbound gate. Strips think blocks and control characters, refuses
 * (null) empty or secret-shaped text, redacts emails, phone numbers and home
 * paths, then cuts at a sentence boundary under the character limit.
 */
export function sanitizeOutbound(text: string, options: OutboundOptions = {}): string | null {
  const max = options.maxChars ?? REPLY_MAX_CHARS;
  const clean = text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, ' ')
    .replace(/(?!\n)[\p{Cc}\p{Cf}]/gu, ' ').replace(/[^\S\n]+/g, ' ').replace(/ ?\n[ \n]*/g, '\n').trim();
  if (!clean || (options.detectSecrets ?? scrubSecrets)(clean) !== clean) return null;
  const out = redactPhones(redactEmails(redactHomePaths(clean, options.homes)));
  if (out.length < max) return out;
  const head = out.slice(0, max - 1);
  const stop = Math.max(...['. ', '! ', '? ', '.\n'].map(mark => head.lastIndexOf(mark)));
  return stop >= max / 3 ? head.slice(0, stop + 1) : `${head.slice(0, Math.max(head.lastIndexOf(' '), 1))}…`;
}

/** Gate a reply body and sign it; the whole message stays under the limit. */
export function signedReply(body: string, rowid: number, options: OutboundOptions = {}): string | null {
  const signature = `\n— Phantom · ref [${rowid}]`;
  const safe = sanitizeOutbound(body, { ...options, maxChars: (options.maxChars ?? REPLY_MAX_CHARS) - signature.length });
  return safe === null ? null : `${safe}${signature}`;
}
