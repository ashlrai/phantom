//! Making sure the sidecar never outlives the app.
//!
//! The app spawns `ashlr verse` as a child. Three exit paths have to leave a
//! clean machine behind:
//!
//!   1. **Quit** (⌘Q, the app menu, the tray) → `RunEvent::Exit` reaps the
//!      child through [`terminate_tree`], which gives the sidecar time to
//!      settle its native workers.
//!   2. **A signal** (`pkill`, Ctrl-C, a crash handler upstream) → the event
//!      loop gets the same graceful exit request from [`install_signal_handlers`].
//!   3. **A hard kill or panic** (SIGKILL, a crash) → nothing of ours runs at
//!      all. The next launch repairs it: [`reclaim_orphan`] reads the ownership
//!      record left at spawn time, and if the app that wrote it is gone while
//!      its sidecar is still alive, that sidecar is ours and orphaned, so it is
//!      killed before the port is probed.
//!
//! Without (3) a crash left `ashlr verse` holding 127.0.0.1:7777 forever, and
//! every relaunch landed on the "port is already in use" screen — technically
//! honest, practically a broken app.
//!
//! ## Why the record is safe to act on
//!
//! A pid alone is not proof: pids are recycled. Before killing anything,
//! [`reclaim_orphan`] requires all four of:
//!
//!   * the record names the port we are about to bind,
//!   * the desktop process that wrote it is **dead**,
//!   * the recorded sidecar pid is **alive**, and
//!   * that pid's argv still starts with **our own** sidecar path.
//!
//! The last check is what makes recycling harmless: a recycled pid belongs to
//! some other program, whose argv will not be the sidecar binary inside this
//! app bundle. The decision itself is the pure [`should_reclaim`], so all of it
//! is testable without spawning anything.
//!
//! The warm path acts on the child handle and snapshots its descendant
//! identities before the parent can exit.
//!
//! Nothing here reads, logs, or stores a token: the record holds two pids and a
//! port number, and argv is only ever compared against a path we already know.

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::path::PathBuf;
#[cfg(unix)]
use std::{
    io::Read,
    os::{fd::AsRawFd, unix::net::UnixStream},
    sync::atomic::{AtomicI32, Ordering},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

/// Ownership record written next to the first-run marker in `~/.ashlr`.
const RECORD_FILE: &str = ".desktop-sidecar.json";

#[cfg(unix)]
static SIGNAL_FD: AtomicI32 = AtomicI32::new(-1);

/// What the running app recorded about the sidecar it owns.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SidecarRecord {
    /// Pid of the desktop app that spawned the sidecar.
    #[serde(rename = "desktopPid")]
    pub desktop_pid: i32,
    /// Pid of the sidecar itself.
    #[serde(rename = "sidecarPid")]
    pub sidecar_pid: i32,
    /// Port the sidecar was told to bind.
    pub port: u16,
    /// Absolute path of the sidecar binary, used to rule out pid recycling.
    #[serde(rename = "sidecarPath")]
    pub sidecar_path: String,
}

/// Facts about the world that [`should_reclaim`] needs, gathered separately so
/// the decision can be unit-tested.
#[derive(Clone, Copy, Debug)]
pub struct LivenessFacts {
    pub desktop_alive: bool,
    pub sidecar_alive: bool,
    /// The recorded sidecar pid's argv starts with the recorded sidecar path.
    pub path_matches: bool,
}

/// Is the recorded sidecar an orphan of ours that we may kill?
///
/// Every condition is required. In particular a *live* desktop pid means
/// another copy of the app is running and owns that sidecar — reclaiming it
/// would kill a working window out from under the user.
pub fn should_reclaim(record: &SidecarRecord, port: u16, facts: LivenessFacts) -> bool {
    record.port == port
        && record.sidecar_pid > 1
        && record.desktop_pid > 1
        && !facts.desktop_alive
        && facts.sidecar_alive
        && facts.path_matches
}

/// `~/.ashlr/.desktop-sidecar.json`.
pub fn record_path() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".ashlr").join(RECORD_FILE)
}

