export interface DocsPage { slug: string; file: string; title: string; description: string; bytes: number }
export interface DocsSearchHit { slug: string; title: string; score: number; snippet: string }
export const DOCS_SITE_ORIGIN: string;
export const EXCLUDED_DOC_DIRS: readonly string[];
export const INDEX_START: string;
export const INDEX_END: string;
export function summarizeMarkdown(text: string, fallbackTitle: string): { title: string; description: string };
export function listDocsPages(docsDir: string): DocsPage[];
export function isSafeSlug(slug: unknown): slug is string;
export function docsPageUrl(slug: string): string;
export function readDocsPage(docsDir: string, slug: string): (DocsPage & { text: string }) | null;
export function searchDocsPages(docsDir: string, query: string, limit?: number): DocsSearchHit[];
export function llmsCovers(llmsText: string, slug: string): boolean;
export function uncoveredPages(llmsText: string, pages: DocsPage[]): DocsPage[];
export function renderLlmsTxt(llmsText: string, pages: DocsPage[]): string;
export function renderLlmsFull(docsDir: string, pages: DocsPage[], reference: string): string;
