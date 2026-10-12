//! A dedicated Devin account window with a read-only extraction path. It is deliberately outside
//! the agent browser: no tab registration, tap, script grant, Tauri capability,
//! or shared website data store. Only closed, sanitized observations return to
//! the local Verse page. They never enter routing, budgets, or authority.

use std::{
    sync::Mutex,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent},
    AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder,
};

pub const REQUEST_EVENT: &str = "shell-devin-reader";
const LABEL: &str = "devin-quota-reader";
const INERT_URL: &str = "about:blank";
const START_URL: &str = "https://app.devin.ai/settings/usage";
const DATA_STORE_ID: [u8; 16] = *b"ashlr-devin-quot";
const TRANSACTION_TTL: Duration = Duration::from_secs(120);
const AUTO_READ_TTL: Duration = Duration::from_secs(20);
const AUTO_RETRY_DELAY: Duration = Duration::from_millis(250);
const MAX_AUTO_ATTEMPTS: u8 = 32;
const SNAPSHOT_TTL_MS: u64 = 120_000;
const EXTRACT: &str = include_str!("devin_reader_extract.js");
const INIT_NONCE: &str = "(function(){try{var b=new Uint8Array(16);crypto.getRandomValues(b);Object.defineProperty(window,'__ashlrDevinReaderNonce',{value:Array.from(b,function(x){return x.toString(16).padStart(2,'0')}).join(''),writable:false,configurable:false})}catch(_){}})();";

#[derive(Default)]
pub struct ReaderState(Mutex<Session>);

#[derive(Default)]
struct Session {
    expected_org: Option<String>,
    opening: bool,
    open_generation: u64,
    epoch: u64,
    capture_seq: u64,
    pending: Option<Pending>,
    auto: Option<AutoRead>,
    auto_generation: u64,
    auto_enabled: bool,
    cadence_generation: u64,
}

impl Session {
    fn capture_current(&self, epoch: u64, sequence: u64) -> bool {
        self.epoch == epoch && self.capture_seq == sequence
    }
    fn begin_open(&mut self) -> Option<u64> {
        if self.opening {
            return None;
        }
        self.open_generation = self.open_generation.wrapping_add(1);
        self.opening = true;
        Some(self.open_generation)
    }

    fn finish_open(&mut self, generation: u64) -> bool {
        if self.open_generation != generation {
            return false;
        }
        self.opening = false;
        self.expected_org.is_some()
    }

    fn cancel_open(&mut self) {
        self.expected_org = None;
        self.open_generation = self.open_generation.wrapping_add(1);
        self.opening = false;
    }

    fn cancel_auto(&mut self) {
        self.auto_generation = self.auto_generation.wrapping_add(1);
        self.capture_seq = self.capture_seq.wrapping_add(1);
        self.auto = None;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AutoPhase {
    FirstGeneral,
    Usage,
    LastGeneral,
}

impl AutoPhase {
    fn page(self) -> &'static str {
        match self {
            Self::FirstGeneral | Self::LastGeneral => "general",
            Self::Usage => "usage",
        }
    }
}

struct AutoRead {
    generation: u64,
    slug: String,
    phase: AutoPhase,
    started: Instant,
    attempts: u8,
}

impl AutoRead {
    fn expects(&self, url: &Url) -> bool {
        page_path(url).is_some_and(|(slug, page)| slug == self.slug && page == self.phase.page())
    }

