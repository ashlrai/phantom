/** Shared MASON-INBOX entry-start patterns; planner-brief.ts and the inbox-acks CLI must split entries identically. */

/**
 * Channel-tagged line that opens an independent entry. Fractional seconds are required:
 * appendInboxEntry writes `new Date().toISOString()` (e.g. `2026-11-02T23:51:29.123Z`), so a
 * pattern without `(?:\.\d+)?` glues every desktop entry onto the previous one.
 */
export const INBOX_CHANNEL_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\s+\[src:[a-z0-9._-]{1,32}(?:\s+id:[A-Za-z0-9._:-]{1,64})?\]\s+\S/;
/** The Markdown heading shape MASON-INBOX.md producers write; it opens an entry. */
export const INBOX_HEADING = /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} ET \(/;