/// Strip the arguments we spawned the sidecar with off its argv line, leaving
/// the binary path.
///
/// Derived from the live process rather than guessed, because the bundle path
/// (`…/Ashlr.app/Contents/MacOS/ashlr`) and the dev path
/// (`…/binaries/ashlr-aarch64-apple-darwin`) differ, and either may contain
/// spaces if the app was renamed. Knowing the exact argument list makes this a
/// suffix strip rather than a parse.
pub fn binary_path_from_argv(argv: &str, args: &[&str]) -> Option<String> {
    let argv = argv.trim();
    if argv.is_empty() {
        return None;
    }
    let path = if args.is_empty() {
        argv
    } else {
        argv.strip_suffix(&format!(" {}", args.join(" ")))?
    };
    let path = path.trim_end();
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

/// Persist the ownership record.
///
/// `args` is the argument list the sidecar was spawned with; it is used to
/// recover the binary path from the live process's argv. If that path cannot be
/// read, no record is written — the app then behaves exactly as it did before
/// this module existed, rather than recording something it cannot verify later.
pub fn record(sidecar_pid: u32, port: u16, args: &[&str]) {
    let Some(sidecar_path) = process_argv(sidecar_pid as i32)
        .as_deref()
        .and_then(|argv| binary_path_from_argv(argv, args))
    else {
        eprintln!(
            "[ashlr-desktop] could not read the sidecar's own path — no crash-recovery record written"
        );
        return;
    };

    let record = SidecarRecord {
        desktop_pid: std::process::id() as i32,
        sidecar_pid: sidecar_pid as i32,
        port,
        sidecar_path,
    };
    let path = record_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match serde_json::to_vec(&record) {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(&path, bytes) {
                eprintln!("[ashlr-desktop] could not write the sidecar ownership record: {e}");
            }
        }
        Err(e) => eprintln!("[ashlr-desktop] could not encode the sidecar ownership record: {e}"),
    }
}

/// Forget the sidecar's ownership record.
///
/// Called after a clean reap so the next launch has nothing to reclaim.
pub fn clear() {
    let path = record_path();
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
}

/// Read the record, if one is there and parses.
pub fn load() -> Option<SidecarRecord> {
    let bytes = std::fs::read(record_path()).ok()?;
    serde_json::from_slice(&bytes).ok()
}

// ── process inspection ───────────────────────────────────────────────────────

/// Is `pid` a live process?
///
/// A **zombie** counts as dead. `kill(pid, 0)` succeeds for a process that has
/// exited but whose parent has not reaped it, and treating that as alive is the
/// difference between recovering from a crash and refusing to: the crashed app
/// would look alive forever, so its orphaned sidecar would never be reclaimed.
#[cfg(unix)]
pub fn process_is_alive(pid: i32) -> bool {
    if pid <= 1 {
        return false;
    }
    // `kill(pid, 0)` performs the permission and existence check without
    // sending anything. EPERM still means the process exists.
    let rc = unsafe { libc::kill(pid, 0) };
    let exists = rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    exists && !process_is_zombie(pid)
}

/// Has `pid` exited without being reaped?
///
/// Unknown state is reported as *not* a zombie, so an unreadable process is
/// treated as alive and nothing gets killed on a guess.
#[cfg(unix)]
fn process_is_zombie(pid: i32) -> bool {
    let Ok(out) = std::process::Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "state="])
        .output()
    else {
        return false;
    };
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .starts_with('Z')
}

#[cfg(not(unix))]
pub fn process_is_alive(_pid: i32) -> bool {
    false
}

/// Full argv of `pid`, or `None` if it cannot be read.
#[cfg(unix)]
fn process_argv(pid: i32) -> Option<String> {
    // `-ww` disables the width truncation macOS `ps` otherwise applies: the
    // sidecar path inside an app bundle is long, and a truncated argv would
    // silently fail the pid-recycling check.
    let out = std::process::Command::new("/bin/ps")
        .args(["-ww", "-p", &pid.to_string(), "-o", "args="])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(not(unix))]
