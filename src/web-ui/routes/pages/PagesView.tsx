/**
 * routes/pages/PagesView.tsx - published report pages (`phm pages publish`).
 *
 * `/pages` lists every stored page (GET /api/pages); `/pages/:slug` renders
 * one (GET /api/pages/:slug). Page bodies arrive as Markdown source and are
 * rendered through the shared MessageMarkdown component, which lazy-loads
 * marked + DOMPurify as its own chunk (3.10 first-paint budget) and shows
 * the body as plain text until the renderer lands - so raw HTML in a page
 * never reaches the DOM unsanitized on either path.
 */
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '../../data/hooks.js';
import { apiGet, readFailureReason } from '../../data/client.js';
import type { QueryDef } from '../../data/queries.js';
import { SkeletonLine } from '../../components/primitives/Skeleton.js';
import { MessageMarkdown } from '../verse/MessageMarkdown.js';
import styles from './PagesView.module.css';

// Query defs live here rather than data/queries.ts so the page API types
// stay inside this lazy route chunk and out of the eager first-paint bundle
// (precedent: routes/fleet-dashboard/ResourcePanel.tsx).

export interface PageSummaryEntry {
  slug: string;
  title: string;
  description?: string;
  publishedAt: string;
  bytes: number;
}

export interface PagesListResponse {
  schemaVersion: number;
  count: number;
  pages: PageSummaryEntry[];
}

/** A stored page body is Markdown source; the view sanitizes it via the
 * shared marked + DOMPurify renderer (routes/verse/MessageMarkdown.tsx). */
export interface PageDetail {
  schemaVersion: number;
  slug: string;
  title: string;
  description?: string;
  markdown: string;
  sourceFormat: 'markdown' | 'json';
  sourceName: string;
  publishedAt: string;
  bytes: number;
}

const pagesListQuery: QueryDef<PagesListResponse> = {
  key: 'pages',
  fetch: (signal) => apiGet<PagesListResponse>('/api/pages', signal),
};

function pageDetailQuery(slug: string): QueryDef<PageDetail> {
  return {
    key: `page-${slug}`,
    fetch: (signal) => apiGet<PageDetail>(`/api/pages/${encodeURIComponent(slug)}`, signal),
  };
}

function PageIndex() {
  const result = useQuery(pagesListQuery);
  const pages = result.data?.pages ?? [];

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <h1 className={styles.title}>Pages</h1>
        <span className={styles.count}>{pages.length} published</span>
      </header>

      {result.status === 'loading' ? (
        <SkeletonLine width="40%" />
      ) : result.status === 'error' ? (
        <p className={styles.notice}>Pages unavailable. {readFailureReason(result.error)}</p>
      ) : pages.length === 0 ? (
        <p className={styles.notice}>
          No pages published yet. Run <code>phm pages publish report.md</code> to render a report here.
        </p>
      ) : (
        <ul className={styles.list}>
          {pages.map((page) => (
            <li key={page.slug}>
              <Link className={styles.card} to={`/pages/${encodeURIComponent(page.slug)}`}>
                <span className={styles.cardTitle}>{page.title}</span>
                {page.description ? <span className={styles.cardDesc}>{page.description}</span> : null}
                <span className={styles.cardMeta}>
                  /pages/{page.slug} &middot; {new Date(page.publishedAt).toLocaleString()}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PageDetail({ slug }: { slug: string }) {
  const result = useQuery(pageDetailQuery(slug));
  const page = result.data;

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <h1 className={styles.title}>{page?.title ?? slug}</h1>
        <Link className={styles.backLink} to="/pages">All pages</Link>
      </header>

      {result.status === 'loading' ? (
        <>
          <SkeletonLine width="60%" />
          <SkeletonLine width="90%" />
          <SkeletonLine width="75%" />
        </>
      ) : result.status === 'error' || !page ? (
        <p className={styles.notice}>
          Page unavailable. {result.error ? readFailureReason(result.error) : 'It may have been removed.'}
        </p>
      ) : (
        <article className={styles.page}>
          {page.description ? <p className={styles.description}>{page.description}</p> : null}
          <p className={styles.meta}>
            Published {new Date(page.publishedAt).toLocaleString()} from {page.sourceName}
          </p>
          <MessageMarkdown text={page.markdown} streaming={false} />
        </article>
      )}
    </div>
  );
}

export function PagesView() {
  const { slug } = useParams<{ slug: string }>();
  return slug ? <PageDetail slug={slug} /> : <PageIndex />;
}
