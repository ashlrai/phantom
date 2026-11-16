//! Owner Assist window chrome only. No agent, shell or filesystem IPC.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{
    AppHandle, Listener, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};

pub const LABEL: &str = "owner-assist";
pub const MENU_ID: &str = "owner-assist.toggle";
const EVENT: &str = "owner-assist-window";
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(default)]
struct Geometry {
    width: f64,
    height: f64,
    x: Option<f64>,
    y: Option<f64>,
}
impl Default for Geometry {
    fn default() -> Self {
        Self {
            width: 420.0,
            height: 600.0,
            x: None,
            y: None,
        }
    }
}
impl Geometry {
    fn sanitize(mut self) -> Self {
        if !self.width.is_finite() || !self.height.is_finite() {
            return Self::default();
        }
        self.width = self.width.clamp(360.0, 1200.0);
        self.height = self.height.clamp(560.0, 1200.0);
        if !self.x.is_some_and(f64::is_finite) || !self.y.is_some_and(f64::is_finite) {
            self.x = None;
            self.y = None;
        }
        self
    }
}
struct WindowState {
    geometry: Geometry,
    mode: String,
}
fn path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".ashlr/owner-assist.window.json"))
}
fn load() -> Geometry {
    path().map(|p| load_at(&p)).unwrap_or_default()
}
fn load_at(path: &Path) -> Geometry {
    fs::File::open(path)
        .ok()
        .and_then(|file| {
            let mut bytes = Vec::new();
            file.take(4097).read_to_end(&mut bytes).ok().map(|_| bytes)
        })
        .filter(|v| v.len() <= 4096)
        .and_then(|v| serde_json::from_slice::<Geometry>(&v).ok())
        .unwrap_or_default()
        .sanitize()
}
fn store(geometry: Geometry) {
    if let Some(path) = path() {
        store_at(&path, geometry);
    }
}
fn store_at(path: &Path, geometry: Geometry) {
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = path.with_extension(format!("json.{}.{nonce}.tmp", std::process::id()));
    if let Ok(bytes) = serde_json::to_vec(&geometry) {
        use std::io::Write;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        if let Ok(mut file) = options.open(&temp) {
            if file.write_all(&bytes).is_ok() {
                let _ = fs::rename(&temp, path);
            }
            let _ = fs::remove_file(temp);
        }
    }
}