fn process_argv(_pid: i32) -> Option<String> {
    None
}

/// Does `pid`'s argv start with `expected_path`?
///
/// Compared as a prefix because argv carries the sidecar's own flags after the
/// binary path. This is the pid-recycling guard, so a pid whose argv cannot be
/// read at all is treated as *not* matching.
pub fn argv_starts_with(pid: i32, expected_path: &str) -> bool {
    if expected_path.is_empty() {
        return false;
    }
    match process_argv(pid) {
        Some(argv) => argv == expected_path || argv.starts_with(&format!("{expected_path} ")),
        None => false,
    }
}

/// Direct children of `pid`.
#[cfg(unix)]
fn child_pids(pid: i32) -> Vec<i32> {
    let Ok(out) = std::process::Command::new("/usr/bin/pgrep")
        .args(["-P", &pid.to_string()])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<i32>().ok())
        .filter(|child| *child > 1)
        .collect()
}

#[cfg(not(unix))]
fn child_pids(_pid: i32) -> Vec<i32> {
    Vec::new()
}

/// How deep the descendant walk goes. The sidecar's worker layer is one level;
/// a bound keeps a pathological `pgrep` result from looping.
const MAX_TREE_DEPTH: usize = 4;

/// Every descendant of `pid`, deepest last, NOT including `pid` itself.
///
/// This must be called while `pid` is still ALIVE. Once the parent dies the
/// kernel reparents its children to pid 1, so `pgrep -P <pid>` returns nothing
/// and the tree is unreachable through it.
///
/// It also makes the name honest: the previous version read one level of
/// `pgrep -P` while the docs claimed it killed "the tree".
#[cfg(unix)]
pub fn descendant_pids(pid: i32) -> Vec<i32> {
    let mut found: Vec<i32> = Vec::new();
    let mut frontier = vec![pid];
    for _ in 0..MAX_TREE_DEPTH {
        let mut next = Vec::new();
        for parent in frontier.drain(..) {
            for child in child_pids(parent) {
                if child == pid || found.contains(&child) {
                    continue;
                }
                found.push(child);
                next.push(child);
            }
        }
        if next.is_empty() {
            break;
        }
        frontier = next;
    }
    found
}

#[cfg(not(unix))]
pub fn descendant_pids(_pid: i32) -> Vec<i32> {
    Vec::new()
}

/// SIGKILL `pid` and everything under it.
///
/// The descendants matter: the Bun-compiled sidecar runs its read-projection
/// and background workers as separate processes, and killing only the parent
/// leaves those holding file locks in `~/.ashlr`.
///
/// Children are enumerated FIRST and killed before the parent, so the walk
/// happens while the parent is still alive. Callers must not pre-kill the
/// parent — see [`terminate_tree`] for the exit paths, which need a graceful
/// stage anyway.
pub fn kill_tree(pid: i32) {
    if pid <= 1 {
        return;
    }
    #[cfg(unix)]
    {
        kill_pids(&descendant_pids(pid), libc::SIGKILL);
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
    }
}

#[cfg(unix)]
fn kill_pids(pids: &[i32], signal: libc::c_int) {
    for pid in pids {
        if *pid > 1 {
            unsafe {
                libc::kill(*pid, signal);
            }
        }
    }
}

#[cfg(unix)]
const TERMINATE_GRACE: Duration = Duration::from_secs(8);
#[cfg(unix)]
const WORKER_GRACE: Duration = Duration::from_secs(2);
#[cfg(unix)]
const TERMINATE_POLL: Duration = Duration::from_millis(50);

