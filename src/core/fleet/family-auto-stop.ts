import { parseStopFile } from './stop-file.js';

export interface BriefFamily {
  family: string; pattern: string; guarded: boolean;
  launches: number; prs: number; merges: number; empty: number;
}
export interface FamilyAutoStop { family: string; pattern: string; until: number; why: string }

/** Pure proposals from the brief's window. Epoch seconds; twelve hours, never renewed while active. */
export function familyAutoStop(families: readonly BriefFamily[], now: number): FamilyAutoStop[] {
  return families.filter(f => !f.guarded && !/Q8|FIXUP-|GUARDIAN|RELEASE/i.test(f.family)
    && f.empty >= 3 && f.prs === 0 && f.merges === 0).map(f => ({
    family: f.family, pattern: f.pattern, until: Math.floor(now / 1000) + 12 * 3600,
    why: `auto_0of${f.launches}_merged_${f.empty}_empty_${f.family}`,
  }));
}

/** Active automatic rows in the existing family stop file, for the brief and CLI. */
export function activeFamilyStops(text: string, now: number) {
  return parseStopFile(text).flatMap(row => {
    const m = /^auto_(\d+)of(\d+)_merged_\d+_empty_(.+)$/.exec(row.reason);
    return row.until > now / 1000 && m ? [{ family: m[3]!, until: row.until, why: `${m[1]} of ${m[2]} merged`, auto: true }] : [];
  });
}
