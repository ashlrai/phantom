#!/usr/bin/env python3
# grokbot_changelog_watch.py (RQ-GROKBOT-CHANGELOG-WATCH-1): one deterministic daily tick.
# No LLM turn, no credentials, no cookies, no login. Public GETs only.
#
# Reads the public Grok Bot changelog RSS feed (https://x.ai/changelog/bot/rss.xml,
# falling back to the changelog HTML page when the feed is unreachable) and the
# public docs pages under https://docs.x.ai/grok-bot (Mintlify .md variants),
# then files each NEW (url, heading) pair as a draft queue prompt under
# ~/.ashlr-runs/staged/changelog-ideas/. Drafts are staged for review; nothing is
# appended to queue/ready.tsv and no worker is started.
#
# Dedupe is by URL + heading: a key is sha256(url + "\n" + normalized heading).
# The first run against an empty state seeds the seen-set and files nothing, so
# the backlog is not flooded with the entire existing docs surface; later runs
# file only genuinely new changelog releases and new docs headings. A heading
# whose text changes under the same URL+heading is treated as already seen.
#
# Fetch failures are fail-closed per source: a source that cannot be read
# contributes no candidates and is reported; the run only exits nonzero when
# every configured source fails. Deferred candidates past --max stay unseen and
# are picked up by the next run.
#
# Repo copy for the Mac host; install next to the pinned bin/ scripts only after
# Security review and re-pin (see contrib/mac/README.md). Tests are hermetic:
# every URL is overridable by environment so fixtures never touch the network.
import os, sys, re, json, time, hashlib, html as htmlmod, urllib.request, urllib.error, urllib.parse
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

STATE_DIR = os.environ.get(
    "GROKBOT_WATCH_STATE_DIR",
    os.path.expanduser("~/.ashlr-runs/staged/changelog-ideas"))
SEEN_JSON = os.path.join(STATE_DIR, "seen.json")
INDEX_JSONL = os.path.join(STATE_DIR, "index.jsonl")
CHANGELOG_RSS = os.environ.get(
    "GROKBOT_WATCH_CHANGELOG_RSS", "https://x.ai/changelog/bot/rss.xml")
CHANGELOG_PAGE = os.environ.get(
    "GROKBOT_WATCH_CHANGELOG_PAGE", "https://x.ai/changelog/bot")
DOCS_INDEX = os.environ.get(
    "GROKBOT_WATCH_DOCS_INDEX", "https://docs.x.ai/grok-bot")
HTTP_TIMEOUT = 20
HTTP_LIMIT = 2_000_000
MAX_DOCS_PAGES = 80
UA = "ashlr-grokbot-changelog-watch/1.0 (+https://github.com/ashlrai/phantom)"

def log(msg):
    print("%s GROKBOT_WATCH %s" % (time.strftime("%F %T"), msg), flush=True)

def env_int(name, default):
    try:
        v = int(os.environ.get(name, ""))
        return v if v > 0 else default
    except ValueError:
        return default

MAX_IDEAS = env_int("GROKBOT_WATCH_MAX_IDEAS", 20)

WS = re.compile(r"\s+")
MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
MD_EMPH = re.compile(r"[*_`]+")
TAG = re.compile(r"<[^>]+>")
HTML_ENT = htmlmod.unescape

def norm(s):
    return WS.sub(" ", (s or "").strip())

def fetch(url, limit=HTTP_LIMIT):
    """Public GET only. Returns bytes or None on any failure (timeout, HTTP
    error, oversized body, non-http(s)/file scheme). Never sends credentials."""
    scheme = urllib.parse.urlparse(url).scheme
    if scheme not in ("http", "https", "file"):
        return None
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA,
                                                   "Accept": "*/*"})
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            data = r.read(limit + 1)
        return data if len(data) <= limit else None
    except Exception:
        return None

def key_for(url, heading):
    return hashlib.sha256((url + "\n" + norm(heading)).encode("utf-8")).hexdigest()

def job_id(key):
    return "RQ-GROKBOT-IDEA-" + key[:10]

def plain(text, cap=800):
    """Markdown/HTML -> flat text excerpt, whitespace-collapsed, capped."""
    t = TAG.sub(" ", text or "")
    t = MD_LINK.sub(lambda m: m.group(1), t)
    t = MD_EMPH.sub("", t)
    t = HTML_ENT(t)
    t = norm(t)
    return t[:cap]

# ---------- changelog ----------