/// Stop `pid` and its descendants, giving them a chance to shut down cleanly.
///
/// Only signal the owner first. Interrupting metadata workers directly can
/// preempt their teardown/registration and leave quota ownership uncertain.
pub fn terminate_tree(pid: i32) {
    if pid <= 1 {
        return;
    }
    #[cfg(unix)]
    {
        use crate::sidecar_supervisor::read_process_table;

        let table = read_process_table();
        let mut descendants = Vec::new();
        let mut frontier = vec![pid];
        for _ in 0..MAX_TREE_DEPTH {
            let next: Vec<_> = table
                .iter()
                .filter(|row| row.pid > 1 && row.pid != pid && frontier.contains(&row.ppid))
                .collect();
            if next.is_empty() {
                break;
            }
            frontier = next.iter().map(|row| row.pid).collect();
            descendants.extend(next);
        }
        kill_pids(&[pid], libc::SIGTERM);
        let deadline = Instant::now() + TERMINATE_GRACE;
        while process_is_alive(pid) && Instant::now() < deadline {
            std::thread::sleep(TERMINATE_POLL);
        }

        // A worker may now be reparented. Verify its start time and argv,
        // rather than trusting a pid that could have been recycled.
        let remaining = || {
            read_process_table()
                .into_iter()
                .filter(|now| {
                    descendants.iter().any(|old| {
                        now.pid == old.pid && now.started == old.started && now.args == old.args
                    })
                })
                .map(|row| row.pid)
                .collect::<Vec<_>>()
        };
        let alive = remaining();
        if !alive.is_empty() {
            kill_pids(&alive, libc::SIGTERM);
            let deadline = Instant::now() + WORKER_GRACE;
            while alive.iter().any(|pid| process_is_alive(*pid)) && Instant::now() < deadline {
                std::thread::sleep(TERMINATE_POLL);
            }
            kill_pids(&remaining(), libc::SIGKILL);
        }
        if let Some(owner) = table.iter().find(|row| row.pid == pid) {
            if crate::sidecar_supervisor::still_same_process(owner) {
                kill_pids(&[pid], libc::SIGKILL);
            }
        }
    }
}

// ── crash repair ─────────────────────────────────────────────────────────────

/// Outcome of a reclaim attempt, so the caller can log honestly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reclaim {
    /// No record on disk, or it did not name this port.
    NothingRecorded,
    /// A record exists but another live app owns that sidecar.
    OwnedByLiveApp,
    /// The record is stale (its sidecar is gone); it was deleted.
    StaleRecordCleared,
    /// An orphaned sidecar was found and killed.
    Killed(i32),
}

/// Kill a sidecar left behind by a previous crash of this app, if there is one.
///
/// Called before the port probe on every launch. See the module docs for why
/// this cannot kill a stranger's process.
pub fn reclaim_orphan(port: u16) -> Reclaim {
    let Some(record) = load() else {
        return Reclaim::NothingRecorded;
    };
    if record.port != port {
        return Reclaim::NothingRecorded;
    }

    let desktop_alive = process_is_alive(record.desktop_pid);
    let sidecar_alive = process_is_alive(record.sidecar_pid);
    let path_matches = sidecar_alive && argv_starts_with(record.sidecar_pid, &record.sidecar_path);

    let facts = LivenessFacts {
        desktop_alive,
        sidecar_alive,
        path_matches,
    };

    if should_reclaim(&record, port, facts) {
        kill_tree(record.sidecar_pid);
        clear();
        return Reclaim::Killed(record.sidecar_pid);
    }
    if desktop_alive {
        return Reclaim::OwnedByLiveApp;
    }
    // The owner is gone and the pid is not our sidecar any more (exited, or
    // recycled into something else). The record is worthless; drop it.
    clear();
    Reclaim::StaleRecordCleared
}

// ── signals ──────────────────────────────────────────────────────────────────

#[cfg(unix)]
extern "C" fn terminate_handler(signum: libc::c_int) {
    let fd = SIGNAL_FD.swap(-1, Ordering::SeqCst);
    if fd >= 0 {
        let byte = signum as u8;
        unsafe {
            libc::write(fd, std::ptr::from_ref(&byte).cast(), 1);
        }
    }
}

