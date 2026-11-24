# Report pages

`phm pages publish` turns a Markdown or JSON report into a page inside the local dashboard at `/pages/<slug>`, and `phm pages list` shows what is published. Pages live on the loopback dashboard only; nothing is uploaded or made public.

## What it does

Publishing reads one `.md` or `.json` file and stores a page record under `~/.ashlr/pages/<slug>.json`. The web console (`phm dashboard`, or `phm serve --open`) renders it at `/pages/<slug>`; the read-only JSON is also at `GET /api/pages` and `GET /api/pages/<slug>` behind the same read session as every other console API.

- Markdown files publish as-is. A leading `# heading` becomes the page title when `--title` is not given, and a `---` front-matter block may set `title`, `slug` and `description`.
- JSON files publish `{ title, slug, description, markdown|body }`. A result document without a body field is rendered as a fenced JSON block, so a chief-of-staff result file becomes a readable page unchanged.
- Slugs are lowercase `a-z0-9` and dashes. They come from `--slug`, the file's `slug:` front matter or JSON field, or the file name, in that order. Republishing a slug replaces the page.
- Sources are capped at 512 KiB. Page bodies are Markdown; the console sanitizes HTML during render.

## Copy-paste

```sh
# Publish a Markdown report
phm pages publish reports/weekly.md --json

# Publish with an explicit slug and title
phm pages publish out/review.json --slug q3-review --title "Q3 review" --json

# List what is published
phm pages list --json

# Open the dashboard; the page is at /pages/<slug>
phm dashboard
```

`publish --json` prints the record a caller needs to link the page:

```json
{
  "schemaVersion": 1,
  "published": true,
  "slug": "weekly",
  "title": "Weekly report",
  "route": "/pages/weekly",
  "apiPath": "/api/pages/weekly",
  "consolePath": "/next/#/pages/weekly",
  "file": "/home/me/.ashlr/pages/weekly.json",
  "publishedAt": "2026-11-04T10:00:00.000Z",
  "bytes": 1204
}
```

## Linking from briefs and COS results

A brief or chief-of-staff result can point at a page by its `route` (`/pages/<slug>`) or `consolePath` (`/next/#/pages/<slug>`) field. Both stay inside the loopback console; `apiPath` is the machine-readable form for agents.

## Errors

`publish` exits `2` for missing files, unsupported extensions, invalid JSON, unusable slugs, empty content and over-limit sources, and `1` for store write failures. With `--json` the failure is `{ "published": false, "error": { "code", "message" } }`.