def rss_candidates(data, page_url):
    """Parse an RSS 2.0 feed into candidate dicts. None on parse failure."""
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return None
    out = []
    for item in root.iter("item"):
        def txt(tag):
            el = item.find(tag)
            return norm(el.text) if el is not None and el.text else ""
        title = txt("title")
        link = txt("link") or page_url
        if not title:
            continue
        desc = ""
        for tag in ("description", "{http://purl.org/rss/1.0/modules/content/}encoded"):
            el = item.find(tag)
            if el is not None and el.text:
                desc = el.text
                break
        out.append({"kind": "changelog", "url": link, "heading": title,
                    "excerpt": plain(desc),
                    "meta": {"pubDate": txt("pubDate"),
                             "source": "rss"}})
    return out

class _HeadingParser(HTMLParser):
    """Collect h1-h3 headings with id attributes for the HTML fallback."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.headings = []
        self._tag = None
        self._id = None
        self._buf = []
    def handle_starttag(self, tag, attrs):
        if tag in ("h1", "h2", "h3"):
            self._tag = tag
            self._id = dict(attrs).get("id") or ""
            self._buf = []
    def handle_endtag(self, tag):
        if tag == self._tag and self._tag:
            text = norm("".join(self._buf))
            if text:
                self.headings.append({"level": int(tag[1]), "text": text,
                                      "id": self._id})
            self._tag = None
            self._buf = []
    def handle_data(self, data):
        if self._tag:
            self._buf.append(data)

def html_candidates(data, page_url):
    """Fallback: each h2/h3 on the changelog page is one release entry."""
    p = _HeadingParser()
    try:
        p.feed(data.decode("utf-8", "replace"))
    except Exception:
        return []
    out = []
    for h in p.headings:
        if h["level"] == 1:
            continue
        frag = ("#" + h["id"]) if h["id"] else ""
        out.append({"kind": "changelog", "url": page_url + frag,
                    "heading": h["text"], "excerpt": "",
                    "meta": {"source": "html"}})
    return out

def changelog_candidates():
    data = fetch(CHANGELOG_RSS)
    if data:
        items = rss_candidates(data, CHANGELOG_PAGE)
        if items is not None:
            log("changelog rss items=%d" % len(items))
            return items
        log("changelog rss unparseable, falling back to html")
    else:
        log("changelog rss fetch failed, falling back to html")
    data = fetch(CHANGELOG_PAGE)
    if not data:
        log("changelog html fetch failed")
        return None
    items = html_candidates(data, CHANGELOG_PAGE)
    log("changelog html entries=%d" % len(items))
    return items

# ---------- docs ----------

class _HrefParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hrefs = []
    def handle_starttag(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href") or ""
            if href:
                self.hrefs.append(href)

DOC_PAGE_TAIL = re.compile(r"[a-z0-9][a-z0-9-]*")
MD_HEAD = re.compile(r"^(#{1,4})\s+(.+?)\s*#*\s*$")
# Mintlify boilerplate headings that carry no feature signal.
BOILERPLATE_HEADS = {"related pages", "on this page", "previous", "next"}

def docs_page_urls(data, index_url):
    """Page URLs linked from the docs index. A link qualifies when its resolved
    URL stays on the index's host (for http(s)) and its path carries a
    /grok-bot/<slug> tail; anchors, queries, .md suffixes and nested paths are
    dropped. Order is document order, deduped, capped."""
    p = _HrefParser()
    try:
        p.feed(data.decode("utf-8", "replace"))
    except Exception:
        return []
    idx = urllib.parse.urlparse(index_url)
    seen, out = set(), []
    for href in p.hrefs:
        u = urllib.parse.urlparse(urllib.parse.urljoin(index_url, href))
        if u.scheme != idx.scheme:
            continue
        if idx.scheme in ("http", "https") and u.netloc != idx.netloc:
            continue
        i = u.path.find("/grok-bot/")
        if i < 0:
            continue
        tail = u.path[i + len("/grok-bot/"):].strip("/")
        if not DOC_PAGE_TAIL.fullmatch(tail):
            continue
        page = urllib.parse.urlunparse(
            (u.scheme, u.netloc, u.path, "", "", ""))
        if page not in seen:
            seen.add(page)
            out.append(page)
    return out[:MAX_DOCS_PAGES]

def md_candidates(data, page_url):
    """Split a Mintlify .md page into (url, heading) candidates with excerpts."""
    text = data.decode("utf-8", "replace")
    lines = text.splitlines()
    heads = []  # (lineno, level, heading)
    for i, line in enumerate(lines):
        m = MD_HEAD.match(line)
        if m:
            heads.append((i, len(m.group(1)), norm(m.group(2))))
    out = []
    for n, (i, _lvl, heading) in enumerate(heads):
        if not heading or heading.lower() in BOILERPLATE_HEADS:
            continue
        end = heads[n + 1][0] if n + 1 < len(heads) else len(lines)
        body = "\n".join(lines[i + 1:end])
        out.append({"kind": "docs", "url": page_url, "heading": heading,
                    "excerpt": plain(body), "meta": {"source": "docs-md"}})
    return out

def docs_candidates():
    data = fetch(DOCS_INDEX)
    if not data:
        log("docs index fetch failed")
        return None
    pages = docs_page_urls(data, DOCS_INDEX)
    log("docs pages=%d" % len(pages))
    out, failed = [], 0
    for page in pages:
        md = fetch(page + ".md")
        if not md:
            failed += 1
            continue
        out.extend(md_candidates(md, page))
    if failed:
        log("docs pages without .md skipped=%d" % failed)
    return out

# ---------- state + output ----------

def load_state():
    try:
        with open(SEEN_JSON, "r", encoding="utf-8") as f:
            st = json.load(f)
        if isinstance(st, dict) and isinstance(st.get("seen"), dict):
            return st
    except Exception:
        pass
    return {"version": 1, "initialized": False, "seen": {}}

def save_state(state):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = SEEN_JSON + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, sort_keys=True)
        f.write("\n")
    os.replace(tmp, SEEN_JSON)

def prompt_text(c, ts):
    src = c["meta"].get("pubDate") or c["meta"].get("source") or "unknown"
    return ("# Draft queue prompt: %s\n\n"
            "Kind: %s\n"
            "Source: %s\n"
            "Page: %s\n"
            "Heading: %s\n"
            "First seen: %s\n\n"
            "Excerpt:\n\n%s\n\n"
            "Triage: evaluate whether Phantom should adopt a similar capability. "
            "If yes, scope it as a normal queue job; if no, mark this draft rejected "
            "and leave a one-line reason in this file. Staged drafts are not queue "
            "rows; promotion into ready.tsv is a human or leader decision.\n"
            % (job_id(key_for(c["url"], c["heading"])), c["kind"], src,
               c["url"], c["heading"], ts, c["excerpt"] or "(none)"))

def main(argv):
    dry = "--dry-run" in argv
    as_json = "--json" in argv
    max_ideas = MAX_IDEAS
    if "--max" in argv:
        try:
            max_ideas = int(argv[argv.index("--max") + 1])
        except (ValueError, IndexError):
            pass
    state = load_state()
    seen = state["seen"]

    changelog = changelog_candidates()
    docs = docs_candidates()
    if changelog is None and docs is None:
        log("all sources failed; nothing filed")
        return 1
    candidates = (changelog or []) + (docs or [])
    log("candidates=%d seen=%d initialized=%s"
        % (len(candidates), len(seen), state.get("initialized")))

    fresh = []
    dedup = 0
    for c in candidates:
        k = key_for(c["url"], c["heading"])
        if k in seen:
            dedup += 1
            continue
        fresh.append((k, c))

    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    filed, deferred = [], 0
    if not state.get("initialized"):
        # Baseline: record every discovered key, file nothing.
        for k, c in fresh:
            seen[k] = {"job": job_id(k), "kind": c["kind"],
                       "first_seen": ts}
        state["initialized"] = True
        mode = "baseline-seeded"
    else:
        planned = 0
        for k, c in fresh:
            if k in seen:
                dedup += 1
                continue
            if planned >= max_ideas:
                deferred += 1
                continue
            planned += 1
            jid = job_id(k)
            if not dry:
                os.makedirs(STATE_DIR, exist_ok=True)
                with open(os.path.join(STATE_DIR, jid + ".md"), "w",
                          encoding="utf-8") as f:
                    f.write(prompt_text(c, ts))
                with open(INDEX_JSONL, "a", encoding="utf-8") as f:
                    f.write(json.dumps({"ts": ts, "job": jid,
                                        "kind": c["kind"], "url": c["url"],
                                        "heading": c["heading"]},
                                       sort_keys=True) + "\n")
            seen[k] = {"job": jid, "kind": c["kind"], "first_seen": ts}
            filed.append(jid)
        mode = "filed"
    if dry:
        mode = "dry-run"

    if not dry:
        save_state(state)
    summary = {"mode": mode, "candidates": len(candidates),
               "deduped": dedup, "new": len(fresh), "filed": len(filed),
               "deferred": deferred, "max_ideas": max_ideas,
               "dry_run": dry, "state_dir": STATE_DIR}
    if as_json:
        print(json.dumps(summary, sort_keys=True))
    else:
        log("mode=%s candidates=%d deduped=%d new=%d filed=%d deferred=%d"
            % (mode, summary["candidates"], dedup, len(fresh),
               len(filed), deferred))
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