    fn current(&self, generation: u64) -> bool {
        self.generation == generation && self.started.elapsed() <= AUTO_READ_TTL
    }
}

struct Pending {
    slug: String,
    org_id: String,
    started: Instant,
    last_nonce: String,
    last_epoch: u64,
    usage: Option<Usage>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Usage {
    weekly_used_percent: u8,
    on_demand_balance_usd: f64,
    plan: String,
    monthly_price_usd: f64,
    reset_prose: Option<String>,
    renewal_prose: Option<String>,
    auto_reload: Option<bool>,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", deny_unknown_fields)]
enum Request {
    Open {
        #[serde(rename = "orgId")]
        org_id: String,
    },
    Capture,
    Auto {
        enabled: bool,
    },
    Close,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Extracted {
    page: Option<String>,
    slug: Option<String>,
    document_nonce: Option<String>,
    org_id: Option<String>,
    weekly_used_percent: Option<f64>,
    on_demand_balance_usd: Option<f64>,
    plan: Option<String>,
    monthly_price_usd: Option<f64>,
    reset_prose: Option<String>,
    renewal_prose: Option<String>,
    auto_reload: Option<bool>,
    error: Option<String>,
}

fn lock(state: &ReaderState) -> std::sync::MutexGuard<'_, Session> {
    state.0.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn org_id_valid(id: &str) -> bool {
    id.strip_prefix("org-").is_some_and(|rest| {
        !rest.is_empty()
            && rest.len() <= 120
            && rest
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

fn slug_valid(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 120
        && slug
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn provider_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("app.devin.ai")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

fn page_path(url: &Url) -> Option<(&str, &str)> {
    if !provider_url(url) || url.query().is_some() || url.fragment().is_some() {
        return None;
    }
    let mut parts = url.path().split('/');
    if parts.next()? != "" || parts.next()? != "org" {
        return None;
    }
    let slug = parts.next()?;
    if !slug_valid(slug) || parts.next()? != "settings" {
        return None;
    }
    let page = parts.next()?;
    if parts.next().is_some() || !matches!(page, "general" | "usage") {
        return None;
    }
    Some((slug, page))
}

fn event_script(value: &Value) -> String {
    let json = serde_json::to_string(value)
        .unwrap_or_else(|_| "null".into())
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    format!("if(typeof window.__ASHLR_DEVIN_READER_EVENT__==='function')window.__ASHLR_DEVIN_READER_EVENT__({json});")
}

fn emit(app: &AppHandle, value: Value) {
    if let Some(main) = app.get_webview_window(crate::MAIN_WINDOW_LABEL) {
        let _ = main.eval(event_script(&value));
    }
}

fn status(app: &AppHandle, code: &'static str) {
    emit(app, json!({"kind":"status","state":code}));
}

pub fn handle_event(app: &AppHandle, payload: &str) {
    let Ok(request) = serde_json::from_str::<Request>(payload) else {
        return;
    };
    match request {
        Request::Open { org_id } => {
            if !org_id_valid(&org_id) {
                status(app, "organization-unavailable");
                return;
            }
            let generation = {
                let Some(state) = app.try_state::<ReaderState>() else {
                    return;
                };
                let mut session = lock(&state);
                if session.expected_org.as_deref() != Some(&org_id) {
                    session.pending = None;
                    session.cancel_auto();
                    session.auto_enabled = false;
                    session.cadence_generation = session.cadence_generation.wrapping_add(1);
                }
                session.expected_org = Some(org_id);
                let Some(generation) = session.begin_open() else {
                    status(app, "opening");
                    return;
                };
                generation
            };
            if let Some(window) = app.get_webview_window(LABEL) {
                if let Some(state) = app.try_state::<ReaderState>() {
                    let mut session = lock(&state);
                    let current = session.finish_open(generation);
                    if !current {
                        return;
                    }
                }
                let _ = window.show();
                let _ = window.set_focus();
                status(app, "open");
            } else {
                let worker_app = app.clone();
                if thread::Builder::new()
                    .name("devin-reader-open".into())
                    .spawn(move || open_window(&worker_app, generation))
                    .is_err()
                {
                    if let Some(state) = app.try_state::<ReaderState>() {
                        lock(&state).finish_open(generation);
                    }
                    status(app, "unavailable");
                }
            }
        }
        Request::Capture => begin_refresh(app),
        Request::Auto { enabled } => set_auto_cadence(app, enabled),
        Request::Close => {
            if let Some(window) = app.get_webview_window(LABEL) {
                let _ = window.destroy();
            }
            if let Some(state) = app.try_state::<ReaderState>() {
                let mut session = lock(&state);
                session.pending = None;
                session.cancel_auto();
                session.auto_enabled = false;
                session.cadence_generation = session.cadence_generation.wrapping_add(1);
                session.cancel_open();
                session.capture_seq = session.capture_seq.wrapping_add(1);
            }
            status(app, "closed");
        }
    }
}

fn begin_refresh(app: &AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else {
        status(app, "not-open");
        return;
    };
    let Ok(url) = window.url() else {
        status(app, "page-unavailable");
        return;
    };
    let Some((slug, "general")) = page_path(&url) else {
        status(app, "open-general-first");
        return;
    };
    let Some(state) = app.try_state::<ReaderState>() else {
        return;
    };
    let mut session = lock(&state);
    if session.opening || session.expected_org.is_none() {
        drop(session);
        status(app, "organization-unavailable");
        return;
    }
    if session.auto.is_some() {
        drop(session);
        status(app, "refresh-in-progress");
        return;
    }
    session.cancel_auto();
    session.pending = None;
    session.auto = Some(AutoRead {
        generation: session.auto_generation,
        slug: slug.into(),
        phase: AutoPhase::FirstGeneral,
        started: Instant::now(),
        attempts: 0,
    });
    drop(session);
    status(app, "refreshing-general");
    capture(app);
}

fn set_auto_cadence(app: &AppHandle, enabled: bool) {
    let Some(state) = app.try_state::<ReaderState>() else {
        return;
    };
    let (generation, active) = {
        let mut session = lock(&state);
        session.cadence_generation = session.cadence_generation.wrapping_add(1);
        session.auto_enabled =
            enabled && session.expected_org.is_some() && app.get_webview_window(LABEL).is_some();
        (session.cadence_generation, session.auto_enabled)
    };
    if !active {
        status(app, if enabled { "not-open" } else { "auto-off" });
        return;
    }
    let worker_app = app.clone();
    if thread::Builder::new()
        .name("devin-reader-cadence".into())
        .spawn(move || loop {
            thread::sleep(Duration::from_secs(60));
            let Some(state) = worker_app.try_state::<ReaderState>() else {
                break;
            };
            let session = lock(&state);
            if !session.auto_enabled || session.cadence_generation != generation {
                break;
            }
            let idle = session.auto.is_none();
            drop(session);
            if idle {
                begin_refresh(&worker_app);
            }
        })
        .is_err()
    {
        if let Some(state) = app.try_state::<ReaderState>() {
            lock(&state).auto_enabled = false;
        }
        status(app, "unavailable");
        return;
    }
    status(app, "auto-on");
}

fn open_window(app: &AppHandle, generation: u64) {
    let (Ok(blank), Ok(start)) = (Url::parse(INERT_URL), Url::parse(START_URL)) else {
        status(app, "unavailable");
        return;
    };
    let nav_app = app.clone();
    let load_app = app.clone();
    // WebKit loads an external URL during build(), before with_webview can
    // install the media-deny delegate. Begin on an inert document instead.
    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(blank))
        .title("Devin account — Phantom dashboard observation")
        .visible(false)
        .inner_size(920.0, 720.0)
        .initialization_script(INIT_NONCE)
        .on_navigation(move |url| {
            let allowed = provider_url(url) || (url.scheme() == "about" && url.path() == "blank");
            if let Some(state) = nav_app.try_state::<ReaderState>() {
                let mut session = lock(&state);
                if !allowed || session.auto.as_ref().is_some_and(|auto| !auto.expects(url)) {
                    session.pending = None;
                    session.cancel_auto();
                    session.capture_seq = session.capture_seq.wrapping_add(1);
                    drop(session);
                    status(
                        &nav_app,
                        if allowed {
                            "refresh-cancelled"
                        } else {
                            "external-sign-in-unavailable"
                        },
                    );
                }
            }
            allowed
        })
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_page_load(move |_, payload| {
            if matches!(payload.event(), PageLoadEvent::Started) {
                if let Some(state) = load_app.try_state::<ReaderState>() {
                    let mut session = lock(&state);
                    session.epoch = session.epoch.wrapping_add(1);
                    session.capture_seq = session.capture_seq.wrapping_add(1);
                    if session
                        .auto
                        .as_ref()
                        .is_some_and(|auto| !auto.expects(payload.url()))
                    {
                        session.pending = None;
                        session.cancel_auto();
                    }
                    if let Some(pending) = session.pending.as_ref() {
                        let same_slug =
                            page_path(payload.url()).is_some_and(|(slug, _)| slug == pending.slug);
                        if !same_slug {
                            session.pending = None;
                        }
                    }
                }
                status(&load_app, "page-loading");
            } else if matches!(payload.event(), PageLoadEvent::Finished) {
                let should_capture = load_app.try_state::<ReaderState>().is_some_and(|state| {
                    lock(&state).auto.as_ref().is_some_and(|auto| {
                        auto.expects(payload.url()) && auto.started.elapsed() <= AUTO_READ_TTL
                    })
                });
                if should_capture {
                    capture(&load_app);
                }
            }
        });
    #[cfg(target_os = "macos")]
    {
        // macOS <14 silently ignores data_store_identifier. Incognito then
        // preserves isolation at the cost of a sign-in on every app restart.
        builder = if objc2_foundation::NSProcessInfo::processInfo()
            .operatingSystemVersion()
            .majorVersion
            >= 14
        {
            builder.data_store_identifier(DATA_STORE_ID)
        } else {
            builder.incognito(true)
        };
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Other backends have no independently verified private persistent
        // directory here. Ephemeral storage is safer than sharing Verse's.
        builder = builder.incognito(true);
    }
    match builder.build() {
        Ok(window) => {
            // This is a remote page inside the microphone-enabled desktop app.
            // A failed denial is a failed window, never a warning-only state.
            if crate::media_guard::apply_confirmed(&window).is_err() {
                let _ = window.destroy();
                if let Some(state) = app.try_state::<ReaderState>() {
                    if lock(&state).finish_open(generation) {
                        status(app, "media-guard-unavailable");
                    }
                }
                return;
            }
            let Some(state) = app.try_state::<ReaderState>() else {
                let _ = window.destroy();
                return;
            };
            let mut session = lock(&state);
            let current = session.finish_open(generation);
            drop(session);
            if !current {
                let _ = window.destroy();
                return;
            }
            // Only the guarded WKWebView may contact Devin. Keep it hidden
            // and fail closed if navigation itself cannot be started.
            if window.navigate(start).is_err() {
                let _ = window.destroy();
                status(app, "unavailable");
                return;
            }
            // Close or an organization switch can happen while navigation is
            // dispatched. Never reveal a late worker's stale window.
            if app.try_state::<ReaderState>().is_none_or(|state| {
                let session = lock(&state);
                session.open_generation != generation || session.expected_org.is_none()
            }) {
                let _ = window.destroy();
                return;
            }
            let _ = window.show();
            let _ = window.set_focus();
            status(app, "open");
        }
        Err(_) => {
            if let Some(state) = app.try_state::<ReaderState>() {
                let mut session = lock(&state);
                let current = session.finish_open(generation);
                drop(session);
                if current {
                    status(app, "unavailable");
                }
            }
        }
    }
}

fn capture(app: &AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else {
        status(app, "not-open");
        return;
    };
    let Ok(before) = window.url() else {
        status(app, "page-unavailable");
        return;
    };
    if page_path(&before).is_none() {
        if let Some(state) = app.try_state::<ReaderState>() {
            let mut session = lock(&state);
            session.pending = None;
            session.cancel_auto();
        }
        status(app, "open-general-or-usage");
        return;
    }
    let Some(state) = app.try_state::<ReaderState>() else {
        return;
    };
    let (epoch, sequence) = {
        let mut session = lock(&state);
        if session
            .auto
            .as_ref()
            .is_some_and(|auto| !auto.expects(&before))
        {
            session.pending = None;
            session.cancel_auto();
            drop(session);
            status(app, "refresh-cancelled");
            return;
        }
        session.capture_seq = session.capture_seq.wrapping_add(1);
        (session.epoch, session.capture_seq)
    };
    let callback_app = app.clone();
    if window
        .eval_with_callback(EXTRACT, move |raw| {
            let Some(window) = callback_app.get_webview_window(LABEL) else {
                return;
            };
            let Some(state) = callback_app.try_state::<ReaderState>() else {
                return;
            };
            let current = lock(&state);
            let changed = !current.capture_current(epoch, sequence);
            drop(current);
            if changed {
                return;
            }
            if window.url().ok().as_ref() != Some(&before) {
                if let Some(state) = callback_app.try_state::<ReaderState>() {
                    lock(&state).cancel_auto();
                }
                status(&callback_app, "page-changed");
                return;
            }
            let Some(read) = decode(raw) else {
                retry_or_fail(&callback_app, "unavailable");
                return;
            };
            apply_read(&callback_app, &state, &before, epoch, sequence, read);
        })
        .is_err()
    {
        retry_or_fail(app, "read-failed");
    }
}

fn retry_or_fail(app: &AppHandle, code: &'static str) {
    let Some(state) = app.try_state::<ReaderState>() else {
        return;
    };
    let generation = {
        let mut session = lock(&state);
        let Some(auto) = session.auto.as_mut() else {
            drop(session);
            status(app, code);
            return;
        };
        if auto.started.elapsed() > AUTO_READ_TTL || auto.attempts >= MAX_AUTO_ATTEMPTS {
            session.pending = None;
            session.cancel_auto();
            drop(session);
            status(app, code);
            return;
        }
        auto.attempts += 1;
        auto.generation
    };
    let worker_app = app.clone();
    if thread::Builder::new()
        .name("devin-reader-retry".into())
        .spawn(move || {
            thread::sleep(AUTO_RETRY_DELAY);
            let Some(state) = worker_app.try_state::<ReaderState>() else {
                return;
            };
            let mut session = lock(&state);
            let current = session
                .auto
                .as_ref()
                .is_some_and(|auto| auto.current(generation));
            let expired = session
                .auto
                .as_ref()
                .is_some_and(|auto| auto.generation == generation && !current);
            if expired {
                session.pending = None;
                session.cancel_auto();
            }
            drop(session);
            if current {
                capture(&worker_app);
            } else if expired {
                status(&worker_app, "usage-unavailable");
            }
        })
        .is_err()
    {
        if let Some(state) = app.try_state::<ReaderState>() {
            lock(&state).cancel_auto();
        }
        status(app, "unavailable");
    }
}

fn navigate_phase(app: &AppHandle, slug: &str, page: &str) {
    let url = format!("https://app.devin.ai/org/{slug}/settings/{page}");
    let result = Url::parse(&url)
        .ok()
        .and_then(|url| app.get_webview_window(LABEL)?.navigate(url).ok());
    if result.is_none() {
        if let Some(state) = app.try_state::<ReaderState>() {
            let mut session = lock(&state);
            session.pending = None;
            session.cancel_auto();
        }
        status(app, "refresh-cancelled");
    }
}

fn decode(raw: String) -> Option<Extracted> {
    if raw.len() > 2048 {
        return None;
    }
    let inner = serde_json::from_str::<String>(&raw).ok()?;
    if inner.len() > 1024 {
        return None;
    }
    serde_json::from_str(&inner).ok()
}

fn valid_usage(read: &Extracted) -> Option<Usage> {
    let used = read.weekly_used_percent?;
    let balance = read.on_demand_balance_usd?;
    let monthly = read.monthly_price_usd?;
    if !used.is_finite()
        || used.fract() != 0.0
        || !(0.0..=100.0).contains(&used)
        || !balance.is_finite()
        || !(0.0..=1_000_000.0).contains(&balance)
        || !monthly.is_finite()
        || !(0.0..=1_000_000.0).contains(&monthly)
        || read.plan.as_deref() != Some("Max")
    {
        return None;
    }
    let prose = |value: &Option<String>, prefix: &str| {
        value
            .as_ref()
            .filter(|s| {
                s.len() <= 80 && s.starts_with(prefix) && s.is_ascii() && !s.contains(['<', '>'])
            })
            .cloned()
    };
    Some(Usage {
        weekly_used_percent: used as u8,
        on_demand_balance_usd: balance,
        plan: "Max".into(),
        monthly_price_usd: monthly,
        reset_prose: prose(&read.reset_prose, "Resets in "),
        renewal_prose: prose(&read.renewal_prose, "Renews on "),
        auto_reload: read.auto_reload,
    })
}

fn apply_read(
    app: &AppHandle,
    state: &ReaderState,
    url: &Url,
    epoch: u64,
    sequence: u64,
    read: Extracted,
) {
    if let Some(error) = read.error.as_deref() {
        if matches!(
            error,
            "org-label" | "org-field" | "org-value" | "usage-heading" | "usage-fields"
        ) {
            retry_or_fail(app, "usage-unavailable");
        } else {
            if let Some(state) = app.try_state::<ReaderState>() {
                lock(&state).cancel_auto();
            }
            status(app, "unavailable");
        }
        return;
    }
    let Some((slug, page)) = page_path(url) else {
        if let Some(state) = app.try_state::<ReaderState>() {
            lock(&state).cancel_auto();
        }
        status(app, "page-changed");
        return;
    };
    if read.page.as_deref() != Some(page)
        || read.slug.as_deref() != Some(slug)
        || !read
            .document_nonce
            .as_deref()
            .is_some_and(|n| n.len() == 32 && n.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        if let Some(state) = app.try_state::<ReaderState>() {
            lock(&state).cancel_auto();
        }
        status(app, "page-changed");
        return;
    }
    let mut session = lock(state);
    if !session.capture_current(epoch, sequence) {
        drop(session);
        status(app, "page-changed");
        return;
    }
    if !session
        .auto
        .as_ref()
        .is_some_and(|auto| auto.expects(url) && auto.started.elapsed() <= AUTO_READ_TTL)
    {
        session.pending = None;
        session.cancel_auto();
        drop(session);
        status(app, "refresh-cancelled");
        return;
    }
    let nonce = read.document_nonce.as_deref().unwrap_or_default();
    if session.pending.as_ref().is_some_and(|pending| {
        (pending.last_epoch == epoch && pending.last_nonce != nonce)
            || (pending.last_epoch != epoch && pending.last_nonce == nonce)
    }) {
        session.pending = None;
        session.cancel_auto();
        drop(session);
        status(app, "page-changed");
        return;
    }
    let Some(expected) = session.expected_org.as_deref() else {
        session.cancel_auto();
        status(app, "organization-unavailable");
        return;
    };
    if page == "general" {
        let Some(org_id) = read.org_id.filter(|id| org_id_valid(id) && id == expected) else {
            session.pending = None;
            session.cancel_auto();
            drop(session);
            status(app, "organization-mismatch");
            return;
        };
        if let Some(pending) = session.pending.take() {
            if pending.slug == slug
                && pending.org_id == org_id
                && pending.started.elapsed() <= TRANSACTION_TTL
            {
                if let Some(usage) = pending.usage {
                    session.cancel_auto();
                    drop(session);
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    emit(
                        app,
                        json!({"kind":"snapshot","source":"devin-dashboard-organization","accountVerified":false,"orgId":org_id,
                        "observedAtMs":now,"expiresAtMs":now.saturating_add(SNAPSHOT_TTL_MS),"usage":usage}),
                    );
                    return;
                }
            }
        }
        session.pending = Some(Pending {
            slug: slug.into(),
            org_id,
            started: Instant::now(),
            last_nonce: nonce.into(),
            last_epoch: epoch,
            usage: None,
        });
        let advance = session.auto.as_mut().is_some_and(|auto| {
            if auto.phase != AutoPhase::FirstGeneral || auto.slug != slug {
                return false;
            }
            auto.phase = AutoPhase::Usage;
            auto.attempts = 0;
            true
        });
        drop(session);
        if advance {
            status(app, "refreshing-usage");
            navigate_phase(app, slug, "usage");
        } else {
            status(app, "general-verified-read-usage");
        }
    } else {
        let Some(usage) = valid_usage(&read) else {
            drop(session);
            retry_or_fail(app, "usage-unavailable");
            return;
        };
        let Some(pending) = session.pending.as_mut() else {
            session.cancel_auto();
            drop(session);
            status(app, "verify-general-first");
            return;
        };
        if pending.slug != slug
            || pending.started.elapsed() > TRANSACTION_TTL
            || pending.usage.is_some()
        {
            session.pending = None;
            session.cancel_auto();
            drop(session);
            status(app, "restart-verification");
            return;
        }
        pending.usage = Some(usage);
        pending.last_nonce = nonce.into();
        pending.last_epoch = epoch;
        let advance = session.auto.as_mut().is_some_and(|auto| {
            if auto.phase != AutoPhase::Usage || auto.slug != slug {
                return false;
            }
            auto.phase = AutoPhase::LastGeneral;
            auto.attempts = 0;
            true
        });
        drop(session);
        if advance {
            status(app, "confirming-general");
            navigate_phase(app, slug, "general");
        } else {
            status(app, "usage-held-confirm-general");
        }
    }
}

pub fn on_destroyed(app: &AppHandle, label: &str) {
    if label == LABEL {
        if let Some(state) = app.try_state::<ReaderState>() {
            let mut session = lock(&state);
            session.pending = None;
            session.cancel_auto();
            session.auto_enabled = false;
            session.cadence_generation = session.cadence_generation.wrapping_add(1);
            session.expected_org = None;
            session.open_generation = session.open_generation.wrapping_add(1);
            session.opening = false;
            session.capture_seq = session.capture_seq.wrapping_add(1);
        }
        status(app, "closed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_navigation_is_exact_origin_and_page_paths_are_closed() {
        assert_eq!(INERT_URL, "about:blank");
        for bad in [
            "http://app.devin.ai/org/a/settings/usage",
            "https://evil.app.devin.ai/org/a/settings/usage",
            "https://app.devin.ai:444/org/a/settings/usage",
            "https://app.devin.ai@evil.test/org/a/settings/usage",
        ] {
            assert!(!provider_url(&Url::parse(bad).unwrap()));
        }
        assert_eq!(
            page_path(&Url::parse("https://app.devin.ai/org/example/settings/general").unwrap()),
            Some(("example", "general"))
        );
        assert!(page_path(
            &Url::parse("https://app.devin.ai/org/example/settings/usage?other=1").unwrap()
        )
        .is_none());
    }

    #[test]
    fn output_bridge_cannot_interpolate_provider_text_as_code() {
        let script = event_script(&json!({"kind":"status","state":"</script>\u{2028}bad"}));
        assert!(script.contains("\\u2028"));
        assert!(!script.contains('\u{2028}'));
    }

    #[test]
    fn no_capability_or_shared_browser_store_for_reader() {
        for source in [
            include_str!("../capabilities/main.json"),
            include_str!("../capabilities/launch.json"),
            include_str!("../capabilities/verse-remote.json"),
        ] {
            assert!(!source.contains(LABEL));
            assert!(!source.contains("\"windows\": [\"*\"]"));
        }
        assert_ne!(DATA_STORE_ID, *b"ashlr-browser-v1");
        assert!(!EXTRACT.contains("document.cookie"));
        assert!(!EXTRACT.contains("innerHTML"));
        assert!(!EXTRACT.contains("fetch("));
    }

    #[test]
    fn usage_requires_finite_bounded_values() {
        let good = Extracted {
            page: Some("usage".into()),
            slug: Some("example".into()),
            document_nonce: Some("0".repeat(32)),
            org_id: None,
            weekly_used_percent: Some(0.0),
            on_demand_balance_usd: Some(0.0),
            plan: Some("Max".into()),
            monthly_price_usd: Some(123.0),
            reset_prose: Some("Resets in 4 days".into()),
            renewal_prose: None,
            auto_reload: Some(false),
            error: None,
        };
        assert_eq!(valid_usage(&good).unwrap().weekly_used_percent, 0);
        assert!(valid_usage(&Extracted {
            weekly_used_percent: Some(f64::NAN),
            ..good
        })
        .is_none());
    }

    #[test]
    fn open_close_and_duplicate_open_cannot_resurrect_hidden_window() {
        let mut session = Session {
            expected_org: Some("org-a".into()),
            ..Session::default()
        };
        let first = session.begin_open().unwrap();
        assert!(session.begin_open().is_none());
        session.cancel_open();
        assert!(!session.finish_open(first));
        assert!(session.expected_org.is_none());
        session.expected_org = Some("org-b".into());
        let second = session.begin_open().unwrap();
        assert_ne!(first, second);
        assert!(!session.finish_open(first));
        assert!(session.opening);
        assert!(session.finish_open(second));
    }

    #[test]
    fn older_capture_callbacks_and_document_loads_are_rejected() {
        let mut session = Session {
            epoch: 4,
            capture_seq: 9,
            ..Session::default()
        };
        assert!(session.capture_current(4, 9));
        session.capture_seq += 1;
        assert!(!session.capture_current(4, 9));
        session.epoch += 1;
        assert!(!session.capture_current(4, 10));
        assert!(session.capture_current(5, 10));
    }

    #[test]
    fn automatic_bracket_requires_exact_phase_slug_and_cancels_old_callbacks() {
        let mut session = Session {
            expected_org: Some("org-example".into()),
            epoch: 3,
            capture_seq: 7,
            ..Session::default()
        };
        session.cancel_auto();
        let generation = session.auto_generation;
        session.auto = Some(AutoRead {
            generation,
            slug: "example".into(),
            phase: AutoPhase::FirstGeneral,
            started: Instant::now(),
            attempts: 0,
        });
        let general = Url::parse("https://app.devin.ai/org/example/settings/general").unwrap();
        let usage = Url::parse("https://app.devin.ai/org/example/settings/usage").unwrap();
        let other = Url::parse("https://app.devin.ai/org/other/settings/general").unwrap();
        assert!(session.auto.as_ref().unwrap().expects(&general));
        assert!(!session.auto.as_ref().unwrap().expects(&usage));
        assert!(!session.auto.as_ref().unwrap().expects(&other));
        session.auto.as_mut().unwrap().phase = AutoPhase::Usage;
        assert!(session.auto.as_ref().unwrap().expects(&usage));
        let old_sequence = session.capture_seq;
        session.cancel_auto();
        assert!(!session.capture_current(3, old_sequence));
        assert!(session.auto.is_none());
    }
}
