/**
 * routes/verse/sections/about-diagnostics.ts — the one-block "what broke?"
 * report the About panel puts on the clipboard.
 *
 * Paste-ready for the inbox or an issue: versions, update position and skew
 * in plain text. The inputs are the only sources on purpose — no paths, no
 * hostnames, no tokens, nothing a paste would leak.
 */
import type { AboutUpdateLines } from './about-update-model.js';

export function aboutDiagnosticsText(input: {
  appName: string;
  desktopVersion: string | null;
  interfaceVersion: string;
  serverVersion: string | null;
  status: AboutUpdateLines;
  skew: { text: string } | null;
  nowIso: string;
}): string {
  const lines = [
    `${input.appName} diagnostics · ${input.nowIso}`,
    `Desktop: ${input.desktopVersion === null ? 'not a desktop build' : `v${input.desktopVersion}`}`,
    `Interface: v${input.interfaceVersion}`,
    `Server: ${input.serverVersion === null ? 'unknown' : `v${input.serverVersion}`}`,
    `Update: ${input.status.headline}`,
    ...input.status.rows.map((row) => `${row.label}: ${row.value}`),
  ];
  if (input.skew) lines.push(`Skew: ${input.skew.text}`);
  return lines.join('\n');
}
