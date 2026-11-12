//! Keep ownership of asynchronous children until they have been waited for.
use std::{
    ops::{Deref, DerefMut},
    process::Child,
    sync::{Arc, Mutex},
    thread,
};

pub struct ReapOnDrop(Option<Child>);

impl ReapOnDrop {
    pub fn new(child: Child) -> Self {
        Self(Some(child))
    }
}

impl Deref for ReapOnDrop {
    type Target = Child;
    fn deref(&self) -> &Child {
        self.0.as_ref().expect("child already taken")
    }
}
impl DerefMut for ReapOnDrop {
    fn deref_mut(&mut self) -> &mut Child {
        self.0.as_mut().expect("child already taken")
    }
}
impl Drop for ReapOnDrop {
    fn drop(&mut self) {
        let child = Arc::new(Mutex::new(self.0.take()));
        let worker = Arc::clone(&child);
        if thread::Builder::new()
            .name("ashlr-child-reaper".into())
            .spawn(move || {
                if let Some(mut child) = worker.lock().unwrap_or_else(|e| e.into_inner()).take() {
                    let _ = child.wait();
                }
            })
            .is_err()
        {
            // Preserve ownership even if the OS refuses another thread.
            if let Some(mut child) = child.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = child.wait();
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        process::Command,
        time::{Duration, Instant},
    };

    extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }

    #[test]
    fn repeated_detached_children_are_reaped() {
        let mut ids = Vec::new();
        for _ in 0..64 {
            let child = Command::new("/usr/bin/true").spawn().unwrap();
            ids.push(child.id() as i32);
            drop(ReapOnDrop::new(child));
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            // kill(pid, 0) also sees zombies, so ESRCH proves the child was reaped.
            ids.retain(|&pid| {
                if unsafe { kill(pid, 0) } == 0 {
                    true
                } else {
                    assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(3));
                    false
                }
            });
            if ids.is_empty() {
                break;
            }
            assert!(Instant::now() < deadline, "children still present: {ids:?}");
            thread::sleep(Duration::from_millis(10));
        }
    }
}
