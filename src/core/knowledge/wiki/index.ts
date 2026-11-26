/**
 * Private repo wiki + Ask (3.15). See generate.ts (build), status.ts
 * (freshness), ask.ts (Ask), model.ts (which engines may see the code),
 * jobs.ts (background builds for Verse).
 */

export { buildWiki, type BuildWikiOptions, type BuildWikiResult, type WikiBuildProgress } from './generate.js';
export { askWiki, type AskWikiOptions } from './ask.js';
export { wikiStatus, statusFromManifest, listWikiRepos, wikiCandidateRepos, type WikiRepoSummary } from './status.js';
export { readManifest, readPage, wikiKey, isWikiKey, isPageId, wikiRoot } from './store.js';
export { startWikiJob, wikiJob, scheduleWikiAutoRefresh, type WikiJob } from './jobs.js';
export { defaultWikiEngineResolver, wikiConfig, repoLocalOnlyReason, type WikiEngine, type WikiEngineResolver } from './model.js';
export { parseCitationHref, citationLabel } from './citations.js';
export type * from './types.js';
