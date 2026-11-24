/**
 * routes/verse/usage/provider-windows.ts — which provider-reported quota
 * windows the console may show, and the one fact it states when a provider
 * retired a window (Claude's lifted 5-hour limit).
 *
 * The rule lives in core so `phm usage limits` and the console filter the
 * same windows; this file keeps the console's import path.
 */
export { isClaudeProvider, visibleWindows, windowNote } from '../../../../core/usage/provider-windows.js';