pub fn toggle(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window(LABEL) {
            if window.is_visible().unwrap_or(false) { let _ = window.hide(); }
            else { let _ = window.show(); }
            return;
        }
        let state = handle.state::<super::AppState>();
        let read = super::lock(&state.read_token);
        let mutation = super::lock(&state.mutation_token);
        let tokens = read.as_ref().map(|r| super::shell_contract::ShellTokens {
            read_token: &r.0, token: mutation.as_ref().map(|t| t.0.as_str()),
        });
        let mut script = super::shell_contract::init_script_with_state(super::SERVE_ORIGIN, tokens, None);
        script.push_str(r#";if(location.origin === 'http://127.0.0.1:7777') {
          window.__ASHLR_OWNER_WINDOW__ = mode => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {event:'owner-assist-window',payload:mode});
        }"#);
        let geometry = load();
        let url = format!("{}/verse/owner-assist/", super::SERVE_ORIGIN).parse().expect("fixed loopback URL");
        let builder = WebviewWindowBuilder::new(&handle, LABEL, WebviewUrl::External(url))
            .title("Owner Assist").initialization_script(&script).decorations(false)
            .always_on_top(true).visible_on_all_workspaces(true).skip_taskbar(true).focused(false).resizable(true)
            .inner_size(geometry.width, geometry.height).min_inner_size(360.0, 560.0)
            .on_navigation(|url| url.origin().ascii_serialization() == super::SERVE_ORIGIN
                && url.path() == "/verse/owner-assist/");
        let Ok(window) = builder.build() else { return; };
        // A disconnected monitor must never strand the drag handle offscreen.
        let reachable = geometry.x.zip(geometry.y).is_some_and(|(x,y)| {
            window.available_monitors().unwrap_or_default().iter().any(|m| {
                let p = m.position().to_logical::<f64>(m.scale_factor());
                let s = m.size().to_logical::<f64>(m.scale_factor());
                x >= p.x && y >= p.y && x + 120.0 <= p.x + s.width && y + 52.0 <= p.y + s.height
            })
        });
        if reachable { let _ = window.set_position(LogicalPosition::new(geometry.x.unwrap(), geometry.y.unwrap())); }
        else { let _ = window.center(); }
        let saved = std::sync::Arc::new(Mutex::new(WindowState { geometry, mode: "chat".into() }));
        let chrome = window.clone();
        let state = saved.clone();
        window.listen(EVENT, move |event| {
            let Ok(mode) = serde_json::from_str::<String>(event.payload()) else { return; };
            if !["pill", "chat", "fullscreen", "hide"].contains(&mode.as_str()) { return; }
            let chrome = chrome.clone();
            let state = state.clone();
            let _ = chrome.clone().run_on_main_thread(move || {
                if mode == "hide" { let _ = chrome.hide(); return; }
                let geometry = {
                    let mut state = super::lock(&state);
                    state.mode = mode.clone();
                    state.geometry
                };
                store(geometry);
                let _ = chrome.set_fullscreen(mode == "fullscreen");
                let _ = chrome.set_resizable(mode != "pill");
                let _ = chrome.set_min_size(Some(if mode == "pill" { LogicalSize::new(260.0, 52.0) } else { LogicalSize::new(360.0, 560.0) }));
                if mode != "fullscreen" {
                    let (w,h) = if mode == "pill" { (260.0,52.0) } else { (geometry.width,geometry.height) };
                    let _ = chrome.set_size(LogicalSize::new(w,h));
                }
                let _ = chrome.eval(&format!("window.dispatchEvent(new CustomEvent('ashlr:owner-mode',{{detail:{}}}))", serde_json::to_string(&mode).unwrap()));
            });
        });
        let chrome = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                store(super::lock(&saved).geometry);
                let _ = chrome.hide();
            }
            if matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
                let mut saved = super::lock(&saved);
                if saved.mode == "fullscreen" { return; }
                let scale = chrome.scale_factor().unwrap_or(1.0);
                if let Ok(p) = chrome.outer_position() {
                    let p = p.to_logical::<f64>(scale); saved.geometry.x = Some(p.x); saved.geometry.y = Some(p.y);
                }
                if saved.mode == "chat" {
                    if let Ok(s) = chrome.inner_size() {
                        let s = s.to_logical::<f64>(scale); saved.geometry.width = s.width; saved.geometry.height = s.height;
                    }
                }
                store(saved.geometry.sanitize());
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persists_geometry_and_bounds_corrupt_input() {
        let dir =
            std::env::temp_dir().join(format!("phantom-owner-geometry-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("window.json");
        let geometry = Geometry {
            width: 500.0,
            height: 650.0,
            x: Some(20.0),
            y: Some(30.0),
        };
        store_at(&path, geometry);
        let restored = load_at(&path);
        assert_eq!(
            (restored.width, restored.height, restored.x),
            (500.0, 650.0, Some(20.0))
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::write(&path, "x".repeat(4097)).unwrap();
        assert_eq!(load_at(&path).width, Geometry::default().width);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn bounds_and_corrupt_coordinates() {
        let s = Geometry {
            width: 20.0,
            height: 99999.0,
            x: Some(f64::NAN),
            y: Some(1.0),
        }
        .sanitize();
        assert_eq!((s.width, s.height, s.x, s.y), (360.0, 1200.0, None, None));
        assert_eq!(
            Geometry {
                width: f64::INFINITY,
                ..Geometry::default()
            }
            .sanitize()
            .width,
            420.0
        );
    }
}