/// Forward the first signal to the normal exit path, outside signal context.
#[cfg(unix)]
pub fn install_signal_handlers(request_exit: impl FnOnce(i32) + Send + 'static) -> std::io::Result<()> {
    let (mut reader, writer) = UnixStream::pair()?;
    let fd = writer.as_raw_fd();
    std::thread::Builder::new()
        .name("desktop-signal".into())
        .spawn(move || {
            let _writer = writer;
            let mut signal = [0];
            if reader.read_exact(&mut signal).is_ok() {
                request_exit(128 + i32::from(signal[0]));
            }
        })?;
    SIGNAL_FD.store(fd, Ordering::SeqCst);
    unsafe {
        for signum in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::signal(signum, terminate_handler as *const () as libc::sighandler_t);
        }
    }
    Ok(())
}

#[cfg(not(unix))]
pub fn install_signal_handlers(_request_exit: impl FnOnce(i32) + Send + 'static) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> SidecarRecord {
        SidecarRecord {
            desktop_pid: 4242,
            sidecar_pid: 4243,
            port: 7777,
            sidecar_path: "/Applications/Ashlr.app/Contents/MacOS/ashlr".to_string(),
        }
    }

    const ORPHANED: LivenessFacts = LivenessFacts {
        desktop_alive: false,
        sidecar_alive: true,
        path_matches: true,
    };

    #[test]
    fn an_orphan_of_ours_is_reclaimed() {
        assert!(should_reclaim(&sample(), 7777, ORPHANED));
    }

    #[test]
    fn a_sidecar_owned_by_a_live_app_is_never_touched() {
        // A second copy of the app is running. Killing its sidecar would take
        // down a working window.
        let facts = LivenessFacts {
            desktop_alive: true,
            ..ORPHANED
        };
        assert!(!should_reclaim(&sample(), 7777, facts));
    }

    #[test]
    fn a_recycled_pid_is_never_killed() {
        // The owner is gone and the pid is alive, but it now belongs to some
        // other program — argv does not match our sidecar path.
        let facts = LivenessFacts {
            path_matches: false,
            ..ORPHANED
        };
        assert!(
            !should_reclaim(&sample(), 7777, facts),
            "pid recycling must not be able to make us kill a stranger"
        );
    }

    #[test]
    fn a_dead_sidecar_is_not_killed_again() {
        let facts = LivenessFacts {
            sidecar_alive: false,
            path_matches: false,
            ..ORPHANED
        };
        assert!(!should_reclaim(&sample(), 7777, facts));
    }

    #[test]
    fn a_record_for_another_port_is_ignored() {
        assert!(!should_reclaim(&sample(), 7788, ORPHANED));
    }

    #[test]
    fn pid_1_and_below_are_never_candidates() {
        for pid in [-1, 0, 1] {
            let record = SidecarRecord {
                sidecar_pid: pid,
                ..sample()
            };
            assert!(!should_reclaim(&record, 7777, ORPHANED), "sidecar pid {pid}");
            let record = SidecarRecord {
                desktop_pid: pid,
                ..sample()
            };
            assert!(!should_reclaim(&record, 7777, ORPHANED), "desktop pid {pid}");
        }
    }

    #[test]
    fn the_record_round_trips_and_carries_no_secrets() {
        let json = serde_json::to_string(&sample()).expect("encode");
        // Two pids, a port and a path — and nothing else. A token could not be
        // in here even if the spawn path regressed.
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&json)
                .expect("value")
                .as_object()
                .expect("object")
                .len(),
            4
        );
        assert!(!json.contains("oken"), "record shape gained a token field");
        assert_eq!(
            serde_json::from_str::<SidecarRecord>(&json).expect("decode"),
            sample()
        );
    }

    #[test]
    fn a_corrupt_record_is_not_a_crash() {
        assert!(serde_json::from_str::<SidecarRecord>("not json").is_err());
        assert!(serde_json::from_str::<SidecarRecord>("{}").is_err());
    }

    #[test]
    fn the_record_lives_beside_the_first_run_marker() {
        let path = record_path();
        assert!(path.ends_with(".ashlr/.desktop-sidecar.json"), "{path:?}");
    }

    #[cfg(unix)]
    #[test]
    fn liveness_agrees_with_the_process_we_are_running_in() {
        assert!(process_is_alive(std::process::id() as i32));
        assert!(!process_is_alive(0));
        assert!(!process_is_alive(1), "pid 1 is excluded by policy, not by liveness");
    }

    #[cfg(unix)]
    #[test]
    fn a_process_that_does_not_exist_is_not_a_zombie() {
        // Unknown state must read as "not a zombie", so liveness never turns a
        // missing process into a kill decision on its own.
        assert!(!process_is_zombie(0));
    }

    #[cfg(unix)]
    #[test]
    fn argv_matching_is_a_path_prefix_not_a_substring() {
        let me = std::process::id() as i32;
        // Our own argv[0] is the test binary; a prefix of it must not match,
        // or a shorter sibling path could impersonate the sidecar.
        assert!(!argv_starts_with(me, "/bin"));
        assert!(!argv_starts_with(me, ""));
        // A pid that cannot be read never matches.
        assert!(!argv_starts_with(0, "/bin/sh"));
    }

    #[test]
    fn the_binary_path_is_recovered_even_when_it_contains_spaces() {
        let args = ["verse", "--port", "7777", "--no-open", "--json"];
        assert_eq!(
            binary_path_from_argv(
                "/Applications/Ashlr Verse.app/Contents/MacOS/ashlr verse --port 7777 --no-open --json",
                &args
            )
            .as_deref(),
            Some("/Applications/Ashlr Verse.app/Contents/MacOS/ashlr")
        );
    }

    #[test]
    fn an_argv_that_is_not_the_command_we_spawned_yields_nothing() {
        let args = ["verse", "--port", "7777", "--no-open", "--json"];
        // A different command means we are not looking at our sidecar, so
        // recording a path from it would be a lie.
        assert_eq!(binary_path_from_argv("/bin/sh -c something", &args), None);
        assert_eq!(binary_path_from_argv("", &args), None);
        // Nothing but the arguments: there is no path left to record.
        assert_eq!(
            binary_path_from_argv("verse --port 7777 --no-open --json", &args),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn killing_pid_one_or_less_is_a_no_op() {
        // Guards the caller: a zeroed/absent record must never turn into
        // `kill(0, SIGKILL)`, which signals our entire process group.
        kill_tree(0);
        kill_tree(-1);
        kill_tree(1);
        terminate_tree(0);
        terminate_tree(-1);
        terminate_tree(1);
    }

    #[cfg(unix)]
    #[test]
    fn terminate_tree_leaves_native_workers_to_their_owner_during_grace() {
        let mut parent = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                "trap 'sleep 0.2; kill -0 \"$child\" 2>/dev/null && echo settled; kill \"$child\" 2>/dev/null; wait \"$child\"; exit 0' TERM; sleep 30 & child=$!; echo ready; wait",
            ])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("spawn collector fixture");
        use std::io::BufRead;
        let mut output = std::io::BufReader::new(parent.stdout.take().unwrap());
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "ready");
        terminate_tree(parent.id() as i32);
        let _ = parent.wait();
        line.clear();
        output.read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "settled");
    }

    #[cfg(unix)]
    #[test]
    fn terminate_tree_reaps_the_workers_the_parent_spawned() {
        // The regression this pins: `reap_sidecar` used to SIGKILL the parent
        // and only THEN ask `pgrep -P <pid>` for its children, by which point
        // the kernel had reparented them to pid 1 and the answer was empty. The
        // sidecar's workers survived every ordinary quit.
        //
        // `sh -c 'sleep 30 & sleep 30'` is the same shape: a parent holding one
        // backgrounded child while it runs another in the foreground.
        let mut parent = std::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30 & sleep 30"])
            .spawn()
            .expect("spawn test tree");
        let pid = parent.id() as i32;

        // Give `sh` a moment to fork before the tree is enumerated.
        let mut children = Vec::new();
        for _ in 0..40 {
            children = descendant_pids(pid);
            if !children.is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        assert!(
            !children.is_empty(),
            "the walk must see the children WHILE the parent is alive",
        );

        terminate_tree(pid);
        let _ = parent.wait();

        for child in children {
            assert!(
                !process_is_alive(child),
                "descendant {child} survived terminate_tree",
            );
        }
    }
}
