/**
 * components/format/locale-format.ts — `toLocaleString` without building a
 * formatter on every call.
 *
 * `date.toLocaleString(locale, options)` and `n.toLocaleString(locale,
 * options)` construct a fresh Intl formatter each time they are given
 * options: ~60 µs a call in Chromium against ~1.5 µs for `.format()` on a
 * kept formatter. A chart axis or a list of rows formats hundreds of values
 * per render, which is where a first visit to Mind or Command spent its time.
 * These keep one formatter per (locale, options) for the tab's life.
 *
 * Same text as the methods they replace, given options that name at least
 * one date or time field (what every caller passes); an invalid date reads
 * "Invalid Date", as `toLocaleString` does, instead of throwing.
 *
 * A kept date formatter holds the time zone it was made in, where
 * `toLocaleString` reads the current one on every call. The date cache is
 * dropped whenever the zone's offsets (January and July) change, so a
 * machine that changes time zone mid-session still sees its own wall clock.
 */

const dateFormats = new Map<string, Intl.DateTimeFormat>();
const JANUARY = new Date(2026, 0, 1);
const JULY = new Date(2026, 6, 1);
let zoneSignature = '';

/** Offsets that change when the default time zone does; cheap (no Intl). */
function checkZone(): void {
  const signature = `${JANUARY.getTimezoneOffset()},${JULY.getTimezoneOffset()}`;
  if (signature !== zoneSignature) {
    zoneSignature = signature;
    dateFormats.clear();
  }
}
const numberFormats = new Map<string, Intl.NumberFormat>();

function keyOf(locale: string | undefined, options: object): string {
  return `${locale ?? ''}|${JSON.stringify(options)}`;
}

/** One kept `Intl.DateTimeFormat` per locale and options. */
export function dateTimeFormat(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  checkZone();
  const key = keyOf(locale, options);
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, options);
    dateFormats.set(key, format);
  }
  return format;
}

/** `new Date(value).toLocaleString(locale, options)` (also stands for the Date/Time variants given matching fields). */
export function formatDateTime(value: Date | number, locale: string | undefined, options: Intl.DateTimeFormatOptions): string {
  const ms = typeof value === 'number' ? value : value.getTime();
  // Intl throws on an invalid time value; toLocaleString prints this.
  if (!Number.isFinite(ms) || Number.isNaN(new Date(ms).getTime())) return 'Invalid Date';
  return dateTimeFormat(locale, options).format(ms);
}

/** `n.toLocaleString(locale, options)`. */
export function formatNumber(n: number, locale: string | undefined, options: Intl.NumberFormatOptions = {}): string {
  const key = keyOf(locale, options);
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, format);
  }
  return format.format(n);
}
